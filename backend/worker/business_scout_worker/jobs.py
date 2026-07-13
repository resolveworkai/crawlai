"""Authored by: Mohit Singh

Job-lifecycle queries for the P1 daemon loop (main.py) and pipeline.py. Atomic claim uses
`FOR UPDATE SKIP LOCKED` so multiple worker processes could run concurrently without double-
claiming a job (not exercised today — one daemon process — but free correctness, and it's the
standard Postgres job-queue pattern named in the plan).
"""

from __future__ import annotations

from uuid import UUID

from psycopg_pool import AsyncConnectionPool

from business_scout_worker.models import CrawlJob, JobStatus, LogLevel


async def claim_pending_job(pool: AsyncConnectionPool) -> CrawlJob | None:
    """Startup + periodic sweep — catches jobs created while the worker was down or a NOTIFY
    was missed (NOTIFY is not persisted; see md/plans/0001-*.md "P1 Daemon")."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            """
            UPDATE crawl_jobs SET status = 'discovering', started_at = now()
            WHERE id = (
                SELECT id FROM crawl_jobs
                WHERE status = 'pending'
                ORDER BY created_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING *
            """
        )
        row = await cur.fetchone()
    return CrawlJob.model_validate(row) if row is not None else None


async def claim_job_by_id(pool: AsyncConnectionPool, job_id: UUID) -> CrawlJob | None:
    """The NOTIFY-driven path — claims a specific job if (and only if) it's still pending by
    the time this fires (it may have already been claimed by the periodic sweep)."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            """
            UPDATE crawl_jobs SET status = 'discovering', started_at = now()
            WHERE id = %s AND status = 'pending'
            RETURNING *
            """,
            (str(job_id),),
        )
        row = await cur.fetchone()
    return CrawlJob.model_validate(row) if row is not None else None


async def refresh_job(pool: AsyncConnectionPool, job_id: UUID) -> CrawlJob | None:
    """Re-reads the job row — used between businesses to check cancel_requested/
    pause_requested, which the API can set at any time (see routes/jobs.ts)."""
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT * FROM crawl_jobs WHERE id = %s", (str(job_id),))
        row = await cur.fetchone()
    return CrawlJob.model_validate(row) if row is not None else None


async def set_job_status(pool: AsyncConnectionPool, job_id: UUID, status: JobStatus) -> None:
    async with pool.connection() as conn:
        await conn.execute("UPDATE crawl_jobs SET status = %s WHERE id = %s", (status, str(job_id)))


async def release_job(pool: AsyncConnectionPool, job_id: UUID) -> None:
    """Worker shutdown mid-job: releases the claim back to 'pending' (not 'cancelled' — the
    user never asked for that, the process is just restarting) so the periodic sweep or the
    next daemon start picks it up again. Businesses already upserted this run are untouched
    (idempotent re-crawl skips freshly-enriched ones on retry) — see md/plans/0001-*.md's
    "graceful worker shutdown (finish current business, mark job, release claim)"."""
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE crawl_jobs SET status = 'pending', current_business = NULL WHERE id = %s",
            (str(job_id),),
        )


async def finish_job(
    pool: AsyncConnectionPool,
    job_id: UUID,
    status: JobStatus,
    *,
    error_message: str | None = None,
) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE crawl_jobs
            SET status = %s, finished_at = now(), error_message = %s, current_business = NULL
            WHERE id = %s
            """,
            (status, error_message, str(job_id)),
        )


async def set_current_business(pool: AsyncConnectionPool, job_id: UUID, name: str | None) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE crawl_jobs SET current_business = %s WHERE id = %s", (name, str(job_id))
        )


async def increment_counters(
    pool: AsyncConnectionPool,
    job_id: UUID,
    *,
    found: int = 0,
    crawled: int = 0,
    website_crawled: int = 0,
    failed: int = 0,
) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE crawl_jobs
            SET found_count = found_count + %s,
                crawled_count = crawled_count + %s,
                website_crawled_count = website_crawled_count + %s,
                failed_count = failed_count + %s
            WHERE id = %s
            """,
            (found, crawled, website_crawled, failed, str(job_id)),
        )


async def write_log(pool: AsyncConnectionPool, job_id: UUID, level: LogLevel, message: str) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO crawl_logs (job_id, level, message) VALUES (%s, %s, %s)",
            (str(job_id), level, message),
        )
