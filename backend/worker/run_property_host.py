"""Authored by: Mohit Singh

Host-only runner for the Property Research module (dubizzle.com + propertyfinder.ae).

Both platforms block plain headless Chromium — dubizzle returns an empty-body HTTP 200, and
propertyfinder returns a bare HTTP 403, both confirmed 2026-08-22, while loading fully through the
operator's real Chrome attached over CDP. Unlike the ecom module (where amazon runs headless in
the container and only noon/AliExpress need this), EVERY platform in this module needs CDP — so
there is no container-daemon claimant for property jobs at all, only this runner. It claims
whatever's queued unconditionally (no platform partitioning needed, unlike run_noon_host.py, since
there's only ever one runner group for this whole module).

WINDOWS EVENT-LOOP CATCH-22 (why the DB goes through a sync shim here): identical situation to
run_noon_host.py — Playwright's async driver needs the Proactor loop on Windows; psycopg's async
pool refuses it (needs Selector). This runner uses the SAME `_SyncPoolShim` pattern (duplicated
rather than shared, matching this project's hard module-separation convention — property/ imports
nothing from ecom/ and vice versa).

Usage (from backend/worker, with the venv active):

    1. Start Chrome with a debug port (helper: scripts/start-property-host.bat does this and
       runs this script for you):
         chrome.exe --remote-debugging-port=9222 --user-data-dir=<a scratch dir>
    2. Queue a job from the /property-crawl UI (platform=dubizzle or propertyfinder) as normal.
    3. Run this, pointing it at the containerized DB (host port) and that Chrome:
         DATABASE_URL="postgresql://postgres:1234@localhost:5436/master_db_crawler" \
         PROPERTY_CDP_URL="http://localhost:9222" \
         python run_property_host.py

Results appear in the same frontend.
"""

from __future__ import annotations

import asyncio
import os
from types import TracebackType
from typing import Any

import psycopg
from psycopg.rows import dict_row

from business_scout_worker.logging_config import get_logger
from business_scout_worker.property import jobs as property_jobs
from business_scout_worker.property import pipeline as property_pipeline
from business_scout_worker.settings import load_settings

logger = get_logger("property_host_runner")


# --- sync-psycopg shim presenting the async-pool surface property/jobs.py needs -----------------
# Deliberately duplicated from run_noon_host.py's identical shim rather than shared — this module
# imports nothing from ecom/, matching the project's hard module-separation convention.


class _SyncCursor:
    def __init__(self, cur: psycopg.Cursor[Any]) -> None:
        self._cur = cur

    async def fetchone(self) -> Any:
        return await asyncio.to_thread(self._cur.fetchone)

    async def fetchall(self) -> list[Any]:
        return await asyncio.to_thread(self._cur.fetchall)


class _SyncConn:
    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self._conn = conn

    async def execute(self, sql: Any, params: Any = None) -> _SyncCursor:
        cur = await asyncio.to_thread(self._conn.execute, sql, params)
        return _SyncCursor(cur)


class _SyncConnCtx:
    def __init__(self, conninfo: str) -> None:
        self._conninfo = conninfo
        self._conn: psycopg.Connection[Any] | None = None

    async def __aenter__(self) -> _SyncConn:
        conn = await asyncio.to_thread(psycopg.connect, self._conninfo, row_factory=dict_row)
        self._conn = conn
        return _SyncConn(conn)

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> bool:
        conn = self._conn
        if conn is None:
            return False

        def _finish() -> None:
            try:
                if exc_type is None:
                    conn.commit()
                else:
                    conn.rollback()
            finally:
                conn.close()

        await asyncio.to_thread(_finish)
        return False


class _SyncPoolShim:
    def __init__(self, conninfo: str) -> None:
        self._conninfo = conninfo

    async def open(self) -> None:
        return None

    async def close(self) -> None:
        return None

    def connection(self) -> _SyncConnCtx:
        return _SyncConnCtx(self._conninfo)


async def _run() -> int:
    settings = load_settings()
    if not settings.property_cdp_url:
        raise SystemExit(
            "PROPERTY_CDP_URL is not set. Start Chrome with --remote-debugging-port=9222 and run "
            "with PROPERTY_CDP_URL=http://localhost:9222 (see this file's module docstring)."
        )
    logger.info("property host runner starting", cdp_url=settings.property_cdp_url)

    pool: Any = _SyncPoolShim(settings.database_url)
    await pool.open()
    claimed = 0
    try:
        recovered = await property_jobs.recover_orphaned_property_jobs(pool)
        if recovered:
            logger.info("recovered orphaned property jobs", count=recovered)

        while True:
            job = await property_jobs.claim_pending_property_job(pool)
            if job is None:
                break
            logger.info(
                "property job claimed",
                property_job_id=str(job.id),
                platform=job.platform,
                location=job.location,
            )
            await property_pipeline.run_property_job(pool, job, settings)
            claimed += 1
    finally:
        await pool.close()

    if claimed == 0:
        logger.info("no queued property jobs to run — nothing to do")
    else:
        logger.info("property host runner done", jobs_run=claimed)
    return claimed


async def _watch(poll_seconds: float) -> None:
    """Long-running mode: drain the queue, then poll every `poll_seconds` for new jobs, forever.
    Resilient — a transient DB/Chrome error in one cycle is logged and the loop continues."""
    logger.info("property host WATCH mode starting", poll_seconds=poll_seconds)
    while True:
        try:
            await _run()
        except SystemExit:
            raise  # config error (e.g. PROPERTY_CDP_URL unset) — genuinely fatal, don't loop on it
        except Exception as exc:  # noqa: BLE001 - one bad cycle must not kill the watcher
            logger.warning("watch cycle failed, will retry", error=str(exc))
        await asyncio.sleep(poll_seconds)


def main() -> None:
    watch = os.getenv("PROPERTY_HOST_WATCH", "").strip().lower() in ("1", "true", "yes", "on")
    if watch:
        poll_seconds = float(os.getenv("PROPERTY_HOST_POLL_SECONDS", "15"))
        asyncio.run(_watch(poll_seconds))
    else:
        asyncio.run(_run())


if __name__ == "__main__":
    main()
