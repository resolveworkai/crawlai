"""Authored by: Mohit Singh

DB queries for the e-commerce Product Research job lifecycle — mirrors ocr/jobs.py's shape 1:1,
retargeted at ecom_jobs/ecom_products/ecom_logs (see
db/migrations/1785000000000_ecom-crawl.sql). Atomic claim via FOR UPDATE SKIP LOCKED; progress/
status writes as the job moves capturing -> ocr -> parsing -> [detail ->] ready (or failed/
blocked). The Node API only reads these rows.
"""

from __future__ import annotations

from collections.abc import Collection
from typing import Any, cast
from uuid import UUID

from psycopg.errors import UniqueViolation
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from business_scout_worker.ecom.models import EcomEndReason, EcomJob, EcomJobStatus, ParsedProduct
from business_scout_worker.models import LogLevel


async def claim_pending_ecom_job(
    pool: AsyncConnectionPool,
    *,
    only_platforms: Collection[str] | None = None,
    exclude_platforms: Collection[str] | None = None,
) -> EcomJob | None:
    """Atomically claims the oldest queued job. `only_platforms`/`exclude_platforms` partition
    the queue between the containerized daemon (excludes REQUIRES_CDP platforms it can't run) and
    the host runner (claims only those) — see ecom/adapters.cdp_required_platforms(). Passing a
    platform to both filters, or an empty `only_platforms`, would match nothing; callers pass at
    most one filter."""
    conditions = ["status = 'queued'"]
    params: list[Any] = []
    if only_platforms is not None:
        conditions.append("platform = ANY(%s)")
        params.append(list(only_platforms))
    if exclude_platforms:
        conditions.append("NOT (platform = ANY(%s))")
        params.append(list(exclude_platforms))
    where = " AND ".join(conditions)
    try:
        async with pool.connection() as conn:
            cur = await conn.execute(
                f"""
                UPDATE ecom_jobs SET status = 'capturing', started_at = now()
                WHERE id = (
                    SELECT id FROM ecom_jobs
                    WHERE {where}
                    ORDER BY created_at ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                )
                RETURNING *
                """,  # noqa: S608 - `where` is static fragments; values are parameterized
                params,
            )
            row = await cur.fetchone()
    except UniqueViolation:
        # ux_ecom_jobs_single_running is actually TWO independent locks, not one global lock (the
        # indexed expression `platform = ANY(['noon','aliexpress'])` only has two possible values,
        # true/false, so at most one row can be running with EACH value) — confirmed live
        # 2026-08-23: a real amazon job and a real noon job DO run status='capturing'
        # simultaneously without tripping this. What it actually caps is: at most one job across
        # {noon, aliexpress} (the CDP group, both claimed by the SAME host runner off the SAME
        # queue) running at a time, and SEPARATELY at most one job across every other platform
        # (today just amazon, claimed by the container daemon) running at a time. A second
        # concurrent claim attempt within the SAME group trips this — expected back-pressure, NOT
        # an error: the job stays queued and the loser retries later. (This used to crash the
        # container daemon mid-claim, whose respawn then clobbered the host runner's in-flight job
        # via orphan recovery.)
        return None
    return EcomJob.model_validate(row) if row is not None else None


async def write_log(pool: AsyncConnectionPool, job_id: UUID, level: LogLevel, message: str) -> None:
    """Mirrors ocr/jobs.py's write_log — a SEPARATE table (ecom_logs, its own FK to ecom_jobs) so
    the ecom/ocr/main-crawler log streams never collide."""
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO ecom_logs (job_id, level, message) VALUES (%s, %s, %s)",
            (str(job_id), level, message),
        )


async def set_ecom_status(
    pool: AsyncConnectionPool, job_id: UUID, status: EcomJobStatus, **fields: Any
) -> None:
    """`status` plus any of storage_dir/current_product may be set in the same call via
    `fields` — kept flexible (rather than one setter per column) since the pipeline sets status
    alongside storage_dir exactly once (on first entering 'capturing')."""
    columns = ["status = %s"]
    params: list[Any] = [status]
    for key, value in fields.items():
        columns.append(f"{key} = %s")
        params.append(value)
    params.append(str(job_id))
    async with pool.connection() as conn:
        await conn.execute(
            f"UPDATE ecom_jobs SET {', '.join(columns)} WHERE id = %s",
            params,  # noqa: S608
        )


async def set_ecom_counts(
    pool: AsyncConnectionPool,
    job_id: UUID,
    *,
    total: int | None = None,
    captured: int | None = None,
    ocr_done: int | None = None,
    detail_done: int | None = None,
    current_product: str | None = None,
) -> None:
    """Absolute sets (not increments) — COALESCE keeps untouched columns as-is so any stage can
    update just its own counter without clobbering the others."""
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE ecom_jobs SET
                total_count = COALESCE(%s, total_count),
                captured_count = COALESCE(%s, captured_count),
                ocr_done_count = COALESCE(%s, ocr_done_count),
                detail_done_count = COALESCE(%s, detail_done_count),
                current_product = COALESCE(%s, current_product)
            WHERE id = %s
            """,
            (total, captured, ocr_done, detail_done, current_product, str(job_id)),
        )


async def finish_ecom_job(
    pool: AsyncConnectionPool,
    job_id: UUID,
    status: EcomJobStatus,
    *,
    end_reason: EcomEndReason | None = None,
    error_message: str | None = None,
) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE ecom_jobs
            SET status = %s, end_reason = %s, error_message = %s, finished_at = now()
            WHERE id = %s
            """,
            (status, end_reason, error_message, str(job_id)),
        )


async def upsert_ecom_product(
    pool: AsyncConnectionPool, job_id: UUID, product: ParsedProduct
) -> None:
    """Idempotent on (job_id, idx) — a re-processed job overwrites rather than duplicating."""
    async with pool.connection() as conn:
        await conn.execute(
            """
            INSERT INTO ecom_products (
                job_id, idx, page_num, title, product_url, image_url, price, list_price,
                currency, discount_pct, rating, review_count, bought_past_month,
                bought_past_month_raw, free_delivery, delivery_date, category, badges,
                rank_in_category, sponsored, opportunity_score, extraction_source,
                ocr_confidence, needs_review, raw_text, source_images, description,
                about_bullets, breadcrumb_category, seller_name, detail_scraped
            ) VALUES (
                %(job_id)s, %(idx)s, %(page_num)s, %(title)s, %(product_url)s, %(image_url)s,
                %(price)s, %(list_price)s, %(currency)s, %(discount_pct)s, %(rating)s,
                %(review_count)s, %(bought_past_month)s, %(bought_past_month_raw)s,
                %(free_delivery)s, %(delivery_date)s, %(category)s, %(badges)s,
                %(rank_in_category)s, %(sponsored)s, %(opportunity_score)s,
                %(extraction_source)s, %(ocr_confidence)s, %(needs_review)s, %(raw_text)s,
                %(source_images)s, %(description)s, %(about_bullets)s,
                %(breadcrumb_category)s, %(seller_name)s, %(detail_scraped)s
            )
            ON CONFLICT (job_id, idx) DO UPDATE SET
                page_num = EXCLUDED.page_num, title = EXCLUDED.title,
                product_url = EXCLUDED.product_url, image_url = EXCLUDED.image_url,
                price = EXCLUDED.price, list_price = EXCLUDED.list_price,
                currency = EXCLUDED.currency, discount_pct = EXCLUDED.discount_pct,
                rating = EXCLUDED.rating, review_count = EXCLUDED.review_count,
                bought_past_month = EXCLUDED.bought_past_month,
                bought_past_month_raw = EXCLUDED.bought_past_month_raw,
                free_delivery = EXCLUDED.free_delivery, delivery_date = EXCLUDED.delivery_date,
                category = EXCLUDED.category, badges = EXCLUDED.badges,
                rank_in_category = EXCLUDED.rank_in_category, sponsored = EXCLUDED.sponsored,
                opportunity_score = EXCLUDED.opportunity_score,
                extraction_source = EXCLUDED.extraction_source,
                ocr_confidence = EXCLUDED.ocr_confidence, needs_review = EXCLUDED.needs_review,
                raw_text = EXCLUDED.raw_text, source_images = EXCLUDED.source_images,
                description = EXCLUDED.description, about_bullets = EXCLUDED.about_bullets,
                breadcrumb_category = EXCLUDED.breadcrumb_category,
                seller_name = EXCLUDED.seller_name, detail_scraped = EXCLUDED.detail_scraped
            """,
            {
                "job_id": str(job_id),
                "idx": product.idx,
                "page_num": product.page_num,
                "title": product.title,
                "product_url": product.product_url,
                "image_url": product.image_url,
                "price": product.price,
                "list_price": product.list_price,
                "currency": product.currency,
                "discount_pct": product.discount_pct,
                "rating": product.rating,
                "review_count": product.review_count,
                "bought_past_month": product.bought_past_month,
                "bought_past_month_raw": product.bought_past_month_raw,
                "free_delivery": product.free_delivery,
                "delivery_date": product.delivery_date,
                "category": product.category,
                "badges": Jsonb(product.badges),
                "rank_in_category": product.rank_in_category,
                "sponsored": product.sponsored,
                "opportunity_score": product.opportunity_score,
                "extraction_source": product.extraction_source,
                "ocr_confidence": product.ocr_confidence,
                "needs_review": product.needs_review,
                "raw_text": product.raw_text,
                "source_images": Jsonb(product.source_images),
                "description": product.description,
                "about_bullets": Jsonb(product.about_bullets),
                "breadcrumb_category": product.breadcrumb_category,
                "seller_name": product.seller_name,
                "detail_scraped": product.detail_scraped,
            },
        )


async def get_ecom_done_indices(pool: AsyncConnectionPool, job_id: UUID) -> set[int]:
    """Which `idx` values already have an ecom_products row for this job — from a PRIOR attempt
    on a resumed retry. Stage B skips these entirely rather than re-OCRing already-good results."""
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT idx FROM ecom_products WHERE job_id = %s", (str(job_id),))
        rows = cast("list[dict[str, Any]]", await cur.fetchall())
    return {row["idx"] for row in rows}


async def list_ecom_product_rows(
    pool: AsyncConnectionPool, job_id: UUID
) -> list[dict[str, object]]:
    """Every product row for this job, in capture order — used to (re)write a results.json from
    the DB (the actual source of truth) rather than only what THIS run's pass processed."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT * FROM ecom_products WHERE job_id = %s ORDER BY idx", (str(job_id),)
        )
        rows = cast("list[dict[str, Any]]", await cur.fetchall())
    return [dict(row) for row in rows]


async def get_ecom_job(pool: AsyncConnectionPool, job_id: UUID) -> EcomJob | None:
    async with pool.connection() as conn:
        cur = await conn.execute("SELECT * FROM ecom_jobs WHERE id = %s", (str(job_id),))
        row = await cur.fetchone()
    return EcomJob.model_validate(row) if row is not None else None


async def recover_orphaned_ecom_jobs(
    pool: AsyncConnectionPool,
    *,
    only_platforms: Collection[str] | None = None,
    exclude_platforms: Collection[str] | None = None,
) -> int:
    """Startup self-heal — mirrors ocr/jobs.py's recover_orphaned_ocr_jobs. A restart (or crash)
    mid-run hard-kills the browser/OCR and leaves a job stuck in a non-terminal running state
    (capturing/ocr/parsing/detail) that the claim query — which only takes 'queued' — will never
    pick up again. On start we mark any such orphan 'failed' with a clear message so it shows a
    clean terminal state the user can relaunch from. Returns the number recovered.

    MUST be partitioned the same way as claim (see cdp_required_platforms()): the container daemon
    passes exclude_platforms so it NEVER recovers a CDP-platform (noon) job the host runner is
    actively processing on another machine; the host runner passes only_platforms so it recovers
    only its own kind. Without this, a container respawn's recovery marks the host's live job
    'failed' out from under it (a real bug hit 2026-08-07)."""
    conditions = ["status IN ('capturing', 'ocr', 'parsing', 'detail')"]
    params: list[Any] = []
    if only_platforms is not None:
        conditions.append("platform = ANY(%s)")
        params.append(list(only_platforms))
    if exclude_platforms:
        conditions.append("NOT (platform = ANY(%s))")
        params.append(list(exclude_platforms))
    where = " AND ".join(conditions)
    async with pool.connection() as conn:
        cur = await conn.execute(
            f"""
            UPDATE ecom_jobs
            SET status = 'failed', end_reason = 'error', finished_at = now(),
                error_message = 'Interrupted by a server restart — relaunch the job.'
            WHERE {where}
            RETURNING id
            """,  # noqa: S608 - `where` is static fragments; values are parameterized
            params,
        )
        rows = await cur.fetchall()
    return len(rows)


async def increment_retry_count(pool: AsyncConnectionPool, job_id: UUID) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE ecom_jobs SET retry_count = retry_count + 1 WHERE id = %s", (str(job_id),)
        )
