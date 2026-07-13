"""Authored by: Mohit Singh

The Node<->Python seam, end to end against real Postgres: a job row is inserted exactly as
Node's createJob() would (see backend/api/src/services/jobsService.ts), the worker's real
claim + pipeline machinery processes it, and the resulting DB state (job status/counters,
businesses, crawl_logs) is asserted. Only the network-touching discovery/enrichment calls are
monkeypatched (deterministic, no live Overpass/website dependency) — everything else (claim,
dedupe/upsert, counters, logs, status transitions) is the real code path. The live-network half
of this (real Overpass + real sites) is test_live_smoke.py, gated separately.
"""

from __future__ import annotations

import uuid
from typing import Any, cast

import pytest
from psycopg_pool import AsyncConnectionPool

from business_scout_worker import pipeline
from business_scout_worker.db import connection
from business_scout_worker.discovery.models import DiscoveredBusiness
from business_scout_worker.enrich.models import Tier1Result
from business_scout_worker.jobs import claim_pending_job

pytestmark = pytest.mark.integration

RUN_ID = uuid.uuid4().hex[:8]


async def test_seam_job_insert_claim_process_and_final_state(
    pool: AsyncConnectionPool, monkeypatch: pytest.MonkeyPatch
) -> None:
    # 1. Insert a job exactly as Node's createJob() does (see jobsService.ts) — 'pending',
    #    real coordinates, no pre-existing counters.
    email = f"py-seam-{RUN_ID}@example.com"
    async with connection(pool) as conn:
        cur = await conn.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, 'h') RETURNING id", (email,)
        )
        user_row = cast("dict[str, Any] | None", await cur.fetchone())
        assert user_row is not None
        user_id = user_row["id"]

        cur = await conn.execute(
            """INSERT INTO crawl_jobs
                   (created_by, business_type, location_label, center_lat, center_lng, radius_km)
               VALUES (%s, 'gym', 'Berlin, DE', 52.52, 13.405, 5) RETURNING id""",
            (user_id,),
        )
        job_row = cast("dict[str, Any] | None", await cur.fetchone())
        assert job_row is not None
        job_id = uuid.UUID(str(job_row["id"]))

    osm_id_with_site = f"{RUN_ID}-seam-a"
    osm_id_no_site = f"{RUN_ID}-seam-b"

    async def fake_discover(*_args: object, **_kwargs: object) -> list[DiscoveredBusiness]:
        return [
            DiscoveredBusiness(
                osm_type="node",
                osm_id=osm_id_with_site,
                name="Seam Test Gym",
                category="Fitness Centre",
                latitude=52.52,
                longitude=13.405,
                city="Berlin",
                website_url="https://seam-test-gym.example",
            ),
            DiscoveredBusiness(
                osm_type="node",
                osm_id=osm_id_no_site,
                name="Seam Test Library",
                latitude=52.53,
                longitude=13.41,
                city="Berlin",
            ),
        ]

    async def fake_enrich_website(*_args: object, **_kwargs: object) -> Tier1Result:
        return Tier1Result(
            website_title="Seam Test Gym — Official Site",
            emails=[f"contact-{RUN_ID}@seam-test-gym.example"],
            phones=["+491234567"],
        )

    monkeypatch.setattr(pipeline, "discover", fake_discover)
    monkeypatch.setattr(pipeline, "enrich_website", fake_enrich_website)

    # 2. Real claim — exactly what the worker's main loop does on startup/NOTIFY.
    claimed = await claim_pending_job(pool)
    assert claimed is not None
    assert claimed.id == job_id
    assert claimed.status == "discovering"

    # 3. Real pipeline run (discovery/enrichment mocked; everything else real).
    await pipeline.run_job(pool, claimed)

    # 4. Assert final state landed correctly.
    async with connection(pool) as conn:
        cur = await conn.execute("SELECT * FROM crawl_jobs WHERE id = %s", (str(job_id),))
        final_job = cast("dict[str, Any] | None", await cur.fetchone())
    assert final_job is not None
    assert final_job["status"] == "completed"
    assert final_job["found_count"] == 2
    assert final_job["crawled_count"] == 2
    assert final_job["website_crawled_count"] == 1
    assert final_job["failed_count"] == 0
    assert final_job["finished_at"] is not None

    async with connection(pool) as conn:
        cur = await conn.execute("SELECT * FROM businesses WHERE osm_id = %s", (osm_id_with_site,))
        biz_a = cast("dict[str, Any] | None", await cur.fetchone())
        cur2 = await conn.execute("SELECT * FROM businesses WHERE osm_id = %s", (osm_id_no_site,))
        biz_b = cast("dict[str, Any] | None", await cur2.fetchone())
        cur3 = await conn.execute(
            "SELECT count(*) AS n FROM crawl_logs WHERE job_id = %s", (str(job_id),)
        )
        logs_row = cast("dict[str, Any] | None", await cur3.fetchone())

    assert biz_a is not None
    assert biz_a["name"] == "Seam Test Gym"
    assert biz_a["email"] == f"contact-{RUN_ID}@seam-test-gym.example"
    assert biz_a["enrichment_status"] == "enriched"
    assert biz_a["crawl_job_id"] == job_id

    assert biz_b is not None
    assert biz_b["name"] == "Seam Test Library"
    assert biz_b["website_url"] is None
    assert biz_b["enrichment_status"] == "enriched"  # OSM-only is still a valid, complete result

    assert logs_row is not None
    assert logs_row["n"] > 0  # discovery/completion logs were written

    # cleanup
    async with connection(pool) as conn:
        await conn.execute("DELETE FROM users WHERE id = %s", (user_id,))  # cascades job+logs
        await conn.execute(
            "DELETE FROM businesses WHERE osm_id = ANY(%s)", ([osm_id_with_site, osm_id_no_site],)
        )
