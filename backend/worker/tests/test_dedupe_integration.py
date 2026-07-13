"""Authored by: Mohit Singh

Real-Postgres tests for dedupe.py's upsert/enrichment/email-conflict logic — see
test_integration.py for the shared `pool` fixture (conftest.py). Run with: pytest -m integration
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from typing import Any, cast

import pytest
import pytest_asyncio
from psycopg_pool import AsyncConnectionPool

from business_scout_worker.db import connection
from business_scout_worker.dedupe import (
    apply_enrichment,
    needs_enrichment,
    upsert_discovered,
)
from business_scout_worker.discovery.models import DiscoveredBusiness
from business_scout_worker.enrich.models import Tier1Result

pytestmark = pytest.mark.integration

RUN_ID = uuid.uuid4().hex[:8]


@pytest_asyncio.fixture
async def job_id(pool: AsyncConnectionPool) -> AsyncGenerator[uuid.UUID, None]:
    """`businesses.crawl_job_id` FKs to a real `crawl_jobs` row — a bare uuid4() violates the
    constraint. Creates a throwaway user+job for the test, cleans both up after (cascades to
    any crawl_logs, and SETs businesses.crawl_job_id NULL rather than deleting them)."""
    email = f"py-dedupe-{uuid.uuid4().hex[:8]}@example.com"
    async with connection(pool) as conn:
        cur = await conn.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, 'h') RETURNING id", (email,)
        )
        user_row = cast("dict[str, Any] | None", await cur.fetchone())
        assert user_row is not None
        user_id = user_row["id"]

        cur = await conn.execute(
            """INSERT INTO crawl_jobs
                   (created_by, business_type, center_lat, center_lng, radius_km)
               VALUES (%s, 'gym', 52.5, 13.4, 5) RETURNING id""",
            (user_id,),
        )
        job_row = cast("dict[str, Any] | None", await cur.fetchone())
        assert job_row is not None

    yield uuid.UUID(str(job_row["id"]))

    async with connection(pool) as conn:
        await conn.execute("DELETE FROM users WHERE id = %s", (user_id,))  # cascades the job


async def _cleanup(pool: AsyncConnectionPool, osm_ids: list[str]) -> None:
    async with connection(pool) as conn:
        await conn.execute("DELETE FROM businesses WHERE osm_id = ANY(%s)", (osm_ids,))


async def test_upsert_discovered_inserts_a_new_row(
    pool: AsyncConnectionPool, job_id: uuid.UUID
) -> None:
    osm_id = f"{RUN_ID}-ins"
    discovered = DiscoveredBusiness(
        osm_type="node",
        osm_id=osm_id,
        name="Test Gym A",
        category="Fitness Centre",
        latitude=52.5,
        longitude=13.4,
        city="Berlin",
    )

    business_id = await upsert_discovered(pool, job_id, discovered)

    async with connection(pool) as conn:
        cur = await conn.execute(
            "SELECT name, city, enrichment_status FROM businesses WHERE id = %s",
            (str(business_id),),
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())
    assert row is not None
    assert row["name"] == "Test Gym A"
    assert row["city"] == "Berlin"
    assert row["enrichment_status"] == "queued"

    await _cleanup(pool, [osm_id])


async def test_upsert_discovered_is_idempotent_on_same_osm_id(
    pool: AsyncConnectionPool, job_id: uuid.UUID
) -> None:
    osm_id = f"{RUN_ID}-idem"
    first = DiscoveredBusiness(
        osm_type="node", osm_id=osm_id, name="Old Name", latitude=1, longitude=2
    )
    second = DiscoveredBusiness(
        osm_type="node", osm_id=osm_id, name="New Name", latitude=1, longitude=2
    )

    id1 = await upsert_discovered(pool, job_id, first)
    id2 = await upsert_discovered(pool, job_id, second)

    assert id1 == id2
    async with connection(pool) as conn:
        cur = await conn.execute(
            "SELECT count(*) AS n FROM businesses WHERE osm_id = %s", (osm_id,)
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())
    assert row is not None
    assert row["n"] == 1

    async with connection(pool) as conn:
        cur = await conn.execute("SELECT name FROM businesses WHERE id = %s", (str(id1),))
        row = cast("dict[str, Any] | None", await cur.fetchone())
    assert row is not None
    assert row["name"] == "New Name"  # refreshed on conflict

    await _cleanup(pool, [osm_id])


async def test_needs_enrichment_is_true_for_fresh_queued_row(
    pool: AsyncConnectionPool, job_id: uuid.UUID
) -> None:
    osm_id = f"{RUN_ID}-needs"
    business_id = await upsert_discovered(
        pool,
        job_id,
        DiscoveredBusiness(osm_type="node", osm_id=osm_id, name="X", latitude=1, longitude=1),
    )
    assert await needs_enrichment(pool, business_id) is True
    await _cleanup(pool, [osm_id])


async def test_needs_enrichment_is_false_once_freshly_enriched(
    pool: AsyncConnectionPool, job_id: uuid.UUID
) -> None:
    osm_id = f"{RUN_ID}-fresh"
    business_id = await upsert_discovered(
        pool,
        job_id,
        DiscoveredBusiness(osm_type="node", osm_id=osm_id, name="X", latitude=1, longitude=1),
    )
    await apply_enrichment(pool, business_id, "https://x.example", Tier1Result())
    assert await needs_enrichment(pool, business_id) is False
    await _cleanup(pool, [osm_id])


async def test_apply_enrichment_writes_contact_fields(
    pool: AsyncConnectionPool, job_id: uuid.UUID
) -> None:
    osm_id = f"{RUN_ID}-enrich"
    business_id = await upsert_discovered(
        pool,
        job_id,
        DiscoveredBusiness(osm_type="node", osm_id=osm_id, name="X", latitude=1, longitude=1),
    )
    result = Tier1Result(
        website_title="X Gym",
        emails=[f"contact-{RUN_ID}@x.example"],
        phones=["+491234567"],
        facebook="https://facebook.com/x",
        image_urls=["https://x.example/a.jpg", "https://x.example/b.jpg"],
    )
    await apply_enrichment(pool, business_id, "https://x.example", result)

    async with connection(pool) as conn:
        cur = await conn.execute(
            "SELECT email, phone, enrichment_status, facebook FROM businesses WHERE id = %s",
            (str(business_id),),
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())
        cur2 = await conn.execute(
            "SELECT count(*) AS n FROM business_images WHERE business_id = %s",
            (str(business_id),),
        )
        images_row = cast("dict[str, Any] | None", await cur2.fetchone())

    assert row is not None
    assert row["email"] == f"contact-{RUN_ID}@x.example"
    assert row["phone"] == "+491234567"
    assert row["enrichment_status"] == "enriched"
    assert row["facebook"] == "https://facebook.com/x"
    assert images_row is not None
    assert images_row["n"] == 2

    await _cleanup(pool, [osm_id])


async def test_apply_enrichment_tolerates_email_collision_with_another_business(
    pool: AsyncConnectionPool, job_id: uuid.UUID
) -> None:
    """Secondary dedupe: business B's enrichment discovers the same email business A already
    has (a classic OSM node-vs-way duplicate) — B's UPDATE must not violate the unique email
    index or crash the pipeline; it should silently keep A as the email's owner."""
    osm_id_a = f"{RUN_ID}-dupA"
    osm_id_b = f"{RUN_ID}-dupB"
    shared_email = f"dup-{RUN_ID}@shared.example"

    id_a = await upsert_discovered(
        pool,
        job_id,
        DiscoveredBusiness(osm_type="node", osm_id=osm_id_a, name="A", latitude=1, longitude=1),
    )
    await apply_enrichment(
        pool, id_a, "https://a.example", Tier1Result(emails=[shared_email], website_title="A")
    )

    id_b = await upsert_discovered(
        pool,
        job_id,
        DiscoveredBusiness(osm_type="way", osm_id=osm_id_b, name="B", latitude=1, longitude=1),
    )
    # Must not raise, even though `shared_email` is already claimed by id_a.
    await apply_enrichment(
        pool, id_b, "https://b.example", Tier1Result(emails=[shared_email], website_title="B")
    )

    async with connection(pool) as conn:
        cur = await conn.execute(
            "SELECT email, website_title FROM businesses WHERE id = %s", (str(id_a),)
        )
        row_a = cast("dict[str, Any] | None", await cur.fetchone())
        cur2 = await conn.execute(
            "SELECT email, website_title, enrichment_status FROM businesses WHERE id = %s",
            (str(id_b),),
        )
        row_b = cast("dict[str, Any] | None", await cur2.fetchone())

    assert row_a is not None
    assert row_a["email"] == shared_email
    assert row_b is not None
    assert row_b["email"] is None  # B never got to steal the email
    assert row_b["website_title"] == "B"  # but every other field still landed on B's own row
    assert row_b["enrichment_status"] == "enriched"

    await _cleanup(pool, [osm_id_a, osm_id_b])
