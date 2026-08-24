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

from business_scout_worker.chrome_health import ensure_chrome_running, write_heartbeat
from business_scout_worker.logging_config import configure_logging, get_logger
from business_scout_worker.property import jobs as property_jobs
from business_scout_worker.property import pipeline as property_pipeline
from business_scout_worker.property import refresh as property_refresh
from business_scout_worker.property.adapters import cdp_required_platforms
from business_scout_worker.settings import Settings, load_settings

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


async def _drain_platform_jobs(pool: Any, platform: str, settings: Settings) -> int:
    """Claims and runs every currently-queued job for ONE platform, one at a time, to completion,
    then returns. Used by the one-shot `_run()` path (PROPERTY_HOST_WATCH unset — drain what's
    queued right now, then exit) — NOT by `_watch()` mode, which uses the persistent
    `_drain_platform_forever` below instead (see its own docstring for why: this one-shot-then-
    return shape is exactly what caused a real starvation bug in long-running watch mode)."""
    claimed = 0
    while True:
        job = await property_jobs.claim_pending_property_job(pool, platform)
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
    return claimed


async def _drain_platform_forever(
    pool: Any, platform: str, settings: Settings, cdp_url: str, poll_seconds: float
) -> None:
    """WATCH-mode platform loop (2026-08-24) — runs forever, independent of every OTHER platform's
    own loop. Fixes a real starvation bug: the previous design called `_drain_platform_jobs` (drain
    everything queued NOW, then return) for every platform via ONE `asyncio.gather()` per outer
    poll tick — and `gather()` doesn't return until ALL of them finish. A platform with a constant
    stream of new work (dubizzle, in practice) never let its own drain-loop return, so `gather()`
    never resolved, so the outer watch loop never got to re-invoke `_run()` and build a FRESH
    propertyfinder drain-loop — meanwhile propertyfinder's OWN loop had already exited (it checked
    once at startup, found nothing queued yet, returned) with nothing left to notice jobs queued
    moments later. Confirmed live: propertyfinder jobs sat 'queued' for 50+ minutes while dubizzle
    processed job after job back-to-back, and the host runner's own log never mentioned
    "propertyfinder" once in that whole window.
    This loop never returns while the process is alive — it just re-checks THIS platform's own
    queue every `poll_seconds` (immediately, no sleep, right after finishing a job — to drain the
    rest of its own backlog without delay) regardless of what any other platform's loop is doing.
    Chrome-health-gated per iteration (ensure_chrome_running is documented safe to call
    concurrently from multiple tasks — the noon+property dual-runner race is the same shape)."""
    while True:
        try:
            chrome_ok = await ensure_chrome_running(
                cdp_url=cdp_url,
                launch_url="https://dubai.dubizzle.com/en/property-for-sale/residential/apartment/",
                runner_name="property",
                chrome_exe_override=settings.chrome_exe_path,
                user_data_dir_override=settings.chrome_user_data_dir,
                auto_restart=settings.chrome_auto_restart,
            )
            if not chrome_ok:
                await asyncio.sleep(poll_seconds)
                continue
            job = await property_jobs.claim_pending_property_job(pool, platform)
            if job is None:
                await asyncio.sleep(poll_seconds)
                continue
            logger.info(
                "property job claimed",
                property_job_id=str(job.id),
                platform=job.platform,
                location=job.location,
            )
            await property_pipeline.run_property_job(pool, job, settings)
            # No sleep — immediately re-check for more of THIS platform's own backlog.
        except Exception as exc:  # noqa: BLE001 - one bad job/cycle must not kill this platform's loop
            logger.warning(
                "platform drain loop error, will retry", platform=platform, error=str(exc)
            )
            await asyncio.sleep(poll_seconds)


async def _housekeeping_forever(
    pool: Any, settings: Settings, cdp_url: str, poll_seconds: float
) -> None:
    """WATCH-mode housekeeping loop (2026-08-24) — runs forever, alongside the per-platform loops
    above, doing everything that ISN'T "claim and run a search job": heartbeat + draining
    single-listing refresh requests. Deliberately does NOT include orphan recovery
    (recover_orphaned_property_jobs) — that function unconditionally marks EVERY row currently
    'capturing'/'parsing'/'detail'/'scoring' as failed, which is only safe to call ONCE, at true
    process startup before any job has been claimed by this process — calling it on a repeating
    interval would kill every legitimately-still-running job within one poll tick. See _watch()'s
    own call site for where that one-time call actually happens."""
    while True:
        try:
            chrome_ok = await ensure_chrome_running(
                cdp_url=cdp_url,
                launch_url="https://dubai.dubizzle.com/en/property-for-sale/residential/apartment/",
                runner_name="property",
                chrome_exe_override=settings.chrome_exe_path,
                user_data_dir_override=settings.chrome_user_data_dir,
                auto_restart=settings.chrome_auto_restart,
            )
            await write_heartbeat(
                pool,
                "property",
                cdp_reachable=chrome_ok,
                last_error=None if chrome_ok else "Chrome/CDP unreachable at last poll",
            )
            if chrome_ok:
                while True:
                    listing_refresh = await property_jobs.claim_pending_listing_refresh(pool)
                    if listing_refresh is None:
                        break
                    logger.info(
                        "listing refresh claimed",
                        refresh_id=str(listing_refresh.id),
                        listing_id=str(listing_refresh.listing_id),
                    )
                    await property_refresh.run_listing_refresh(pool, listing_refresh, settings)
        except Exception as exc:  # noqa: BLE001 - one bad housekeeping tick must not kill the loop
            logger.warning("housekeeping tick failed, will retry", error=str(exc))
        await asyncio.sleep(poll_seconds)


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
        # Health-check + best-effort self-heal BEFORE claiming anything (2026-08-23,
        # chrome_health.py) — claiming a job then having it immediately fail with ECONNREFUSED
        # burns a real attempt (and, for a job, its retry count) over what's often just Chrome
        # having been closed for a moment. Checking first means a transient outage costs nothing
        # more than one poll cycle's delay, and the heartbeat written either way is what lets the
        # API/UI show "runner not responding" instead of a silently stuck queue.
        chrome_ok = await ensure_chrome_running(
            cdp_url=settings.property_cdp_url,
            launch_url="https://dubai.dubizzle.com/en/property-for-sale/residential/apartment/",
            runner_name="property",
            chrome_exe_override=settings.chrome_exe_path,
            user_data_dir_override=settings.chrome_user_data_dir,
            auto_restart=settings.chrome_auto_restart,
        )
        await write_heartbeat(
            pool,
            "property",
            cdp_reachable=chrome_ok,
            last_error=None if chrome_ok else "Chrome/CDP unreachable at last poll",
        )
        if not chrome_ok:
            logger.warning("skipping this poll cycle — chrome/CDP unreachable")
            return 0

        recovered = await property_jobs.recover_orphaned_property_jobs(pool)
        if recovered:
            logger.info("recovered orphaned property jobs", count=recovered)

        # Refreshes drained FIRST, every cycle — they're a single quick page visit each (unlike a
        # whole search job, which can run for minutes), and this runner only ever has one browser
        # session, so a refresh can never actually run concurrently with an in-progress job's own
        # navigation regardless of ordering. Draining them first just means a refresh queued while
        # a job is mid-run gets picked up on the very next poll tick after that job finishes,
        # rather than waiting for any OTHER already-queued jobs to drain too.
        while True:
            listing_refresh = await property_jobs.claim_pending_listing_refresh(pool)
            if listing_refresh is None:
                break
            logger.info(
                "listing refresh claimed",
                refresh_id=str(listing_refresh.id),
                listing_id=str(listing_refresh.listing_id),
            )
            await property_refresh.run_listing_refresh(pool, listing_refresh, settings)
            claimed += 1

        # One platform loop PER platform, run CONCURRENTLY (2026-08-23) — dubizzle and
        # propertyfinder are independent sites, each captured through its own Playwright Page
        # within the same Chrome (see PropertyCaptureEngine._open_context — connect_over_cdp then
        # context.new_page(), never a shared Page), so a running dubizzle job has no reason to
        # block a queued propertyfinder job from starting. Two jobs on the SAME platform still
        # can't run concurrently — claim_pending_property_job's per-platform WHERE clause plus the
        # DB's own per-platform partial unique index are what enforce that, this gather() is just
        # what lets DIFFERENT platforms overlap in the first place.
        platform_counts = await asyncio.gather(
            *(
                _drain_platform_jobs(pool, platform, settings)
                for platform in cdp_required_platforms()
            )
        )
        claimed += sum(platform_counts)
    finally:
        await pool.close()

    if claimed == 0:
        logger.info("no queued property jobs or refreshes to run — nothing to do")
    else:
        logger.info("property host runner done", units_run=claimed)
    return claimed


async def _watch(poll_seconds: float) -> None:
    """Long-running mode (2026-08-24 rewrite — see _drain_platform_forever's own docstring for the
    starvation bug this replaces): one persistent, independent loop PER platform (never re-created,
    runs for the life of the process) plus one shared housekeeping loop, all started together and
    run forever via asyncio.gather(). Each platform now genuinely can't starve another — a platform
    with a constant stream of new work keeps looping on its OWN cadence without ever blocking a
    DIFFERENT platform's own loop from noticing newly-queued work."""
    settings = load_settings()
    if not settings.property_cdp_url:
        raise SystemExit(
            "PROPERTY_CDP_URL is not set. Start Chrome with --remote-debugging-port=9222 and run "
            "with PROPERTY_CDP_URL=http://localhost:9222 (see this file's module docstring)."
        )
    cdp_url: str = settings.property_cdp_url  # narrowed here, passed explicitly below — see each
    # forever-loop's signature comment for why they take cdp_url separately from settings.
    logger.info("property host WATCH mode starting", poll_seconds=poll_seconds, cdp_url=cdp_url)

    pool: Any = _SyncPoolShim(settings.database_url)
    await pool.open()
    try:
        # ONE-TIME startup self-heal — must run exactly once, BEFORE any persistent platform loop
        # starts claiming, never on a repeating interval (see recover_orphaned_property_jobs's own
        # docstring + _housekeeping_forever's comment on why it deliberately doesn't call this).
        recovered = await property_jobs.recover_orphaned_property_jobs(pool)
        if recovered:
            logger.info("recovered orphaned property jobs", count=recovered)

        await asyncio.gather(
            _housekeeping_forever(pool, settings, cdp_url, poll_seconds),
            *(
                _drain_platform_forever(pool, platform, settings, cdp_url, poll_seconds)
                for platform in cdp_required_platforms()
            ),
        )
    finally:
        await pool.close()


def main() -> None:
    # Never called before this fix (2026-08-23) — this runner used structlog's un-configured
    # default the whole time, which is what let a real bug through: a location containing
    # non-ASCII text (e.g. Arabic) crashed the whole watch cycle trying to log it, on a Windows
    # launch that hadn't set PYTHONIOENCODING=utf-8 itself. configure_logging() now forces UTF-8
    # on stdout/stderr directly (see its own comment) — real, not just env-var-dependent.
    configure_logging(load_settings())
    watch = os.getenv("PROPERTY_HOST_WATCH", "").strip().lower() in ("1", "true", "yes", "on")
    if watch:
        poll_seconds = float(os.getenv("PROPERTY_HOST_POLL_SECONDS", "15"))
        asyncio.run(_watch(poll_seconds))
    else:
        asyncio.run(_run())


if __name__ == "__main__":
    main()
