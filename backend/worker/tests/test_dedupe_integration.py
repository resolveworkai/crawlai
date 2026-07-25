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
    merge_fuzzy_duplicate_if_found,
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


async def test_upsert_discovered_parses_and_normalizes_phone_and_hours(
    pool: AsyncConnectionPool, job_id: uuid.UUID
) -> None:
    osm_id = f"{RUN_ID}-hours"
    discovered = DiscoveredBusiness(
        osm_type="node",
        osm_id=osm_id,
        name="Test Library",
        latitude=52.5,
        longitude=13.4,
        country="DE",
        phone="030 1234567",  # national format — needs `country` as region to parse
        raw_opening_hours="Mo-Fr 08:00-18:00; Sa 09:00-14:00",
    )

    business_id = await upsert_discovered(pool, job_id, discovered)

    async with connection(pool) as conn:
        cur = await conn.execute(
            "SELECT phone, opening_hours FROM businesses WHERE id = %s", (str(business_id),)
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())
    assert row is not None
    assert row["phone"] == "+49301234567"
    assert row["opening_hours"]["monday"] == [{"open": "08:00", "close": "18:00"}]
    assert row["opening_hours"]["saturday"] == [{"open": "09:00", "close": "14:00"}]
    assert row["opening_hours"]["sunday"] == []

    await _cleanup(pool, [osm_id])


async def test_upsert_discovered_leaves_opening_hours_null_when_unparseable(
    pool: AsyncConnectionPool, job_id: uuid.UUID
) -> None:
    osm_id = f"{RUN_ID}-badhours"
    discovered = DiscoveredBusiness(
        osm_type="node",
        osm_id=osm_id,
        name="Test Cafe",
        latitude=52.5,
        longitude=13.4,
        raw_opening_hours="sunrise-sunset",
    )

    business_id = await upsert_discovered(pool, job_id, discovered)

    async with connection(pool) as conn:
        cur = await conn.execute(
            "SELECT opening_hours FROM businesses WHERE id = %s", (str(business_id),)
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())
    assert row is not None
    assert row["opening_hours"] is None

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
        phones=["+49 30 1234567"],  # a real, phonenumbers-valid German fixed-line number
        facebook="https://facebook.com/x",
        image_urls=["https://x.example/a.jpg", "https://x.example/b.jpg"],
    )
    await apply_enrichment(pool, business_id, "https://x.example", result)

    async with connection(pool) as conn:
        cur = await conn.execute(
            """SELECT email, phone, enrichment_status, facebook, enrichment_tier
               FROM businesses WHERE id = %s""",
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
    assert row["phone"] == "+49301234567"  # normalized to E.164 by parse.phone.normalize_phone
    assert row["enrichment_status"] == "enriched"
    assert row["facebook"] == "https://facebook.com/x"
    assert row["enrichment_tier"] == "tier1"  # result.used_tier2 defaulted False
    assert images_row is not None
    assert images_row["n"] == 2

    await _cleanup(pool, [osm_id])


async def test_apply_enrichment_tags_enrichment_tier_two_when_tier2_was_used(
    pool: AsyncConnectionPool, job_id: uuid.UUID
) -> None:
    osm_id = f"{RUN_ID}-enrich-tier2"
    business_id = await upsert_discovered(
        pool,
        job_id,
        DiscoveredBusiness(osm_type="node", osm_id=osm_id, name="Y", latitude=1, longitude=1),
    )
    result = Tier1Result(website_title="Y Gym", used_tier2=True)
    await apply_enrichment(pool, business_id, "https://y.example", result)

    async with connection(pool) as conn:
        cur = await conn.execute(
            "SELECT enrichment_tier FROM businesses WHERE id = %s", (str(business_id),)
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())

    assert row is not None
    assert row["enrichment_tier"] == "tier2"

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


async def test_merge_fuzzy_duplicate_merges_close_similar_named_nearby_businesses(
    pool: AsyncConnectionPool, job_id: uuid.UUID
) -> None:
    """The node-vs-way case: two separate OSM elements for the same real-world library, no
    shared email, but same name + practically the same coordinates — must merge."""
    osm_id_a = f"{RUN_ID}-fuzzA"
    osm_id_b = f"{RUN_ID}-fuzzB"

    id_a = await upsert_discovered(
        pool,
        job_id,
        DiscoveredBusiness(
            osm_type="node",
            osm_id=osm_id_a,
            name="Kurt-Tucholsky-Bibliothek",
            latitude=52.5200,
            longitude=13.4050,
        ),
    )
    await apply_enrichment(
        pool, id_a, "https://a.example", Tier1Result(emails=["a@a.example"], website_title="A site")
    )

    id_b = await upsert_discovered(
        pool,
        job_id,
        DiscoveredBusiness(
            osm_type="way",
            osm_id=osm_id_b,
            name="Kurt-Tucholsky-Bibliothek",  # identical name, same real building
            latitude=52.5201,  # ~11m away — well within FUZZY_MATCH_RADIUS_METERS
            longitude=13.4051,
        ),
    )
    survivor_id = await merge_fuzzy_duplicate_if_found(
        pool, id_b, "Kurt-Tucholsky-Bibliothek", 52.5201, 13.4051
    )

    assert survivor_id == id_a  # id_a is older -> canonical

    async with connection(pool) as conn:
        cur = await conn.execute(
            """SELECT email, website_title, enrichment_status, merged_into_id
               FROM businesses WHERE id = %s""",
            (str(id_a),),
        )
        row_a = cast("dict[str, Any] | None", await cur.fetchone())
        cur2 = await conn.execute(
            "SELECT merged_into_id FROM businesses WHERE id = %s", (str(id_b),)
        )
        row_b = cast("dict[str, Any] | None", await cur2.fetchone())

    assert row_a is not None
    assert row_a["merged_into_id"] is None  # canonical stays a live, standalone row
    assert row_a["email"] == "a@a.example"
    assert row_a["website_title"] == "A site"
    assert row_a["enrichment_status"] == "enriched"

    assert row_b is not None
    assert row_b["merged_into_id"] == id_a  # duplicate now points at the canonical

    await _cleanup(pool, [osm_id_a, osm_id_b])


async def test_merge_fuzzy_duplicate_leaves_distinct_businesses_alone(
    pool: AsyncConnectionPool, job_id: uuid.UUID
) -> None:
    """Two genuinely different businesses that happen to be near each other with dissimilar
    names must NOT be merged."""
    osm_id_a = f"{RUN_ID}-distinctA"
    osm_id_b = f"{RUN_ID}-distinctB"

    id_a = await upsert_discovered(
        pool,
        job_id,
        DiscoveredBusiness(
            osm_type="node", osm_id=osm_id_a, name="Central Gym", latitude=52.52, longitude=13.405
        ),
    )
    await upsert_discovered(
        pool,
        job_id,
        DiscoveredBusiness(
            osm_type="node",
            osm_id=osm_id_b,
            name="Riverside Library",
            latitude=52.5201,
            longitude=13.4051,
        ),
    )

    survivor_id = await merge_fuzzy_duplicate_if_found(pool, id_a, "Central Gym", 52.52, 13.405)

    assert survivor_id == id_a  # no match found -> unchanged

    async with connection(pool) as conn:
        cur = await conn.execute(
            "SELECT merged_into_id FROM businesses WHERE osm_id = ANY(%s)",
            ([osm_id_a, osm_id_b],),
        )
        rows = cast("list[dict[str, Any]]", await cur.fetchall())
    assert all(row["merged_into_id"] is None for row in rows)

    await _cleanup(pool, [osm_id_a, osm_id_b])


async def test_merge_fuzzy_duplicate_ignores_businesses_outside_radius(
    pool: AsyncConnectionPool, job_id: uuid.UUID
) -> None:
    """Same name, but far enough apart that they're clearly different branches, not a
    node-vs-way duplicate of the same location."""
    osm_id_a = f"{RUN_ID}-farA"
    osm_id_b = f"{RUN_ID}-farB"

    id_a = await upsert_discovered(
        pool,
        job_id,
        DiscoveredBusiness(
            osm_type="node", osm_id=osm_id_a, name="City Library", latitude=52.52, longitude=13.405
        ),
    )
    await upsert_discovered(
        pool,
        job_id,
        DiscoveredBusiness(
            osm_type="node",
            osm_id=osm_id_b,
            name="City Library",
            latitude=52.60,  # ~9km away — a different branch, not a geo duplicate
            longitude=13.405,
        ),
    )

    survivor_id = await merge_fuzzy_duplicate_if_found(pool, id_a, "City Library", 52.52, 13.405)
    assert survivor_id == id_a

    await _cleanup(pool, [osm_id_a, osm_id_b])
