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
import contextlib
from uuid import UUID

import structlog
from psycopg_pool import AsyncConnectionPool

from business_scout_worker import dedupe, llm, metrics
from business_scout_worker import jobs as job_queries
from business_scout_worker.discovery.models import DiscoveredBusiness
from business_scout_worker.discovery.overpass import discover
from business_scout_worker.enrich.tier1 import enrich_website
from business_scout_worker.logging_config import get_logger
from business_scout_worker.models import CrawlJob, CrawlSettings, DynamicField
from business_scout_worker.queries import get_crawl_settings, list_enabled_dynamic_fields
from business_scout_worker.settings import Settings

logger = get_logger(__name__)

PAUSE_POLL_SECONDS = 3.0


class JobCancelledError(Exception):
    """Raised internally to unwind the pipeline cleanly on cancel_requested."""


class JobInterruptedError(Exception):
    """Raised internally when the daemon itself is shutting down mid-job — distinct from
    cancellation: the job is released back to 'pending', not marked 'cancelled', since the
    user never asked for that (see jobs.release_job)."""


async def _run_discovery_interruptibly(
    business_type: str,
    lat: float,
    lng: float,
    radius_km: float,
    shutdown_event: asyncio.Event | None,
) -> list[DiscoveredBusiness]:
    """`discover()` itself has no shutdown-awareness — for a large radius it tiles into several
    sequential Overpass calls that can run for a while with no checkpoint in between (each call
    is individually capped at 60s, but a big tiled area is many calls back to back). Without this
    wrapper, a container restart mid-discovery orphans the job in 'discovering' forever: the
    existing pause/cancel/shutdown checks in `_check_job_control_flags` only run BETWEEN
    processing batches, which is after discovery has already fully finished. Verified real, not
    hypothetical — a 35km-radius job got stuck exactly this way during a routine backend
    redeploy. Races `discover()` against `shutdown_event.wait()`; whichever finishes first wins,
    and on shutdown the still-running discovery task is cancelled cleanly before propagating
    `JobInterruptedError` so the job is released back to 'pending', not left stuck."""
    if shutdown_event is None:
        return await discover(business_type, lat, lng, radius_km)

    discover_task: asyncio.Task[list[DiscoveredBusiness]] = asyncio.ensure_future(
        discover(business_type, lat, lng, radius_km)
    )
    shutdown_task = asyncio.ensure_future(shutdown_event.wait())
    try:
        done, _pending = await asyncio.wait(
            {discover_task, shutdown_task}, return_when=asyncio.FIRST_COMPLETED
        )
        if discover_task in done:
            return discover_task.result()
        raise JobInterruptedError
    finally:
        for task in (discover_task, shutdown_task):
            if not task.done():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task


async def run_job(
    pool: AsyncConnectionPool,
    job: CrawlJob,
    worker_settings: Settings,
    shutdown_event: asyncio.Event | None = None,
) -> None:
    log = logger.bind(job_id=str(job.id), business_type=job.business_type)
    try:
        settings = await get_crawl_settings(pool)
        dynamic_fields = (
            await list_enabled_dynamic_fields(pool) if settings.use_ai_extraction else []
        )

        await job_queries.write_log(
            pool,
            job.id,
            "info",
            f"Discovering '{job.business_type}' within {job.radius_km}km via Overpass",
        )
        discovered = await _run_discovery_interruptibly(
            job.business_type, job.center_lat, job.center_lng, float(job.radius_km), shutdown_event
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
            await asyncio.gather(
                *(
                    _process_one(pool, job.id, settings, worker_settings, dynamic_fields, b, log)
                    for b in batch
                )
            )

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
    worker_settings: Settings,
    dynamic_fields: list[DynamicField],
    discovered_business: DiscoveredBusiness,
    log: structlog.typing.FilteringBoundLogger,
) -> None:
    business_id = await dedupe.upsert_discovered(pool, job_id, discovered_business)
    business_id = await dedupe.merge_fuzzy_duplicate_if_found(
        pool,
        business_id,
        discovered_business.name,
        discovered_business.latitude,
        discovered_business.longitude,
    )
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
            website_url,
            user_agent=settings.user_agent,
            timeout_ms=settings.timeout_ms,
            respect_robots_txt=settings.respect_robots_txt,
            request_delay_ms=settings.request_delay_ms,
            retry_count=settings.retry_count,
            proxy_url=settings.proxy_url,
        )
        await dedupe.apply_enrichment(
            pool, business_id, website_url, result, region=discovered_business.country
        )
        await job_queries.increment_counters(pool, job_id, website_crawled=1)
        if result.used_tier2:
            # Best-effort, deliberately swallowed — a metrics-table write hiccup must not
            # retroactively turn an already-successful enrichment into a 'failed' business.
            try:
                await metrics.increment_metric(pool, "tier2_renders_total")
            except Exception as exc:  # noqa: BLE001 - metrics are best-effort
                logger.warning(
                    "tier2_metric_write_failed", business_id=str(business_id), error=str(exc)
                )

        if dynamic_fields and result.page_text:
            await _run_ai_extraction(
                pool, business_id, worker_settings, dynamic_fields, website_url, result.page_text
            )
    except Exception as exc:  # noqa: BLE001 - one bad site must not abort the whole job
        await dedupe.mark_enrichment_failed(pool, business_id)
        await job_queries.increment_counters(pool, job_id, failed=1)
        await job_queries.write_log(
            pool, job_id, "warn", f"Enrichment failed for {discovered_business.name}: {exc}"
        )


async def _run_ai_extraction(
    pool: AsyncConnectionPool,
    business_id: UUID,
    worker_settings: Settings,
    dynamic_fields: list[DynamicField],
    website_url: str,
    page_text: str,
) -> None:
    """Best-effort, isolated from the enrichment try/except above — `llm.extract_field` itself
    never raises, but a DB write failure here must not retroactively flip a successfully Tier-1-
    enriched business back to 'failed' (AI extraction is a strictly optional add-on, see Phase 5
    in md/plans/0001-*.md)."""
    domain = llm.domain_of(website_url)
    extras: dict[str, object] = {}
    for field in dynamic_fields:
        # Counted once per field-extraction attempt (not per internal HTTP retry inside
        # llm.py) — llm.py's low-level HTTP call has no pool/DB access, so this is the
        # orchestration-level proxy for "how much LLM work did this crawl generate". A metrics
        # write failure is swallowed here too — it must never fail the business (same reasoning
        # as the apply_ai_extras try/except below).
        try:
            await metrics.increment_metric(pool, "llm_calls_total")
        except Exception as exc:  # noqa: BLE001 - metrics are best-effort, never fail the business
            logger.warning("llm_metric_write_failed", business_id=str(business_id), error=str(exc))
        extras[field.key] = await llm.extract_field(
            enabled=True,
            base_url=worker_settings.llm_base_url,
            api_key=worker_settings.llm_api_key,
            model=worker_settings.llm_model,
            timeout_s=worker_settings.llm_timeout_s,
            max_tokens=worker_settings.llm_max_tokens,
            domain=domain,
            page_text=page_text,
            field_key=field.key,
            field_type=field.field_type,
            prompt=field.prompt,
        )
    try:
        await dedupe.apply_ai_extras(pool, business_id, extras)
    except Exception as exc:  # noqa: BLE001 - AI extras are optional, never fail the business
        logger.warning("ai_extras_write_failed", business_id=str(business_id), error=str(exc))
