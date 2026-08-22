"""Authored by: Mohit Singh

Property Research job orchestrator — the runner calls this when it claims a property_jobs row.
Drives the state machine capturing -> parsing -> scoring -> [detail ->] ready (or blocked/failed),
mirroring ecom/pipeline.py's shape/guarantees (best-effort per item, terminal DB state always set)
but SEPARATE code: own capture engine (property/capture.py), own OCR-fallback parser
(property/parse_property.py), own scoring (property/analysis.py), own DB access (property/jobs.py).

Stage order differs from ecom's on purpose: SCORING happens BEFORE detail, because which listings
get a detail-page visit (phone reveal -> WhatsApp link) is driven by the distress_score ranking —
detail scraping the top-N only makes sense once every listing has a score to rank by.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import cast

from psycopg_pool import AsyncConnectionPool

from business_scout_worker.logging_config import get_logger
from business_scout_worker.ocr.ocr_engine import merge_segments
from business_scout_worker.property import jobs as property_jobs
from business_scout_worker.property import parse_property
from business_scout_worker.property.adapters import get_adapter
from business_scout_worker.property.adapters.base import SearchFilters
from business_scout_worker.property.analysis import compute_distress_scores
from business_scout_worker.property.capture import (
    PropertyBlockedError,
    PropertyCaptureEngine,
    PropertyInterruptedError,
)
from business_scout_worker.property.models import (
    CapturedListing,
    ParsedListing,
    PropertyJob,
    PropertyManifest,
)
from business_scout_worker.settings import Settings

logger = get_logger(__name__)

# A listing "has enough DOM fields" when the card exposed the CORE fields — title+price+area.
# Anything short of that runs through the OCR fallback in Stage B (mirrors ecom/pipeline.py's
# _dom_is_complete, whose review-count-not-required lesson is applied here from day one: beds/
# baths/community are NOT required, since plenty of real listings omit one of those without it
# meaning DOM extraction failed).
_REQUIRED_DOM_FIELDS = ("price", "area_sqft")


def _dom_is_complete(listing: CapturedListing) -> bool:
    dom = listing.dom
    return bool(listing.title) and all(
        getattr(dom, f, None) is not None for f in _REQUIRED_DOM_FIELDS
    )


async def run_property_job(
    pool: AsyncConnectionPool,
    job: PropertyJob,
    settings: Settings,
    shutdown_event: asyncio.Event | None = None,
) -> None:
    log = logger.bind(property_job_id=str(job.id), platform=job.platform, location=job.location)
    job_dir = Path(settings.property_captures_dir) / str(job.id)
    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        await property_jobs.set_property_status(pool, job.id, "capturing", storage_dir=str(job.id))
        await property_jobs.write_log(
            pool, job.id, "info", f"Property research job started: {job.location} on {job.platform}"
        )

        adapter = get_adapter(job.platform)
        filters = SearchFilters(
            location=job.location,
            bedrooms=job.bedrooms,
            bathrooms=job.bathrooms,
            property_type=job.property_type,
            purpose=job.purpose,
        )

        manifest_path = job_dir / "manifest.json"
        resume_items: list[CapturedListing] = []
        if manifest_path.exists():
            try:
                prior = PropertyManifest.model_validate_json(manifest_path.read_text("utf-8"))
                resume_items = prior.items
                log.info("resuming from prior manifest", already_captured=len(resume_items))
                await property_jobs.write_log(
                    pool,
                    job.id,
                    "info",
                    f"Resuming: {len(resume_items)} listings already captured, skipping them",
                )
            except Exception as exc:  # noqa: BLE001 - a corrupt manifest must not block a retry
                log.warning("prior manifest unreadable, starting capture fresh", error=str(exc))

        # --- Stage A: capture ---
        log.info("property capture starting")

        async def _on_progress(captured: int, discovered: int, current: str | None) -> None:
            await property_jobs.set_property_counts(
                pool, job.id, captured=captured, total=discovered, current_listing=current
            )
            if current is not None:
                await property_jobs.write_log(
                    pool, job.id, "info", f"Capturing: {current} ({captured}/{discovered})"
                )

        engine = PropertyCaptureEngine(adapter, settings, job_dir, str(job.id))
        should_stop = (lambda: shutdown_event.is_set()) if shutdown_event is not None else None
        manifest = await engine.run(
            filters=filters,
            max_pages=job.max_pages,
            max_listings=job.max_listings,
            started_at=job.created_at.isoformat(),
            resume_items=resume_items or None,
            on_progress=_on_progress,
            should_stop=should_stop,
        )
        await property_jobs.set_property_counts(
            pool, job.id, total=len(manifest.items), captured=len(manifest.items)
        )
        log.info("property capture done", count=len(manifest.items), end_reason=manifest.end_reason)
        await property_jobs.write_log(
            pool,
            job.id,
            "info",
            f"Capture done: {len(manifest.items)} listings ({manifest.end_reason})",
        )

        # --- Stage B: parsing (OCR fallback for whatever the DOM missed) ---
        await property_jobs.set_property_status(pool, job.id, "parsing")
        await property_jobs.write_log(pool, job.id, "info", "Parsing listings")
        already_done = await property_jobs.get_property_done_indices(pool, job.id)
        pending_items = [it for it in manifest.items if it.idx not in already_done]
        sem = asyncio.Semaphore(settings.ocr_concurrency)
        interrupted = False
        parsed_by_idx: dict[int, ParsedListing] = {}

        async def _parse_one(item: CapturedListing) -> None:
            nonlocal interrupted
            async with sem:
                if shutdown_event is not None and shutdown_event.is_set():
                    interrupted = True
                    return
                try:
                    ocr_text = ""
                    ocr_confidence = 0.0
                    if not (_dom_is_complete(item) or not item.images):
                        try:
                            ocr_result = await asyncio.to_thread(
                                merge_segments, item.images, job_dir, "eng", settings.tesseract_cmd
                            )
                            ocr_text = "\n".join(line.text for line in ocr_result.lines)
                            ocr_confidence = ocr_result.mean_confidence
                        except Exception as ocr_exc:  # noqa: BLE001
                            log.warning(
                                "OCR fallback failed, using DOM-only",
                                title=item.title,
                                error=str(ocr_exc),
                            )
                    parsed = parse_property.parse_listing(
                        ocr_text,
                        idx=item.idx,
                        title=item.title,
                        listing_url=item.listing_url,
                        image_url=item.image_url,
                        page_num=item.page_num,
                        dom=item.dom,
                        ocr_confidence=ocr_confidence,
                        default_currency=adapter.default_currency,
                    )
                    parsed.source_images = item.images
                    if parsed.price is not None and parsed.area_sqft:
                        parsed.price_per_sqft = round(parsed.price / parsed.area_sqft, 2)
                    parsed_by_idx[item.idx] = parsed
                except Exception as exc:  # noqa: BLE001 - one bad item must not abort the job
                    log.warning("parse failed for item", title=item.title, error=str(exc))

        await asyncio.gather(*(_parse_one(item) for item in pending_items))

        if interrupted:
            await property_jobs.finish_property_job(
                pool,
                job.id,
                "failed",
                end_reason="error",
                error_message="Interrupted by runner shutdown — relaunch the job.",
            )
            log.info("property job interrupted mid-parse — marked failed for relaunch")
            return

        # --- Stage C: scoring (needs the WHOLE batch — price/sqft is ranked relative to it) ---
        await property_jobs.set_property_status(pool, job.id, "scoring")
        await property_jobs.write_log(pool, job.id, "info", "Scoring listings")
        new_listings = list(parsed_by_idx.values())
        if new_listings:
            scores = compute_distress_scores(new_listings, job.score_weights)
            for listing, score in zip(new_listings, scores, strict=True):
                listing.distress_score = score
                await property_jobs.upsert_property_listing(pool, job.id, listing)

        # --- Stage D (optional): detail scrape for the top-N by distress_score ---
        end_reason = manifest.end_reason
        if job.detail_scrape_top_n > 0:
            await property_jobs.set_property_status(pool, job.id, "detail")
            await property_jobs.write_log(
                pool, job.id, "info", f"Detail scrape starting (top {job.detail_scrape_top_n})"
            )
            all_rows = await property_jobs.list_property_listing_rows(pool, job.id)
            ranked = sorted(all_rows, key=lambda r: r.get("distress_score") or 0.0, reverse=True)
            top_rows = ranked[: job.detail_scrape_top_n]
            top_listings = [
                item for item in manifest.items if item.idx in {r["idx"] for r in top_rows}
            ]
            try:
                detail_results = await engine.capture_details(
                    top_listings, job.whatsapp_message_template, should_stop=should_stop
                )
            except PropertyInterruptedError:
                await property_jobs.finish_property_job(
                    pool,
                    job.id,
                    "failed",
                    end_reason="error",
                    error_message="Interrupted by runner shutdown — relaunch the job.",
                )
                log.info("property job interrupted mid-detail-scrape — marked failed for relaunch")
                return

            detail_done = 0
            for row in top_rows:
                idx = cast(int, row["idx"])
                detail = detail_results.get(idx)
                if detail is None:
                    continue
                listing = ParsedListing.model_validate(row)
                listing.description = cast("str | None", detail.get("description"))
                listing.agent_name = cast("str | None", detail.get("agent_name"))
                listing.phone_number = cast("str | None", detail.get("phone_number"))
                listing.whatsapp_link = cast("str | None", detail.get("whatsapp_link"))
                listing.age_years = cast("int | None", detail.get("age_years"))
                listing.average_rent = cast("float | None", detail.get("average_rent"))
                detail_images = cast("list[str]", detail.get("image_urls") or [])
                if detail_images:
                    listing.image_urls = detail_images
                listing.detail_scraped = True
                await property_jobs.upsert_property_listing(pool, job.id, listing)
                detail_done += 1
                await property_jobs.set_property_counts(pool, job.id, detail_done=detail_done)
            await property_jobs.write_log(
                pool, job.id, "info", f"Detail scrape done: {detail_done} listings"
            )

        results = await property_jobs.list_property_listing_rows(pool, job.id)
        (job_dir / "results.json").write_text(
            json.dumps(results, indent=2, default=str), encoding="utf-8"
        )

        await property_jobs.finish_property_job(pool, job.id, "ready", end_reason=end_reason)
        await property_jobs.write_log(pool, job.id, "info", f"Job ready: {len(results)} listings")
        log.info("property job ready", rows=len(results))

    except PropertyInterruptedError:
        await property_jobs.finish_property_job(
            pool,
            job.id,
            "failed",
            end_reason="error",
            error_message="Interrupted by runner shutdown — relaunch the job.",
        )
        log.info("property job interrupted mid-capture — marked failed for relaunch")
    except PropertyBlockedError as exc:
        await property_jobs.finish_property_job(
            pool, job.id, "blocked", end_reason="blocked", error_message=str(exc)[:500]
        )
        await property_jobs.write_log(pool, job.id, "warn", f"Job blocked: {str(exc)[:200]}")
        log.warning("property job blocked", error=str(exc))
    except Exception as exc:  # noqa: BLE001 - a crashed job must still reach a terminal DB state
        await property_jobs.finish_property_job(
            pool, job.id, "failed", end_reason="error", error_message=str(exc)[:500]
        )
        await property_jobs.write_log(pool, job.id, "error", f"Job failed: {str(exc)[:200]}")
        log.error("property job failed", error=str(exc))
