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
from business_scout_worker.ocr.models import CapturedItem, OcrJob
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
        results_by_index: dict[int, dict[str, object]] = {}
        ocr_done = 0
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
                    )
                    await ocr_jobs.insert_ocr_business(pool, job.id, parsed)
                    results_by_index[item.index] = parsed.model_dump()
                except Exception as exc:  # noqa: BLE001 - one bad image set must not abort the job
                    log.warning("ocr parse failed for item", name=item.name, error=str(exc))
                async with done_lock:
                    ocr_done += 1
                    await ocr_jobs.set_ocr_counts(pool, job.id, ocr_done=ocr_done)

        await asyncio.gather(*(_process_one(item) for item in manifest.items))

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

        results = [results_by_index[i] for i in sorted(results_by_index)]
        await ocr_jobs.set_ocr_status(pool, job.id, "parsing")
        (job_dir / "results.json").write_text(json.dumps(results, indent=2), encoding="utf-8")

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
