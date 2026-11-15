"""Authored by: Mohit Singh

Shared CDP-health + Chrome auto-restart + heartbeat utility for every host runner in this project
(run_property_host.py, run_noon_host.py). Infra-level, not business logic — unlike property/ecom's
own capture/parse/pipeline code (which is deliberately NEVER shared between modules), this lives
at the top level alongside logging_config.py/settings.py because it's the same cross-cutting
concern for both: both host runners attach to the SAME physical operator Chrome window on the
same CDP port (by design — see scripts/start-noon-host.bat's own comment), so Chrome dying takes
every CDP-required platform down at once, and previously did so SILENTLY — a job just failed with
an ECONNREFUSED error_message and nothing else happened until a human noticed and manually re-ran
the launcher .bat.

This module gives each runner a way to (a) detect the outage, (b) best-effort self-heal by
relaunching Chrome with the exact same debug-port flags the launcher scripts use, and (c) write a
heartbeat row the Node API/frontend can read to show "runner not responding" in the UI instead of
a silent stuck queue.
"""

from __future__ import annotations

import asyncio
import os
import platform
import random
import subprocess
from pathlib import Path
from typing import Any

import httpx

from business_scout_worker.logging_config import get_logger

logger = get_logger(__name__)

_DEFAULT_CHROME_PATHS = (
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
)


def _resolve_chrome_exe(override: str | None) -> str | None:
    if override:
        return override
    for p in _DEFAULT_CHROME_PATHS:
        if Path(p).exists():
            return p
    return None


def _resolve_user_data_dir(override: str | None) -> str:
    if override:
        return override
    temp = os.environ.get("TEMP") or os.environ.get("TMP") or "."
    # Matches every scripts/start-*-host.bat's `%TEMP%\noon-cdp-chrome` exactly — an auto-restart
    # must attach to the SAME profile the operator's own launcher scripts use, not create a
    # second, conflicting one.
    return str(Path(temp) / "noon-cdp-chrome")


async def is_cdp_reachable(cdp_url: str, timeout_s: float = 3.0) -> bool:
    """A quick GET to Chrome's own DevTools version endpoint — the same check curl-ing
    `{cdp_url}/json/version` performs. Never raises; any failure (connection refused, timeout,
    DNS) just means "not reachable"."""
    try:
        async with httpx.AsyncClient(timeout=timeout_s) as client:
            resp = await client.get(f"{cdp_url.rstrip('/')}/json/version")
            return resp.status_code == 200
    except Exception:  # noqa: BLE001 - any transport failure means "not reachable"
        return False


def _launch_chrome(chrome_exe: str, user_data_dir: str, port: int, launch_url: str) -> None:
    subprocess.Popen(  # noqa: S603 - fixed, non-shell argv; chrome_exe/user_data_dir come from
        # trusted settings/env, never user/request input
        [
            chrome_exe,
            f"--remote-debugging-port={port}",
            f"--user-data-dir={user_data_dir}",
            "--no-first-run",
            "--no-default-browser-check",
            launch_url,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )


async def ensure_chrome_running(
    *,
    cdp_url: str,
    launch_url: str,
    runner_name: str,
    chrome_exe_override: str | None = None,
    user_data_dir_override: str | None = None,
    auto_restart: bool = True,
) -> bool:
    """Returns True if `cdp_url` is (or becomes) reachable. If not reachable and `auto_restart` is
    True, best-effort relaunches Chrome with the project's standard debug-port flags (matching
    scripts/start-*-host.bat exactly — same profile dir, same port — so it attaches to whatever's
    already there rather than creating a second conflicting profile). Windows-only (this project's
    host runners only ever run on the operator's Windows machine); a no-op elsewhere.

    A random jitter delay before actually launching, plus a re-check right after it, reduces (does
    not eliminate) the race where BOTH host runners notice Chrome is down at the same moment and
    both try to relaunch it — a second, redundant `chrome.exe --user-data-dir=<already-open-dir>`
    invocation just opens another window against the same profile, it doesn't corrupt anything,
    but the jitter+recheck means the common case is only one process actually launches it."""
    if await is_cdp_reachable(cdp_url):
        return True

    logger.warning("chrome CDP unreachable", runner=runner_name, cdp_url=cdp_url)
    if not auto_restart:
        return False

    if platform.system() != "Windows":
        logger.warning("chrome auto-restart is Windows-only, skipping", runner=runner_name)
        return False

    chrome_exe = _resolve_chrome_exe(chrome_exe_override)
    if chrome_exe is None:
        logger.warning(
            "chrome CDP unreachable and no chrome.exe found to auto-restart it — set "
            "CHROME_EXE_PATH if Chrome is installed somewhere non-standard",
            runner=runner_name,
        )
        return False

    await asyncio.sleep(random.uniform(0.2, 2.0))  # noqa: S311 - jitter, not security-sensitive
    if await is_cdp_reachable(cdp_url):
        return True  # the other host runner already won the race

    try:
        port = int(cdp_url.rsplit(":", 1)[-1].split("/")[0])
    except ValueError:
        logger.error("could not parse a port out of cdp_url", runner=runner_name, cdp_url=cdp_url)
        return False

    user_data_dir = _resolve_user_data_dir(user_data_dir_override)
    logger.warning(
        "attempting chrome auto-restart",
        runner=runner_name,
        chrome_exe=chrome_exe,
        user_data_dir=user_data_dir,
    )
    try:
        _launch_chrome(chrome_exe, user_data_dir, port, launch_url)
    except Exception as exc:  # noqa: BLE001 - a launch failure must not crash the watch loop
        logger.error("chrome auto-restart failed to launch", runner=runner_name, error=str(exc))
        return False

    for _ in range(10):
        await asyncio.sleep(1.0)
        if await is_cdp_reachable(cdp_url):
            logger.info("chrome auto-restart succeeded", runner=runner_name)
            return True
    logger.error(
        "chrome auto-restart launched a process but CDP is still unreachable after 10s",
        runner=runner_name,
    )
    return False


async def write_heartbeat(
    pool: Any,
    runner_name: str,
    *,
    cdp_reachable: bool,
    last_error: str | None = None,
) -> None:
    """Upserts this runner's own row — called once per poll cycle regardless of whether there was
    any work to do, so a stale `last_heartbeat_at` in host_runner_status means the PROCESS itself
    has died (crashed, or was never started), while a fresh heartbeat with `cdp_reachable=false`
    means the process is alive but Chrome is down. Best-effort: a DB hiccup writing the heartbeat
    must never crash the watch loop over a monitoring concern."""
    try:
        async with pool.connection() as conn:
            await conn.execute(
                """
                INSERT INTO host_runner_status
                    (runner_name, cdp_reachable, last_error, last_heartbeat_at)
                VALUES (%s, %s, %s, now())
                ON CONFLICT (runner_name) DO UPDATE SET
                    cdp_reachable = EXCLUDED.cdp_reachable,
                    last_error = EXCLUDED.last_error,
                    last_heartbeat_at = now()
                """,
                (runner_name, cdp_reachable, last_error),
            )
    except Exception as exc:  # noqa: BLE001 - heartbeat writes are best-effort
        logger.debug("heartbeat write failed", runner=runner_name, error=str(exc))


async def heartbeat_forever(pool: Any, runner_name: str, cdp_url: str, poll_seconds: float) -> None:
    """Heartbeat from its OWN always-running task, independent of whatever the runner is doing.

    The per-poll-cycle heartbeat above stops for as long as a job runs (a noon crawl can take many
    minutes inside one cycle), so the dashboard banner cried "hasn't checked in" at a perfectly
    healthy, busy runner — and anything supervising the runner (scripts/host-watchdog.ps1) could
    not tell "busy" from "hung". Run as a background task, this keeps `last_heartbeat_at` fresh for
    exactly as long as the runner's event loop is alive, so a stale heartbeat now genuinely means
    the process is dead or wedged. It only reports reachability (a plain GET) and never relaunches
    Chrome — that stays with the between-jobs ensure_chrome_running, so a heartbeat tick can never
    race a running job over the browser. Never raises; cancel it to stop."""
    while True:
        try:
            reachable = await is_cdp_reachable(cdp_url)
            await write_heartbeat(
                pool,
                runner_name,
                cdp_reachable=reachable,
                last_error=None if reachable else "Chrome/CDP unreachable at last poll",
            )
        except Exception as exc:  # noqa: BLE001 - monitoring must never take the runner down
            logger.debug("heartbeat tick failed", runner=runner_name, error=str(exc))
        await asyncio.sleep(poll_seconds)
