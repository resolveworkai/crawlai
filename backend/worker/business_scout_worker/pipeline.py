"""Authored by: Mohit Singh

Job orchestration — the P1 daemon's per-job pipeline: discover -> upsert -> (optional) Tier-1
enrich -> log/counter updates -> completion. See md/plans/0001-*.md "Phase 3 — Crawler MVP".

Businesses within a job are processed in batches of `crawl_settings.concurrency` (Tier-1
fetches run concurrently within a batch via asyncio.gather; discovery itself is one batched
Overpass call, already parallel-ish via tiling). cancel_requested/pause_requested are checked
between batches, not between every single business — a deliberate MVP simplification (documented,
not silent) that still satisfies "checked between businesses" at batch granularity while giving
the Settings screen's Concurrency control a real effect.
"""

from __future__ import annotations

import asyncio
from uuid import UUID

import structlog
from psycopg_pool import AsyncConnectionPool

from business_scout_worker import dedupe
from business_scout_worker import jobs as job_queries
from business_scout_worker.discovery.models import DiscoveredBusiness
from business_scout_worker.discovery.overpass import discover
from business_scout_worker.enrich.tier1 import enrich_website
from business_scout_worker.logging_config import get_logger
from business_scout_worker.models import CrawlJob, CrawlSettings
from business_scout_worker.queries import get_crawl_settings

logger = get_logger(__name__)

PAUSE_POLL_SECONDS = 3.0


class JobCancelledError(Exception):
    """Raised internally to unwind the pipeline cleanly on cancel_requested."""


class JobInterruptedError(Exception):
    """Raised internally when the daemon itself is shutting down mid-job — distinct from
    cancellation: the job is released back to 'pending', not marked 'cancelled', since the
    user never asked for that (see jobs.release_job)."""


async def run_job(
    pool: AsyncConnectionPool, job: CrawlJob, shutdown_event: asyncio.Event | None = None
) -> None:
    log = logger.bind(job_id=str(job.id), business_type=job.business_type)
    try:
        settings = await get_crawl_settings(pool)

        await job_queries.write_log(
            pool,
            job.id,
            "info",
            f"Discovering '{job.business_type}' within {job.radius_km}km via Overpass",
        )
        discovered = await discover(
            job.business_type, job.center_lat, job.center_lng, float(job.radius_km)
        )
        await job_queries.increment_counters(pool, job.id, found=len(discovered))
        await job_queries.write_log(
            pool, job.id, "info", f"Discovered {len(discovered)} businesses"
        )
        await job_queries.set_job_status(pool, job.id, "crawling")

        batch_size = max(1, settings.concurrency)
        for start in range(0, len(discovered), batch_size):
            batch = discovered[start : start + batch_size]
            await _check_job_control_flags(pool, job.id, shutdown_event, log)
            await job_queries.set_current_business(pool, job.id, batch[-1].name)
            await asyncio.gather(*(_process_one(pool, job.id, settings, b, log) for b in batch))

        await job_queries.finish_job(pool, job.id, "completed")
        await job_queries.write_log(pool, job.id, "info", "Job completed")
        log.info("job completed")

    except JobCancelledError:
        await job_queries.finish_job(pool, job.id, "cancelled")
        await job_queries.write_log(pool, job.id, "info", "Job cancelled")
        log.info("job cancelled")

    except JobInterruptedError:
        await job_queries.release_job(pool, job.id)
        log.info("job released back to pending — worker shutting down")

    except Exception as exc:  # noqa: BLE001 - a crashed job must still reach a terminal DB state
        await job_queries.finish_job(pool, job.id, "failed", error_message=str(exc)[:500])
        await job_queries.write_log(pool, job.id, "error", f"Job failed: {exc}")
        log.error("job failed", error=str(exc))


async def _check_job_control_flags(
    pool: AsyncConnectionPool,
    job_id: UUID,
    shutdown_event: asyncio.Event | None,
    log: structlog.typing.FilteringBoundLogger,
) -> None:
    """Runs between batches: honors a daemon shutdown first (finish the in-flight batch, then
    release the claim rather than starting a new one), then cancel_requested, then pauses on
    pause_requested until cleared or cancelled."""
    if shutdown_event is not None and shutdown_event.is_set():
        raise JobInterruptedError

    current = await job_queries.refresh_job(pool, job_id)
    if current is None or current.cancel_requested:
        raise JobCancelledError

    if current.pause_requested:
        await job_queries.set_job_status(pool, job_id, "paused")
        await job_queries.write_log(pool, job_id, "info", "Job paused")
        while True:
            if shutdown_event is not None and shutdown_event.is_set():
                raise JobInterruptedError
            await asyncio.sleep(PAUSE_POLL_SECONDS)
            current = await job_queries.refresh_job(pool, job_id)
            if current is None or current.cancel_requested:
                raise JobCancelledError
            if not current.pause_requested:
                await job_queries.set_job_status(pool, job_id, "crawling")
                await job_queries.write_log(pool, job_id, "info", "Job resumed")
                return


async def _process_one(
    pool: AsyncConnectionPool,
    job_id: UUID,
    settings: CrawlSettings,
    discovered_business: DiscoveredBusiness,
    log: structlog.typing.FilteringBoundLogger,
) -> None:
    business_id = await dedupe.upsert_discovered(pool, job_id, discovered_business)
    await job_queries.increment_counters(pool, job_id, crawled=1)

    should_enrich = settings.crawl_website and discovered_business.website_url is not None
    if should_enrich and not await dedupe.needs_enrichment(pool, business_id):
        should_enrich = False  # idempotent re-crawl: freshly enriched, nothing to do

    if not should_enrich:
        if discovered_business.website_url is None:
            # No site to enrich — OSM-only data is still a valid, complete result (req #4's
            # "best-effort per site" note); nothing left to do for this business.
            await dedupe.mark_enrichment_status(pool, business_id, "enriched")
        return

    website_url = discovered_business.website_url
    assert website_url is not None  # should_enrich already guarantees this

    try:
        result = await enrich_website(
            website_url, user_agent=settings.user_agent, timeout_ms=settings.timeout_ms
        )
        await dedupe.apply_enrichment(pool, business_id, website_url, result)
        await job_queries.increment_counters(pool, job_id, website_crawled=1)
    except Exception as exc:  # noqa: BLE001 - one bad site must not abort the whole job
        await dedupe.mark_enrichment_failed(pool, business_id)
        await job_queries.increment_counters(pool, job_id, failed=1)
        await job_queries.write_log(
            pool, job_id, "warn", f"Enrichment failed for {discovered_business.name}: {exc}"
        )
