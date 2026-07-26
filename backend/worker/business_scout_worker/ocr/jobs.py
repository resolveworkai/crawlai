"""Authored by: Mohit Singh

DB queries for the Crawl-OCR job lifecycle — mirrors business_scout_worker/jobs.py's shape.
Atomic claim via FOR UPDATE SKIP LOCKED; progress/status writes as the job moves
capturing -> ocr -> parsing -> ready (or failed/blocked). The Node API only reads these rows.
"""

from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from business_scout_worker.models import LogLevel
from business_scout_worker.ocr.models import OcrEndReason, OcrJob, OcrJobStatus, ParsedBusiness


async def claim_pending_ocr_job(pool: AsyncConnectionPool) -> OcrJob | None:
    async with pool.connection() as conn:
        cur = await conn.execute(
            """
            UPDATE ocr_jobs SET status = 'capturing', started_at = now()
            WHERE id = (
                SELECT id FROM ocr_jobs
                WHERE status = 'queued'
                ORDER BY created_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING *
            """
        )
        row = await cur.fetchone()
    return OcrJob.model_validate(row) if row is not None else None


async def write_log(pool: AsyncConnectionPool, job_id: UUID, level: LogLevel, message: str) -> None:
    """Mirrors business_scout_worker/jobs.py's write_log for the main crawler — a SEPARATE table
    (ocr_logs, its own FK to ocr_jobs) so the two job types' log streams never collide, merged
    together only at read time by the Node API's global /logs/stream SSE (routes/jobs.ts)."""
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO ocr_logs (job_id, level, message) VALUES (%s, %s, %s)",
            (str(job_id), level, message),
        )


async def set_ocr_status(pool: AsyncConnectionPool, job_id: UUID, status: OcrJobStatus) -> None:
    async with pool.connection() as conn:
        await conn.execute("UPDATE ocr_jobs SET status = %s WHERE id = %s", (status, str(job_id)))


async def set_ocr_storage_dir(pool: AsyncConnectionPool, job_id: UUID, storage_dir: str) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE ocr_jobs SET storage_dir = %s WHERE id = %s", (storage_dir, str(job_id))
        )


async def set_ocr_counts(
    pool: AsyncConnectionPool,
    job_id: UUID,
    *,
    total: int | None = None,
    captured: int | None = None,
    ocr_done: int | None = None,
    current_business: str | None = None,
) -> None:
    """Absolute sets (not increments) — Stage A knows the running captured count, Stage B knows
    the running ocr_done count, both against the same total. COALESCE keeps the untouched
    columns as-is so either stage can update just its own counter."""
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE ocr_jobs SET
                total_count = COALESCE(%s, total_count),
                captured_count = COALESCE(%s, captured_count),
                ocr_done_count = COALESCE(%s, ocr_done_count),
                current_business = COALESCE(%s, current_business)
            WHERE id = %s
            """,
            (total, captured, ocr_done, current_business, str(job_id)),
        )


async def finish_ocr_job(
    pool: AsyncConnectionPool,
    job_id: UUID,
    status: OcrJobStatus,
    *,
    end_reason: OcrEndReason | None = None,
    error_message: str | None = None,
) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE ocr_jobs
            SET status = %s, end_reason = %s, error_message = %s, finished_at = now()
            WHERE id = %s
            """,
            (status, end_reason, error_message, str(job_id)),
        )


async def insert_ocr_business(pool: AsyncConnectionPool, job_id: UUID, biz: ParsedBusiness) -> None:
    """Idempotent on (job_id, idx) — a re-processed job overwrites rather than duplicating."""
    async with pool.connection() as conn:
        await conn.execute(
            """
            INSERT INTO ocr_businesses (
                job_id, idx, name, maps_url, rating, review_count, category, address, phone,
                website, plus_code, hours_summary, hours_weekly, email, image_url, lat, lng,
                distance_km, ocr_confidence, needs_review, raw_text, source_images
            ) VALUES (
                %(job_id)s, %(idx)s, %(name)s, %(maps_url)s, %(rating)s, %(review_count)s,
                %(category)s, %(address)s, %(phone)s, %(website)s, %(plus_code)s,
                %(hours_summary)s, %(hours_weekly)s, %(email)s, %(image_url)s, %(lat)s, %(lng)s,
                %(distance_km)s, %(ocr_confidence)s, %(needs_review)s, %(raw_text)s,
                %(source_images)s
            )
            ON CONFLICT (job_id, idx) DO UPDATE SET
                name = EXCLUDED.name, maps_url = EXCLUDED.maps_url, rating = EXCLUDED.rating,
                review_count = EXCLUDED.review_count, category = EXCLUDED.category,
                address = EXCLUDED.address, phone = EXCLUDED.phone, website = EXCLUDED.website,
                plus_code = EXCLUDED.plus_code, hours_summary = EXCLUDED.hours_summary,
                hours_weekly = EXCLUDED.hours_weekly, email = EXCLUDED.email,
                image_url = EXCLUDED.image_url, lat = EXCLUDED.lat, lng = EXCLUDED.lng,
                distance_km = EXCLUDED.distance_km,
                ocr_confidence = EXCLUDED.ocr_confidence, needs_review = EXCLUDED.needs_review,
                raw_text = EXCLUDED.raw_text, source_images = EXCLUDED.source_images
            """,
            {
                "job_id": str(job_id),
                "idx": biz.idx,
                "name": biz.name,
                "maps_url": biz.maps_url,
                "rating": biz.rating,
                "review_count": biz.review_count,
                "category": biz.category,
                "address": biz.address,
                "phone": biz.phone,
                "website": biz.website,
                "plus_code": biz.plus_code,
                "hours_summary": biz.hours_summary,
                "hours_weekly": Jsonb(biz.hours_weekly) if biz.hours_weekly else None,
                "email": biz.email,
                "image_url": biz.image_url,
                "lat": biz.lat,
                "lng": biz.lng,
                "distance_km": biz.distance_km,
                "ocr_confidence": biz.ocr_confidence,
                "needs_review": biz.needs_review,
                "raw_text": biz.raw_text,
                "source_images": Jsonb(biz.source_images),
            },
        )


async def get_ocr_done_indices(pool: AsyncConnectionPool, job_id: UUID) -> set[int]:
    """Which `idx` values already have an ocr_businesses row for this job — from a PRIOR attempt
    on a resumed retry. Stage B skips these entirely rather than re-OCRing already-good results
    (insert_ocr_business's ON CONFLICT would make re-running them safe, just wasteful)."""
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT idx FROM ocr_businesses WHERE job_id = %s", (str(job_id),))
        rows = cast("list[dict[str, Any]]", await cur.fetchall())
    return {row["idx"] for row in rows}


async def list_ocr_business_rows(
    pool: AsyncConnectionPool, job_id: UUID
) -> list[dict[str, object]]:
    """Every business row for this job, in capture order — used to (re)write results.json from
    the DB (the actual source of truth) rather than only what THIS run's Stage B pass processed,
    which on a resumed retry would be missing the earlier attempt's already-done rows."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT * FROM ocr_businesses WHERE job_id = %s ORDER BY idx", (str(job_id),)
        )
        rows = cast("list[dict[str, Any]]", await cur.fetchall())
    return [dict(row) for row in rows]


async def get_ocr_job(pool: AsyncConnectionPool, job_id: UUID) -> OcrJob | None:
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT * FROM ocr_jobs WHERE id = %s", (str(job_id),))
        row = await cur.fetchone()
    return OcrJob.model_validate(row) if row is not None else None


async def recover_orphaned_ocr_jobs(pool: AsyncConnectionPool) -> int:
    """Startup self-heal. A container restart (or crash) mid-run hard-kills the browser/OCR and
    leaves a job stuck in a non-terminal running state (capturing/ocr/parsing) that the claim
    query — which only takes 'queued' — will never pick up again. On daemon start we mark any
    such orphan 'failed' with a clear message so it shows a clean terminal state the user can
    relaunch from, rather than a permanently-spinning job. Returns the number recovered."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            """
            UPDATE ocr_jobs
            SET status = 'failed', end_reason = 'error', finished_at = now(),
                error_message = 'Interrupted by a server restart — relaunch the job.'
            WHERE status IN ('capturing', 'ocr', 'parsing')
            RETURNING id
            """
        )
        rows = await cur.fetchall()
    return len(rows)
