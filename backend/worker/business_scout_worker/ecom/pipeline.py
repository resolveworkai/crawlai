"""Authored by: Mohit Singh

E-commerce Product Research job orchestrator — the daemon runs this when it claims an ecom_jobs
row. Drives the state machine capturing -> ocr -> parsing -> [detail ->] ready (or blocked/
failed), mirroring ocr/pipeline.py's shape/guarantees (best-effort per item, terminal DB state
always set) but SEPARATE code: own capture engine (ecom/capture.py), own OCR-fallback parser
(ecom/parse_product.py), own scoring (ecom/analysis.py), own DB access (ecom/jobs.py).
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import cast

from psycopg_pool import AsyncConnectionPool

from business_scout_worker.ecom import jobs as ecom_jobs
from business_scout_worker.ecom import parse_product
from business_scout_worker.ecom.adapters import get_adapter
from business_scout_worker.ecom.analysis import compute_opportunity_scores
from business_scout_worker.ecom.capture import (
    EcomBlockedError,
    EcomCaptureEngine,
    EcomInterruptedError,
)
from business_scout_worker.ecom.models import CapturedProduct, EcomJob, EcomManifest, ParsedProduct
from business_scout_worker.logging_config import get_logger
from business_scout_worker.ocr.ocr_engine import merge_segments
from business_scout_worker.settings import Settings

logger = get_logger(__name__)

# A product "has enough DOM fields" when the card exposed title+price+rating+review_count all —
# anything short of that runs through the OCR fallback in Stage B.
_REQUIRED_DOM_FIELDS = ("title", "price", "rating", "review_count")


def _dom_is_complete(product: CapturedProduct) -> bool:
    dom = product.dom
    return all(
        (getattr(dom, f, None) is not None) or (f == "title" and product.title)
        for f in _REQUIRED_DOM_FIELDS
    )


async def run_ecom_job(
    pool: AsyncConnectionPool,
    job: EcomJob,
    settings: Settings,
    shutdown_event: asyncio.Event | None = None,
) -> None:
    log = logger.bind(ecom_job_id=str(job.id), platform=job.platform, query=job.query)
    job_dir = Path(settings.ecom_captures_dir) / str(job.id)
    try:
        job_dir.mkdir(parents=True, exist_ok=True)
        await ecom_jobs.set_ecom_status(pool, job.id, "capturing", storage_dir=str(job.id))
        await ecom_jobs.write_log(
            pool, job.id, "info", f"Product research job started: {job.query} on {job.platform}"
        )

        adapter = get_adapter(job.platform)

        # RETRY / RESUME: a manifest.json already on disk means a prior attempt on this exact job
        # got partway through Stage A before failing/blocking — reload what it already captured so
        # those products are never re-navigated or re-captured.
        manifest_path = job_dir / "manifest.json"
        resume_items: list[CapturedProduct] = []
        if manifest_path.exists():
            try:
                prior = EcomManifest.model_validate_json(manifest_path.read_text("utf-8"))
                resume_items = prior.items
                log.info("resuming from prior manifest", already_captured=len(resume_items))
                await ecom_jobs.write_log(
                    pool,
                    job.id,
                    "info",
                    f"Resuming: {len(resume_items)} products already captured, skipping them",
                )
            except Exception as exc:  # noqa: BLE001 - a corrupt manifest must not block a retry
                log.warning("prior manifest unreadable, starting capture fresh", error=str(exc))

        # --- Stage A: capture ---
        log.info("ecom capture starting")

        async def _on_progress(captured: int, discovered: int, current: str | None) -> None:
            # Progress is written by AWAITING the DB update inside the capture loop (never a bare
            # fire-and-forget create_task) — see ocr/pipeline.py's design note on why a
            # fire-and-forget task can be garbage-collected mid-flight and silently swallow a
            # progress write, freezing the UI.
            await ecom_jobs.set_ecom_counts(
                pool, job.id, captured=captured, total=discovered, current_product=current
            )
            if current is not None:
                await ecom_jobs.write_log(
                    pool, job.id, "info", f"Capturing: {current} ({captured}/{discovered})"
                )

        engine = EcomCaptureEngine(adapter, settings, job_dir, str(job.id))
        should_stop = (lambda: shutdown_event.is_set()) if shutdown_event is not None else None
        manifest = await engine.run(
            query=job.query,
            sort=job.sort_mode,
            max_pages=job.max_pages,
            max_products=job.max_products,
            started_at=job.created_at.isoformat(),
            resume_items=resume_items or None,
            on_progress=_on_progress,
            should_stop=should_stop,
        )
        await ecom_jobs.set_ecom_counts(
            pool, job.id, total=len(manifest.items), captured=len(manifest.items)
        )
        log.info("ecom capture done", count=len(manifest.items), end_reason=manifest.end_reason)
        await ecom_jobs.write_log(
            pool,
            job.id,
            "info",
            f"Capture done: {len(manifest.items)} products ({manifest.end_reason})",
        )

        # --- Stage B: OCR fallback + parse ---
        await ecom_jobs.set_ecom_status(pool, job.id, "ocr")
        await ecom_jobs.write_log(pool, job.id, "info", "OCR fallback stage starting")
        already_done = await ecom_jobs.get_ecom_done_indices(pool, job.id)
        pending_items = [it for it in manifest.items if it.idx not in already_done]
        ocr_done = len(already_done)
        if already_done:
            log.info("skipping already-processed items from prior attempt", count=len(already_done))
            await ecom_jobs.set_ecom_counts(pool, job.id, ocr_done=ocr_done)
        done_lock = asyncio.Lock()
        sem = asyncio.Semaphore(settings.ocr_concurrency)
        interrupted = False
        parsed_by_idx: dict[int, ParsedProduct] = {}

        async def _process_one(item: CapturedProduct) -> None:
            nonlocal ocr_done, interrupted
            async with sem:
                if shutdown_event is not None and shutdown_event.is_set():
                    interrupted = True
                    return
                await ecom_jobs.set_ecom_counts(pool, job.id, current_product=item.title)
                try:
                    if _dom_is_complete(item) or not item.images:
                        parsed = parse_product.parse_product(
                            [],
                            idx=item.idx,
                            title=item.title,
                            product_url=item.product_url,
                            image_url=item.image_url,
                            page_num=item.page_num,
                            dom=item.dom,
                            default_currency=adapter.default_currency,
                        )
                        parsed.source_images = item.images
                    else:
                        ocr_result = await asyncio.to_thread(
                            merge_segments, item.images, job_dir, "eng", settings.tesseract_cmd
                        )
                        parsed = parse_product.parse_product(
                            ocr_result.lines,
                            idx=item.idx,
                            title=item.title,
                            product_url=item.product_url,
                            image_url=item.image_url,
                            page_num=item.page_num,
                            ocr=ocr_result,
                            dom=item.dom,
                            default_currency=adapter.default_currency,
                        )
                        parsed.source_images = item.images
                    parsed_by_idx[item.idx] = parsed
                except Exception as exc:  # noqa: BLE001 - one bad item must not abort the job
                    log.warning("parse failed for item", title=item.title, error=str(exc))
                async with done_lock:
                    ocr_done += 1
                    await ecom_jobs.set_ecom_counts(pool, job.id, ocr_done=ocr_done)

        await asyncio.gather(*(_process_one(item) for item in pending_items))

        if interrupted:
            await ecom_jobs.finish_ecom_job(
                pool,
                job.id,
                "failed",
                end_reason="error",
                error_message="Interrupted by worker shutdown — relaunch the job.",
            )
            await ecom_jobs.write_log(
                pool, job.id, "warn", "Job interrupted by worker shutdown mid-OCR"
            )
            log.info("ecom job interrupted mid-OCR — marked failed for relaunch")
            return

        # --- Stage C: parsing (finalize + score) ---
        await ecom_jobs.set_ecom_status(pool, job.id, "parsing")
        await ecom_jobs.write_log(pool, job.id, "info", "Scoring products")
        new_products = list(parsed_by_idx.values())
        if new_products:
            weights = job.score_weights
            scores = compute_opportunity_scores(new_products, weights)
            for product, score in zip(new_products, scores, strict=True):
                product.opportunity_score = score
                await ecom_jobs.upsert_ecom_product(pool, job.id, product)

        # --- Stage D (optional): detail scrape for top-N ---
        end_reason = manifest.end_reason
        if job.detail_scrape_top_n > 0:
            await ecom_jobs.set_ecom_status(pool, job.id, "detail")
            await ecom_jobs.write_log(
                pool, job.id, "info", f"Detail scrape starting (top {job.detail_scrape_top_n})"
            )
            all_rows = await ecom_jobs.list_ecom_product_rows(pool, job.id)
            non_sponsored = [r for r in all_rows if not r.get("sponsored")]
            ranked = sorted(
                non_sponsored,
                key=lambda r: (r.get("rating") or 0.0, r.get("opportunity_score") or 0.0),
                reverse=True,
            )
            top_rows = ranked[: job.detail_scrape_top_n]
            top_products = [
                item for item in manifest.items if item.idx in {r["idx"] for r in top_rows}
            ]
            try:
                detail_results = await engine.capture_details(top_products, should_stop=should_stop)
            except EcomInterruptedError:
                await ecom_jobs.finish_ecom_job(
                    pool,
                    job.id,
                    "failed",
                    end_reason="error",
                    error_message="Interrupted by worker shutdown — relaunch the job.",
                )
                await ecom_jobs.write_log(
                    pool, job.id, "warn", "Job interrupted by worker shutdown mid-detail-scrape"
                )
                return

            detail_done = 0
            for row in top_rows:
                idx = cast(int, row["idx"])
                detail = detail_results.get(idx)
                if detail is None:
                    continue
                product = ParsedProduct.model_validate(row)
                product.description = cast("str | None", detail.get("description"))
                product.about_bullets = cast("list[str]", detail.get("about_bullets") or [])
                product.breadcrumb_category = cast("str | None", detail.get("breadcrumb_category"))
                product.seller_name = cast("str | None", detail.get("seller_name"))
                product.detail_scraped = True
                image = cast("str | None", detail.get("detail_image"))
                if image:
                    product.source_images = [*product.source_images, image]
                await ecom_jobs.upsert_ecom_product(pool, job.id, product)
                detail_done += 1
                await ecom_jobs.set_ecom_counts(pool, job.id, detail_done=detail_done)
            await ecom_jobs.write_log(
                pool, job.id, "info", f"Detail scrape done: {detail_done} products"
            )

        results = await ecom_jobs.list_ecom_product_rows(pool, job.id)
        (job_dir / "results.json").write_text(
            json.dumps(results, indent=2, default=str), encoding="utf-8"
        )

        await ecom_jobs.finish_ecom_job(pool, job.id, "ready", end_reason=end_reason)
        await ecom_jobs.write_log(pool, job.id, "info", f"Job ready: {len(results)} products")
        log.info("ecom job ready", rows=len(results))

    except EcomInterruptedError:
        await ecom_jobs.finish_ecom_job(
            pool,
            job.id,
            "failed",
            end_reason="error",
            error_message="Interrupted by worker shutdown — relaunch the job.",
        )
        await ecom_jobs.write_log(
            pool, job.id, "warn", "Job interrupted by worker shutdown mid-capture"
        )
        log.info("ecom job interrupted mid-capture — marked failed for relaunch")
    except EcomBlockedError as exc:
        await ecom_jobs.finish_ecom_job(
            pool, job.id, "blocked", end_reason="blocked", error_message=str(exc)[:500]
        )
        await ecom_jobs.write_log(pool, job.id, "warn", f"Job blocked: {str(exc)[:200]}")
        log.warning("ecom job blocked", error=str(exc))
    except Exception as exc:  # noqa: BLE001 - a crashed job must still reach a terminal DB state
        await ecom_jobs.finish_ecom_job(
            pool, job.id, "failed", end_reason="error", error_message=str(exc)[:500]
        )
        await ecom_jobs.write_log(pool, job.id, "error", f"Job failed: {str(exc)[:200]}")
        log.error("ecom job failed", error=str(exc))
