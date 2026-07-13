"""Authored by: Mohit Singh

Real-Postgres tests for jobs.py's claim/counter/log/status queries. Run with: pytest -m integration
"""

from __future__ import annotations

import uuid
from typing import Any, cast

import pytest
from psycopg_pool import AsyncConnectionPool

from business_scout_worker.db import connection
from business_scout_worker.jobs import (
    claim_job_by_id,
    claim_pending_job,
    finish_job,
    increment_counters,
    refresh_job,
    set_current_business,
    set_job_status,
    write_log,
)

pytestmark = pytest.mark.integration

RUN_ID = uuid.uuid4().hex[:8]


async def _make_user(pool: AsyncConnectionPool) -> str:
    email = f"py-jobs-{RUN_ID}-{uuid.uuid4().hex[:6]}@example.com"
    async with connection(pool) as conn:
        cur = await conn.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, 'h') RETURNING id", (email,)
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())
    assert row is not None
    return str(row["id"])


async def _make_pending_job(pool: AsyncConnectionPool, user_id: str) -> uuid.UUID:
    async with connection(pool) as conn:
        cur = await conn.execute(
            """INSERT INTO crawl_jobs
                   (created_by, business_type, center_lat, center_lng, radius_km, status)
               VALUES (%s, 'gym', 52.5, 13.4, 5, 'pending') RETURNING id""",
            (user_id,),
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())
    assert row is not None
    return uuid.UUID(str(row["id"]))


async def _cleanup(pool: AsyncConnectionPool, user_id: str) -> None:
    async with connection(pool) as conn:
        await conn.execute("DELETE FROM users WHERE id = %s", (user_id,))


async def test_claim_pending_job_claims_oldest_pending(pool: AsyncConnectionPool) -> None:
    # `claim_pending_job` picks the globally oldest pending row — guard against any stray
    # 'pending' rows left behind by unrelated manual/API testing against this shared DB, or
    # this assertion becomes flaky depending on what else happened to be sitting in the table.
    async with connection(pool) as conn:
        await conn.execute("UPDATE crawl_jobs SET status = 'cancelled' WHERE status = 'pending'")

    user_id = await _make_user(pool)
    job_id = await _make_pending_job(pool, user_id)

    claimed = await claim_pending_job(pool)
    assert claimed is not None
    assert claimed.id == job_id
    assert claimed.status == "discovering"
    assert claimed.started_at is not None

    # a second claim attempt must not re-claim the same (now non-pending) job
    second = await claim_pending_job(pool)
    assert second is None or second.id != job_id

    await _cleanup(pool, user_id)


async def test_claim_job_by_id_is_a_no_op_if_not_pending(pool: AsyncConnectionPool) -> None:
    user_id = await _make_user(pool)
    job_id = await _make_pending_job(pool, user_id)

    first = await claim_job_by_id(pool, job_id)
    assert first is not None
    assert first.status == "discovering"

    second = await claim_job_by_id(pool, job_id)  # already claimed — must not re-claim
    assert second is None

    await _cleanup(pool, user_id)


async def test_counters_status_and_logs_round_trip(pool: AsyncConnectionPool) -> None:
    user_id = await _make_user(pool)
    job_id = await _make_pending_job(pool, user_id)
    await claim_job_by_id(pool, job_id)

    await increment_counters(pool, job_id, found=5, crawled=2, website_crawled=1, failed=1)
    await set_current_business(pool, job_id, "Some Gym")
    await write_log(pool, job_id, "info", "test log entry")

    job = await refresh_job(pool, job_id)
    assert job is not None
    assert job.found_count == 5
    assert job.crawled_count == 2
    assert job.website_crawled_count == 1
    assert job.failed_count == 1
    assert job.current_business == "Some Gym"

    async with connection(pool) as conn:
        cur = await conn.execute("SELECT message FROM crawl_logs WHERE job_id = %s", (str(job_id),))
        row = cast("dict[str, Any] | None", await cur.fetchone())
    assert row is not None
    assert row["message"] == "test log entry"

    await set_job_status(pool, job_id, "paused")
    job = await refresh_job(pool, job_id)
    assert job is not None
    assert job.status == "paused"

    await finish_job(pool, job_id, "completed")
    job = await refresh_job(pool, job_id)
    assert job is not None
    assert job.status == "completed"
    assert job.finished_at is not None
    assert job.current_business is None

    await _cleanup(pool, user_id)
