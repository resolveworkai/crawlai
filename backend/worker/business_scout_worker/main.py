"""Authored by: Mohit Singh"""

import asyncio
import contextlib
import signal
import sys

import psycopg

from business_scout_worker import pipeline
from business_scout_worker.db import create_pool, ping_database
from business_scout_worker.enrich import tier2
from business_scout_worker.jobs import claim_pending_job
from business_scout_worker.logging_config import configure_logging, get_logger
from business_scout_worker.ocr import pipeline as ocr_pipeline
from business_scout_worker.ocr.jobs import claim_pending_ocr_job, recover_orphaned_ocr_jobs
from business_scout_worker.settings import load_settings

# psycopg3's async mode cannot run on Windows' default ProactorEventLoop — it needs
# SelectorEventLoop. Irrelevant in the Linux Docker container (the only place this daemon
# actually deploys), but required for local Windows dev. See
# .claude/skills/skills_backend_python.md "Windows local dev".
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


async def _listen_loop(conninfo: str, wake_event: asyncio.Event, stop_event: asyncio.Event) -> None:
    """A dedicated (non-pooled) autocommit connection for LISTEN — a pooled connection could
    be handed back and reused for an unrelated query mid-session, silently dropping the LISTEN.
    NOTIFY is not persisted (lost entirely if this connection drops), which is exactly why the
    main loop *also* does a periodic pending-sweep independent of this — see run()."""
    logger = get_logger(__name__)
    while not stop_event.is_set():
        try:
            async with await psycopg.AsyncConnection.connect(conninfo, autocommit=True) as conn:
                await conn.execute("LISTEN crawl_jobs")
                await conn.execute("LISTEN ocr_crawl_jobs")  # Crawl-OCR module shares this daemon
                async for _notify in conn.notifies():
                    wake_event.set()
                    if stop_event.is_set():
                        return
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 - reconnect rather than kill the daemon
            logger.warning("listen connection dropped, reconnecting", error=str(exc))
            if not stop_event.is_set():
                await asyncio.sleep(2)


async def run() -> None:
    settings = load_settings()
    configure_logging(settings)
    logger = get_logger(__name__)
    logger.info("worker starting", environment=settings.environment)

    pool = create_pool(settings)
    await pool.open()

    stop_event = asyncio.Event()
    wake_event = asyncio.Event()

    def _handle_stop(signum: int, _frame: object) -> None:
        logger.info("shutdown signal received", signum=signum)
        stop_event.set()
        wake_event.set()

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, _handle_stop)

    listen_task = asyncio.create_task(_listen_loop(settings.database_url, wake_event, stop_event))

    try:
        healthy = await ping_database(pool)
        logger.info("startup heartbeat", database_healthy=healthy)

        # Self-heal OCR jobs orphaned in a running state by a previous hard restart (they'd
        # otherwise spin forever — the claim query only takes 'queued'). See ocr/jobs.py.
        recovered = await recover_orphaned_ocr_jobs(pool)
        if recovered:
            logger.info("recovered orphaned ocr jobs", count=recovered)

        while not stop_event.is_set():
            job = await claim_pending_job(pool)
            if job is not None:
                logger.info(
                    "job claimed",
                    job_id=str(job.id),
                    business_type=job.business_type,
                )
                await pipeline.run_job(pool, job, settings, shutdown_event=stop_event)
                continue  # check immediately for another pending job — no need to wait

            # Crawl-OCR jobs share this daemon (parallel job type, separate table + channel).
            ocr_job = await claim_pending_ocr_job(pool)
            if ocr_job is not None:
                logger.info("ocr job claimed", ocr_job_id=str(ocr_job.id), query=ocr_job.query)
                await ocr_pipeline.run_ocr_job(pool, ocr_job, settings, shutdown_event=stop_event)
                continue

            wake_event.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(wake_event.wait(), timeout=settings.poll_interval_seconds)
    finally:
        logger.info("worker stopping")
        listen_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await listen_task
        await tier2.close_browser()  # no-op if Tier-2 was never actually used this run
        await pool.close()


def main() -> None:
    asyncio.run(run())


if __name__ == "__main__":
    main()
