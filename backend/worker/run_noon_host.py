"""Authored by: Mohit Singh

Host-only runner for REQUIRES_CDP e-commerce platforms (noon.com today).

noon.com's Akamai edge resets every automated-launch browser transport (HTTP/2, HTTP/1.1,
QUIC, DoH+ECH, even the real-Chrome channel) — confirmed 2026-08-07. The ONLY path that reaches
noon is attaching over the DevTools protocol (CDP) to the operator's already-running real Chrome,
which the site treats as a normal browser. That can't happen inside the headless container (no
Chrome there, and Chrome refuses CDP from a non-localhost Host), so noon jobs are handled here,
on the host, instead of by the containerized daemon.

This runner claims ONLY REQUIRES_CDP-platform jobs (the container daemon excludes exactly those,
so there is no double-claim race), runs them through the SAME async pipeline as every other ecom
job (writing to the same DB the frontend reads), and exits when the queue is drained.

WINDOWS EVENT-LOOP CATCH-22 (why the DB goes through a sync shim here):
Playwright's async driver spawns a subprocess, which on Windows works ONLY on the Proactor event
loop; psycopg's async pool REFUSES the Proactor loop (it needs Selector). The two cannot share one
loop. The Linux container never hits this (both work there). On the host we therefore run the
pipeline on the default Proactor loop (Playwright happy) and route every DB call through SYNC
psycopg on a worker thread (via asyncio.to_thread) — the `_SyncPoolShim` below presents exactly the
tiny async-pool surface ecom/jobs.py uses, so the shared pipeline/jobs code runs UNCHANGED.

Usage (from backend/worker, with the venv active):

    1. Start Chrome with a debug port (helper: scripts/start-noon-chrome.bat):
         chrome.exe --remote-debugging-port=9222 --user-data-dir=<a scratch dir>
    2. Queue a noon job from the /ecom-crawl UI (platform=noon) as normal.
    3. Run this, pointing it at the containerized DB (host port) and that Chrome:
         DATABASE_URL="postgresql://postgres:1234@localhost:5436/master_db_crawler" \
         ECOM_CDP_URL="http://localhost:9222" \
         python run_noon_host.py

Results appear in the same frontend, indistinguishable from a container-run amazon job.
"""

from __future__ import annotations

import asyncio
import os
from types import TracebackType
from typing import Any

import psycopg
from psycopg.rows import dict_row

from business_scout_worker.ecom import jobs as ecom_jobs
from business_scout_worker.ecom import pipeline as ecom_pipeline
from business_scout_worker.ecom.adapters import cdp_required_platforms
from business_scout_worker.logging_config import get_logger
from business_scout_worker.settings import load_settings

logger = get_logger("noon_host_runner")


# --- sync-psycopg shim presenting the async-pool surface ecom/jobs.py needs ---------------------
# Only pool.connection() (async ctx mgr) -> conn.execute() -> cursor.fetchone()/fetchall() are used
# (verified against ecom/jobs.py — no rowcount/executemany/explicit commit). Each connection()
# opens a fresh sync connection and commits on clean exit / rolls back on error, matching the async
# pool's per-context transaction semantics.


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

    async def open(self) -> None:  # nothing to pre-open — connections are per-context
        return None

    async def close(self) -> None:
        return None

    def connection(self) -> _SyncConnCtx:
        return _SyncConnCtx(self._conninfo)


async def _run() -> int:
    settings = load_settings()
    if not settings.ecom_cdp_url:
        raise SystemExit(
            "ECOM_CDP_URL is not set. Start Chrome with --remote-debugging-port=9222 and run "
            "with ECOM_CDP_URL=http://localhost:9222 (see this file's module docstring)."
        )
    platforms = cdp_required_platforms()
    logger.info(
        "noon host runner starting", cdp_url=settings.ecom_cdp_url, platforms=sorted(platforms)
    )

    # The shared pipeline/jobs code is fully typed against AsyncConnectionPool; the shim is a
    # structural (duck-typed) stand-in exercising the same async surface — cast so the reuse is
    # honest to the reader without loosening jobs.py's real signature.
    pool: Any = _SyncPoolShim(settings.database_url)
    await pool.open()
    claimed = 0
    try:
        # Recover ONLY our own kind (CDP platforms) — a prior host run that crashed mid-capture
        # leaves a noon job stuck 'capturing' that nothing else will ever clean up (the container
        # deliberately never touches noon). Never recover non-CDP jobs — the container may be
        # running one right now.
        recovered = await ecom_jobs.recover_orphaned_ecom_jobs(pool, only_platforms=platforms)
        if recovered:
            logger.info("recovered orphaned CDP-platform jobs", count=recovered)

        while True:
            job = await ecom_jobs.claim_pending_ecom_job(pool, only_platforms=platforms)
            if job is None:
                break
            logger.info(
                "cdp job claimed", ecom_job_id=str(job.id), platform=job.platform, query=job.query
            )
            await ecom_pipeline.run_ecom_job(pool, job, settings)
            claimed += 1
    finally:
        await pool.close()

    if claimed == 0:
        logger.info("no queued CDP-platform jobs to run — nothing to do")
    else:
        logger.info("noon host runner done", jobs_run=claimed)
    return claimed


async def _watch(poll_seconds: float) -> None:
    """Long-running mode: drain the CDP-platform queue, then poll every `poll_seconds` for new
    jobs, forever. Started automatically alongside the stack (scripts/start-noon-host.bat) so noon
    jobs process without a manual run. Resilient — a transient DB/Chrome error in one cycle is
    logged and the loop continues (so a briefly-closed debug Chrome doesn't kill the watcher)."""
    logger.info("noon host WATCH mode starting", poll_seconds=poll_seconds)
    while True:
        try:
            await _run()
        except SystemExit:
            raise  # config error (e.g. ECOM_CDP_URL unset) — genuinely fatal, don't loop on it
        except Exception as exc:  # noqa: BLE001 - one bad cycle must not kill the watcher
            logger.warning("watch cycle failed, will retry", error=str(exc))
        await asyncio.sleep(poll_seconds)


def main() -> None:
    # Default (Proactor) loop is REQUIRED here for Playwright's subprocess driver; the DB goes
    # through the sync shim above precisely so we DON'T need psycopg's Selector-only async loop.
    # ECOM_HOST_WATCH=1 turns this from a one-shot drain into a poll-forever daemon (the mode the
    # host launcher uses so noon jobs run automatically); default stays one-shot for manual runs.
    watch = os.getenv("ECOM_HOST_WATCH", "").strip().lower() in ("1", "true", "yes", "on")
    if watch:
        poll_seconds = float(os.getenv("ECOM_HOST_POLL_SECONDS", "15"))
        asyncio.run(_watch(poll_seconds))
    else:
        asyncio.run(_run())


if __name__ == "__main__":
    main()
