"""Authored by: Mohit Singh

DB queries for the Property Research job lifecycle — mirrors ecom/jobs.py's shape 1:1, retargeted
at property_jobs/property_listings/property_logs (see
db/migrations/1785300000000_property-crawl.sql). Atomic claim via FOR UPDATE SKIP LOCKED;
progress/status writes as the job moves capturing -> parsing -> scoring -> [detail ->] ready (or
failed/blocked). The Node API only reads these rows.
"""

from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool

from business_scout_worker.models import LogLevel
from business_scout_worker.property.models import (
    ListingRefresh,
    ParsedListing,
    PropertyJob,
    PropertyJobStatus,
)


async def claim_pending_property_job(
    pool: AsyncConnectionPool, platform: str
) -> PropertyJob | None:
    """Every property platform is REQUIRES_CDP (see adapters/base.py) — this module has no
    container-daemon claimant at all, only run_property_host.py. Scoped to ONE `platform`
    (2026-08-23 — see
    db/migrations/1785800000000_property-jobs-per-platform-concurrency.sql): dubizzle and
    propertyfinder are independent sites captured by independent Playwright Pages within the same
    Chrome, so run_property_host.py now runs one claim/drain loop PER platform concurrently — this
    scoping is what keeps each loop from claiming the other platform's queued jobs. The DB's own
    partial unique index (per-platform, not global) is the actual guarantee against two jobs on
    the SAME platform running at once; this WHERE clause is just "don't even try" for the wrong
    platform."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            """
            UPDATE property_jobs SET status = 'capturing', started_at = now()
            WHERE id = (
                SELECT id FROM property_jobs
                WHERE status = 'queued' AND platform = %s
                ORDER BY created_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING *
            """,
            (platform,),
        )
        row = await cur.fetchone()
    return PropertyJob.model_validate(row) if row is not None else None


async def write_log(pool: AsyncConnectionPool, job_id: UUID, level: LogLevel, message: str) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            "INSERT INTO property_logs (job_id, level, message) VALUES (%s, %s, %s)",
            (str(job_id), level, message),
        )


async def set_property_status(
    pool: AsyncConnectionPool, job_id: UUID, status: PropertyJobStatus, **fields: Any
) -> None:
    columns = ["status = %s"]
    params: list[Any] = [status]
    for key, value in fields.items():
        columns.append(f"{key} = %s")
        params.append(value)
    params.append(str(job_id))
    async with pool.connection() as conn:
        await conn.execute(
            f"UPDATE property_jobs SET {', '.join(columns)} WHERE id = %s",
            params,  # noqa: S608 - `columns` are static field-name fragments, values parameterized
        )


async def set_property_counts(
    pool: AsyncConnectionPool,
    job_id: UUID,
    *,
    captured: int | None = None,
    total: int | None = None,
    detail_done: int | None = None,
    current_listing: str | None = None,
) -> None:
    columns: list[str] = []
    params: list[Any] = []
    if captured is not None:
        columns.append("captured_count = %s")
        params.append(captured)
    if total is not None:
        columns.append("total_count = %s")
        params.append(total)
    if detail_done is not None:
        columns.append("detail_done_count = %s")
        params.append(detail_done)
    if current_listing is not None:
        columns.append("current_listing = %s")
        params.append(current_listing)
    if not columns:
        return
    params.append(str(job_id))
    async with pool.connection() as conn:
        await conn.execute(
            f"UPDATE property_jobs SET {', '.join(columns)} WHERE id = %s",
            params,  # noqa: S608 - `columns` are static field-name fragments, values parameterized
        )


async def finish_property_job(
    pool: AsyncConnectionPool,
    job_id: UUID,
    status: PropertyJobStatus,
    *,
    end_reason: str | None = None,
    error_message: str | None = None,
) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE property_jobs
            SET status = %s, end_reason = %s, error_message = %s, finished_at = now()
            WHERE id = %s
            """,
            (status, end_reason, error_message, str(job_id)),
        )


async def get_property_done_indices(pool: AsyncConnectionPool, job_id: UUID) -> set[int]:
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT idx FROM property_listings WHERE job_id = %s", (str(job_id),)
        )
        rows = cast("list[dict[str, Any]]", await cur.fetchall())
    return {cast(int, r["idx"]) for r in rows}


async def upsert_property_listing(
    pool: AsyncConnectionPool, job_id: UUID, listing: ParsedListing
) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            """
            INSERT INTO property_listings (
                job_id, idx, page_num, title, listing_url, image_urls, price, currency,
                area_sqft, price_per_sqft, bedrooms, bathrooms, property_type, location_text,
                community, listed_days_ago, verified, badges, is_offplan, distress_keywords,
                agent_name, phone_number, whatsapp_link, description, age_years, average_rent,
                listed_date, distress_score, distress_confidence, extraction_source,
                ocr_confidence, needs_review, raw_text, source_images, detail_scraped
            ) VALUES (
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s,
                %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s
            )
            ON CONFLICT (job_id, idx) DO UPDATE SET
                title = EXCLUDED.title,
                listing_url = EXCLUDED.listing_url,
                image_urls = EXCLUDED.image_urls,
                price = EXCLUDED.price,
                currency = EXCLUDED.currency,
                area_sqft = EXCLUDED.area_sqft,
                price_per_sqft = EXCLUDED.price_per_sqft,
                bedrooms = EXCLUDED.bedrooms,
                bathrooms = EXCLUDED.bathrooms,
                property_type = EXCLUDED.property_type,
                location_text = EXCLUDED.location_text,
                community = EXCLUDED.community,
                listed_days_ago = EXCLUDED.listed_days_ago,
                verified = EXCLUDED.verified,
                badges = EXCLUDED.badges,
                is_offplan = EXCLUDED.is_offplan,
                distress_keywords = EXCLUDED.distress_keywords,
                agent_name = EXCLUDED.agent_name,
                phone_number = EXCLUDED.phone_number,
                whatsapp_link = EXCLUDED.whatsapp_link,
                description = EXCLUDED.description,
                age_years = EXCLUDED.age_years,
                average_rent = EXCLUDED.average_rent,
                listed_date = EXCLUDED.listed_date,
                distress_score = EXCLUDED.distress_score,
                distress_confidence = EXCLUDED.distress_confidence,
                extraction_source = EXCLUDED.extraction_source,
                ocr_confidence = EXCLUDED.ocr_confidence,
                needs_review = EXCLUDED.needs_review,
                raw_text = EXCLUDED.raw_text,
                source_images = EXCLUDED.source_images,
                detail_scraped = EXCLUDED.detail_scraped
            """,
            (
                str(job_id),
                listing.idx,
                listing.page_num,
                listing.title,
                listing.listing_url,
                Jsonb(listing.image_urls),
                listing.price,
                listing.currency,
                listing.area_sqft,
                listing.price_per_sqft,
                listing.bedrooms,
                listing.bathrooms,
                listing.property_type,
                listing.location_text,
                listing.community,
                listing.listed_days_ago,
                listing.verified,
                Jsonb(listing.badges),
                listing.is_offplan,
                Jsonb(listing.distress_keywords),
                listing.agent_name,
                listing.phone_number,
                listing.whatsapp_link,
                listing.description,
                listing.age_years,
                listing.average_rent,
                listing.listed_date,
                listing.distress_score,
                listing.distress_confidence,
                listing.extraction_source,
                listing.ocr_confidence,
                listing.needs_review,
                listing.raw_text,
                Jsonb(listing.source_images),
                listing.detail_scraped,
            ),
        )


async def list_property_listing_rows(
    pool: AsyncConnectionPool, job_id: UUID
) -> list[dict[str, Any]]:
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT * FROM property_listings WHERE job_id = %s ORDER BY idx", (str(job_id),)
        )
        rows = cast("list[dict[str, Any]]", await cur.fetchall())
    return rows


async def recover_orphaned_property_jobs(pool: AsyncConnectionPool) -> int:
    """Startup self-heal — mirrors ecom/jobs.py's recover_orphaned_ecom_jobs. Called from
    run_property_host.py's own startup (there is no container daemon claimant for this module to
    call it from), so — unlike ecom's — it needs no platform partitioning at all."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            """
            UPDATE property_jobs
            SET status = 'failed', end_reason = 'error', finished_at = now(),
                error_message = 'Interrupted by a runner restart — relaunch the job.'
            WHERE status IN ('capturing', 'parsing', 'detail', 'scoring')
            RETURNING id
            """
        )
        rows = await cur.fetchall()
    return len(rows)


async def increment_retry_count(pool: AsyncConnectionPool, job_id: UUID) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE property_jobs SET retry_count = retry_count + 1 WHERE id = %s", (str(job_id),)
        )


# --- Single-listing refresh queue (see property/refresh.py + db/migrations/
# 1785700000000_property-listing-refreshes.sql) — a much lighter claim than a whole search job,
# but the same FOR UPDATE SKIP LOCKED pattern so two concurrent host-runner cycles can't double-
# claim the same refresh request.


async def get_listing_price(pool: AsyncConnectionPool, listing_id: UUID) -> float | None:
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT price FROM property_listings WHERE id = %s", (str(listing_id),)
        )
        row = await cur.fetchone()
    if row is None:
        return None
    price = cast("dict[str, Any]", row)["price"]
    return float(price) if price is not None else None


async def claim_pending_listing_refresh(pool: AsyncConnectionPool) -> ListingRefresh | None:
    async with pool.connection() as conn:
        cur = await conn.execute(
            """
            UPDATE property_listing_refreshes SET status = 'running'
            WHERE id = (
                SELECT id FROM property_listing_refreshes
                WHERE status = 'queued'
                ORDER BY requested_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING *
            """
        )
        row = await cur.fetchone()
    return ListingRefresh.model_validate(row) if row is not None else None


async def finish_listing_refresh(
    pool: AsyncConnectionPool,
    refresh_id: UUID,
    *,
    status: str,
    old_price: float | None = None,
    new_price: float | None = None,
    error_message: str | None = None,
) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE property_listing_refreshes
            SET status = %s, old_price = %s, new_price = %s, error_message = %s,
                completed_at = now()
            WHERE id = %s
            """,
            (status, old_price, new_price, error_message, str(refresh_id)),
        )


async def update_listing_price(pool: AsyncConnectionPool, listing_id: UUID, price: float) -> None:
    """Applies a refreshed price directly onto the existing property_listings row — this is the
    'fresh row should be fetched' half of the refresh flow: the row the operator is already
    looking at updates in place, it doesn't wait for a brand-new job/row to appear. price_per_sqft
    is recomputed from the row's own stored area_sqft when present, same formula pipeline.py uses
    for a normal capture, so the two columns can't drift out of sync after a refresh."""
    async with pool.connection() as conn:
        await conn.execute(
            """
            UPDATE property_listings
            SET price = %s,
                price_per_sqft = CASE
                    WHEN area_sqft IS NOT NULL AND area_sqft > 0
                    THEN round(%s::numeric / area_sqft, 2)
                    ELSE price_per_sqft
                END
            WHERE id = %s
            """,
            (price, price, str(listing_id)),
        )
