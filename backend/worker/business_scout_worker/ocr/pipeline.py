"""Authored by: Mohit Singh

Crawl-OCR job orchestrator — the daemon runs this when it claims an ocr_jobs row. Drives the
state machine capturing -> ocr -> parsing -> ready (or blocked/failed): Stage A captures panel
screenshots (capture.py), Stage B OCRs + parses them (ocr_engine.py + parse_fields.py), rows are
written to ocr_businesses and a results.json is left in the job folder. Mirrors the main
crawler's pipeline.run_job shape/guarantees (best-effort per item, terminal DB state always set).
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

from psycopg_pool import AsyncConnectionPool

from business_scout_worker.logging_config import get_logger
from business_scout_worker.ocr import jobs as ocr_jobs
from business_scout_worker.ocr import parse_fields
from business_scout_worker.ocr.capture import (
    CaptureBlockedError,
    CaptureEngine,
    CaptureInterruptedError,
)
from business_scout_worker.ocr.models import CapturedItem, CaptureManifest, OcrJob
from business_scout_worker.ocr.ocr_engine import merge_segments
from business_scout_worker.settings import Settings

logger = get_logger(__name__)


async def run_ocr_job(
    pool: AsyncConnectionPool,
    job: OcrJob,
    settings: Settings,
    shutdown_event: asyncio.Event | None = None,
) -> None:
    log = logger.bind(ocr_job_id=str(job.id), query=job.query, location=job.location)
    job_dir = Path(settings.ocr_captures_dir) / str(job.id)
    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        await ocr_jobs.set_ocr_storage_dir(pool, job.id, str(job.id))

        # RETRY / RESUME: a manifest.json already on disk means a prior attempt on this exact
        # job (same id — retry resets the existing row rather than creating a new one, see
        # routes/ocrCrawl.ts) got partway through Stage A before failing/blocking. Reload what it
        # already captured so those businesses are never re-navigated or re-captured — only
        # genuinely new ones get walked. See capture.py's incremental checkpointing.
        manifest_path = job_dir / "manifest.json"
        resume_items: list[CapturedItem] = []
        if manifest_path.exists():
            try:
                prior = CaptureManifest.model_validate_json(manifest_path.read_text("utf-8"))
                resume_items = prior.items
                log.info("resuming from prior manifest", already_captured=len(resume_items))
            except Exception as exc:  # noqa: BLE001 - a corrupt manifest must not block a retry
                log.warning("prior manifest unreadable, starting capture fresh", error=str(exc))

        # --- Stage A: capture ---
        log.info("ocr capture starting")

        # Progress is written by AWAITING the DB update inside the capture loop, not by
        # fire-and-forget create_task(): a bare create_task reference isn't held anywhere, so the
        # task could be garbage-collected mid-flight and any DB error inside it was swallowed
        # silently — the UI then froze at the last count that happened to land while capture kept
        # running (the "stuck after 2-3 records" symptom). `discovered` is the running count of
        # result cards seen so far, so the bar shows real progress toward a known denominator
        # instead of "3/25" with no movement.
        async def _on_progress(captured: int, discovered: int, current: str | None) -> None:
            await ocr_jobs.set_ocr_counts(
                pool, job.id, captured=captured, total=discovered, current_business=current
            )

        engine = CaptureEngine(settings)
        manifest = await engine.run(
            query=job.query,
            location=job.location,
            max_results=job.max_results,
            expand_hours=job.expand_hours,
            job_id=str(job.id),
            job_dir=job_dir,
            started_at=datetime.now(UTC).isoformat(),
            center_lat=job.center_lat,
            center_lng=job.center_lng,
            radius_km=job.radius_km,
            resume_items=resume_items or None,
            on_progress=_on_progress,
            should_stop=(lambda: shutdown_event.is_set()) if shutdown_event is not None else None,
        )
        await ocr_jobs.set_ocr_counts(
            pool, job.id, total=len(manifest.items), captured=len(manifest.items)
        )
        log.info("ocr capture done", count=len(manifest.items), end_reason=manifest.end_reason)

        # --- Stage B: OCR + parse ---
        # Run up to settings.ocr_concurrency businesses' OCR concurrently (asyncio.to_thread puts
        # each Tesseract call on its own worker thread; the semaphore caps how many run at once).
        # Each individual Tesseract call stays single-threaded (OMP_THREAD_LIMIT=1) — that's the
        # separate, already-applied fix for a single image being 5.5x slower multi-threaded
        # internally. This is orthogonal: running N single-threaded calls in parallel across
        # businesses is what actually uses multiple CPU cores for the batch.
        await ocr_jobs.set_ocr_status(pool, job.id, "ocr")
        # RESUME: rows already in ocr_businesses (from a prior attempt on this same job — the
        # resumed manifest items above) already have real OCR'd/parsed data. Re-running them would
        # be safe (insert_ocr_business is idempotent) but wasteful — skip straight to the items
        # that genuinely still need Stage B.
        already_done = await ocr_jobs.get_ocr_done_indices(pool, job.id)
        pending_items = [it for it in manifest.items if it.index not in already_done]
        ocr_done = len(already_done)
        if already_done:
            log.info("skipping already-OCR'd items from prior attempt", count=len(already_done))
            await ocr_jobs.set_ocr_counts(pool, job.id, ocr_done=ocr_done)
        done_lock = asyncio.Lock()
        sem = asyncio.Semaphore(settings.ocr_concurrency)
        interrupted = False

        async def _process_one(item: CapturedItem) -> None:
            nonlocal ocr_done, interrupted
            async with sem:
                if shutdown_event is not None and shutdown_event.is_set():
                    interrupted = True
                    return
                # Naming happens right before the (slow) OCR call starts, same as Stage A, so the
                # status line reflects real in-flight work rather than the last-finished item.
                await ocr_jobs.set_ocr_counts(pool, job.id, current_business=item.name)
                try:
                    ocr_result = await asyncio.to_thread(
                        merge_segments, item.images, job_dir, job.langs, settings.tesseract_cmd
                    )
                    parsed = parse_fields.parse_business(
                        item.index,
                        item.name,
                        item.maps_url,
                        item.images,
                        ocr_result,
                        expand_hours=job.expand_hours,
                        dom=item.dom,
                        lat=item.lat,
                        lng=item.lng,
                        distance_km=item.distance_km,
                    )
                    await ocr_jobs.insert_ocr_business(pool, job.id, parsed)
                except Exception as exc:  # noqa: BLE001 - one bad image set must not abort the job
                    log.warning("ocr parse failed for item", name=item.name, error=str(exc))
                async with done_lock:
                    ocr_done += 1
                    await ocr_jobs.set_ocr_counts(pool, job.id, ocr_done=ocr_done)

        await asyncio.gather(*(_process_one(item) for item in pending_items))

        if interrupted:
            await ocr_jobs.finish_ocr_job(
                pool,
                job.id,
                "failed",
                end_reason="error",
                error_message="Interrupted by worker shutdown — relaunch the job.",
            )
            log.info("ocr job interrupted mid-OCR — marked failed for relaunch")
            return

        # Read back from the DB rather than accumulating this run's results in memory — on a
        # resumed retry that's the only place the FULL set (prior attempt's rows + this run's new
        # ones) exists together. default=str handles the UUID/datetime columns.
        results = await ocr_jobs.list_ocr_business_rows(pool, job.id)
        await ocr_jobs.set_ocr_status(pool, job.id, "parsing")
        (job_dir / "results.json").write_text(
            json.dumps(results, indent=2, default=str), encoding="utf-8"
        )

        await ocr_jobs.finish_ocr_job(pool, job.id, "ready", end_reason=manifest.end_reason)
        log.info("ocr job ready", rows=len(results))

    except CaptureInterruptedError:
        await ocr_jobs.finish_ocr_job(
            pool,
            job.id,
            "failed",
            end_reason="error",
            error_message="Interrupted by worker shutdown — relaunch the job.",
        )
        log.info("ocr job interrupted mid-capture — marked failed for relaunch")
    except CaptureBlockedError as exc:
        await ocr_jobs.finish_ocr_job(
            pool, job.id, "blocked", end_reason="blocked", error_message=str(exc)[:500]
        )
        log.warning("ocr job blocked", error=str(exc))
    except Exception as exc:  # noqa: BLE001 - a crashed job must still reach a terminal DB state
        await ocr_jobs.finish_ocr_job(
            pool, job.id, "failed", end_reason="error", error_message=str(exc)[:500]
        )
        log.error("ocr job failed", error=str(exc))
