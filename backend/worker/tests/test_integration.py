# Authored by: Mohit Singh
"""Real-Postgres integration tests — constraint enforcement + CRUD smoke, the Python half of
the pair with backend/api/src/db/__tests__/schema.integration.test.ts. Requires DATABASE_URL
to point at a live, migrated Postgres. Run with: pytest -m integration -v
"""

from __future__ import annotations

import uuid
from typing import Any, cast

import psycopg
import pytest
from psycopg_pool import AsyncConnectionPool

from business_scout_worker.db import connection
from business_scout_worker.queries import (
    count_businesses,
    find_business_by_id,
    find_user_by_email,
    get_crawl_settings,
)

pytestmark = pytest.mark.integration

RUN_ID = uuid.uuid4().hex[:8]

# `pool` fixture lives in conftest.py — shared across every `-m integration` test module.


async def test_get_crawl_settings_reads_the_singleton_row(pool: AsyncConnectionPool) -> None:
    settings = await get_crawl_settings(pool)
    assert settings.id == 1
    assert settings.concurrency > 0


async def test_find_user_by_email_round_trips_a_real_row(pool: AsyncConnectionPool) -> None:
    email = f"py-crud-{RUN_ID}@example.com"
    async with connection(pool) as conn:
        await conn.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s)", (email, "hash")
        )

    found = await find_user_by_email(pool, email)
    assert found is not None
    assert found.email == email

    async with connection(pool) as conn:
        await conn.execute("DELETE FROM users WHERE email = %s", (email,))


async def test_find_business_by_id_and_count(pool: AsyncConnectionPool) -> None:
    before = await count_businesses(pool)

    async with connection(pool) as conn:
        cur = await conn.execute(
            "INSERT INTO businesses (name, osm_type, osm_id) VALUES (%s, 'node', %s) RETURNING id",
            (f"Py CRUD Test {RUN_ID}", f"{RUN_ID}-py-osm"),
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())
        assert row is not None
        business_id = row["id"]

    after = await count_businesses(pool)
    assert after == before + 1

    found = await find_business_by_id(pool, business_id)
    assert found is not None
    assert found.osm_id == f"{RUN_ID}-py-osm"

    async with connection(pool) as conn:
        await conn.execute("DELETE FROM businesses WHERE id = %s", (business_id,))


async def test_rejects_invalid_job_status_enum_value(pool: AsyncConnectionPool) -> None:
    email = f"py-enum-{RUN_ID}@example.com"
    async with connection(pool) as conn:
        cur = await conn.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, %s) RETURNING id",
            (email, "hash"),
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())
        assert row is not None
        user_id = row["id"]

    with pytest.raises(psycopg.Error):
        async with connection(pool) as conn:
            await conn.execute(
                """INSERT INTO crawl_jobs
                       (created_by, business_type, center_lat, center_lng, radius_km, status)
                   VALUES (%s, 'gym', 0, 0, 5, 'not-a-real-status')""",
                (user_id,),
            )

    async with connection(pool) as conn:
        await conn.execute("DELETE FROM users WHERE id = %s", (user_id,))


async def test_rejects_duplicate_osm_dedupe_key(pool: AsyncConnectionPool) -> None:
    osm_id = f"{RUN_ID}-py-dup"
    async with connection(pool) as conn:
        await conn.execute(
            "INSERT INTO businesses (name, osm_type, osm_id) VALUES ('Dup A', 'node', %s)",
            (osm_id,),
        )

    with pytest.raises(psycopg.Error):
        async with connection(pool) as conn:
            await conn.execute(
                "INSERT INTO businesses (name, osm_type, osm_id) VALUES ('Dup B', 'node', %s)",
                (osm_id,),
            )

    async with connection(pool) as conn:
        await conn.execute("DELETE FROM businesses WHERE osm_id = %s", (osm_id,))
