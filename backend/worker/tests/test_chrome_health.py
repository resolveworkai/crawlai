"""Authored by: Mohit Singh

Unit tests for chrome_health.py's pure helpers + is_cdp_reachable/ensure_chrome_running's control
flow (mocked httpx/subprocess — no real Chrome, no real network). write_heartbeat is exercised via
a fake pool object mirroring the tiny async surface the real one uses.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from business_scout_worker.chrome_health import (
    _resolve_chrome_exe,
    _resolve_user_data_dir,
    ensure_chrome_running,
    heartbeat_forever,
    is_cdp_reachable,
    write_heartbeat,
)


def test_resolve_chrome_exe_prefers_override() -> None:
    assert _resolve_chrome_exe(r"C:\custom\chrome.exe") == r"C:\custom\chrome.exe"


def test_resolve_chrome_exe_falls_back_to_none_when_nothing_found() -> None:
    with patch("business_scout_worker.chrome_health.Path.exists", return_value=False):
        assert _resolve_chrome_exe(None) is None


def test_resolve_user_data_dir_prefers_override() -> None:
    assert _resolve_user_data_dir("D:/custom-profile") == "D:/custom-profile"


def test_resolve_user_data_dir_matches_launcher_scripts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TEMP", r"C:\Users\test\AppData\Local\Temp")
    result = _resolve_user_data_dir(None)
    # Must match every scripts/start-*-host.bat's %TEMP%\noon-cdp-chrome exactly.
    assert result.endswith("noon-cdp-chrome")
    assert "Temp" in result


async def test_is_cdp_reachable_true_on_200() -> None:
    mock_response = MagicMock(status_code=200)
    mock_client = AsyncMock()
    mock_client.get.return_value = mock_response
    mock_client.__aenter__.return_value = mock_client
    with patch("business_scout_worker.chrome_health.httpx.AsyncClient", return_value=mock_client):
        assert await is_cdp_reachable("http://127.0.0.1:9222") is True


async def test_is_cdp_reachable_false_on_connection_error() -> None:
    mock_client = AsyncMock()
    mock_client.get.side_effect = ConnectionError("refused")
    mock_client.__aenter__.return_value = mock_client
    with patch("business_scout_worker.chrome_health.httpx.AsyncClient", return_value=mock_client):
        assert await is_cdp_reachable("http://127.0.0.1:9222") is False


async def test_ensure_chrome_running_returns_true_when_already_reachable() -> None:
    with patch(
        "business_scout_worker.chrome_health.is_cdp_reachable", AsyncMock(return_value=True)
    ):
        result = await ensure_chrome_running(
            cdp_url="http://127.0.0.1:9222",
            launch_url="https://example.com",
            runner_name="test",
        )
    assert result is True


async def test_ensure_chrome_running_skips_relaunch_when_auto_restart_false() -> None:
    with patch(
        "business_scout_worker.chrome_health.is_cdp_reachable", AsyncMock(return_value=False)
    ):
        result = await ensure_chrome_running(
            cdp_url="http://127.0.0.1:9222",
            launch_url="https://example.com",
            runner_name="test",
            auto_restart=False,
        )
    assert result is False


async def test_ensure_chrome_running_gives_up_when_no_chrome_exe_found() -> None:
    with (
        patch(
            "business_scout_worker.chrome_health.is_cdp_reachable", AsyncMock(return_value=False)
        ),
        patch("business_scout_worker.chrome_health._resolve_chrome_exe", return_value=None),
        patch("business_scout_worker.chrome_health.platform.system", return_value="Windows"),
    ):
        result = await ensure_chrome_running(
            cdp_url="http://127.0.0.1:9222",
            launch_url="https://example.com",
            runner_name="test",
        )
    assert result is False


async def test_ensure_chrome_running_skips_relaunch_on_non_windows() -> None:
    with (
        patch(
            "business_scout_worker.chrome_health.is_cdp_reachable", AsyncMock(return_value=False)
        ),
        patch("business_scout_worker.chrome_health.platform.system", return_value="Linux"),
    ):
        result = await ensure_chrome_running(
            cdp_url="http://127.0.0.1:9222",
            launch_url="https://example.com",
            runner_name="test",
        )
    assert result is False


async def test_ensure_chrome_running_relaunches_and_succeeds() -> None:
    # First is_cdp_reachable call (initial check): unreachable. Second (post-jitter recheck):
    # unreachable. Third+ (post-launch polling): reachable — proves the launch path is what
    # flipped it, not the jittered recheck alone.
    call_count = 0

    async def fake_reachable(_url: str, timeout_s: float = 3.0) -> bool:
        nonlocal call_count
        call_count += 1
        return call_count >= 3

    with (
        patch("business_scout_worker.chrome_health.is_cdp_reachable", fake_reachable),
        patch("business_scout_worker.chrome_health.platform.system", return_value="Windows"),
        patch(
            "business_scout_worker.chrome_health._resolve_chrome_exe",
            return_value=r"C:\chrome.exe",
        ),
        patch("business_scout_worker.chrome_health._launch_chrome") as mock_launch,
        patch("business_scout_worker.chrome_health.asyncio.sleep", AsyncMock()),
    ):
        result = await ensure_chrome_running(
            cdp_url="http://127.0.0.1:9222",
            launch_url="https://example.com",
            runner_name="test",
        )
    assert result is True
    mock_launch.assert_called_once()


class _FakeCursor:
    async def fetchone(self) -> Any:
        return None


class _FakeConn:
    def __init__(self) -> None:
        self.executed: list[tuple[Any, Any]] = []

    async def execute(self, sql: Any, params: Any = None) -> _FakeCursor:
        self.executed.append((sql, params))
        return _FakeCursor()


class _FakeConnCtx:
    def __init__(self, conn: _FakeConn) -> None:
        self._conn = conn

    async def __aenter__(self) -> _FakeConn:
        return self._conn

    async def __aexit__(self, *args: object) -> bool:
        return False


class _FakePool:
    def __init__(self) -> None:
        self.conn = _FakeConn()

    def connection(self) -> _FakeConnCtx:
        return _FakeConnCtx(self.conn)


async def test_write_heartbeat_upserts_with_given_values() -> None:
    pool = _FakePool()
    await write_heartbeat(pool, "property", cdp_reachable=True, last_error=None)
    assert len(pool.conn.executed) == 1
    _, params = pool.conn.executed[0]
    assert params == ("property", True, None)


async def test_write_heartbeat_never_raises_on_db_failure() -> None:
    class _RaisingPool:
        def connection(self) -> Any:
            raise RuntimeError("db down")

    # Must not raise — heartbeat writes are best-effort.
    await write_heartbeat(_RaisingPool(), "noon", cdp_reachable=False, last_error="x")


# --- heartbeat_forever: keeps beating while the runner is busy -------------------------------


async def _run_heartbeat_for(seconds: float) -> None:
    task = asyncio.create_task(
        heartbeat_forever(MagicMock(), "noon", "http://127.0.0.1:9222", 0.01)
    )
    await asyncio.sleep(seconds)
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError):
        await task


async def test_heartbeat_forever_keeps_beating_while_a_job_runs() -> None:
    # The whole point: a noon job runs for minutes inside ONE poll cycle. The heartbeat is its own
    # task, so it must keep ticking while the "job" (here a long await) is in progress.
    write = AsyncMock()
    with (
        patch("business_scout_worker.chrome_health.is_cdp_reachable", AsyncMock(return_value=True)),
        patch("business_scout_worker.chrome_health.write_heartbeat", write),
    ):
        await _run_heartbeat_for(0.15)  # the "job" is this 150ms await
    assert write.await_count >= 5
    for call in write.await_args_list:
        assert call.args[1] == "noon"
        assert call.kwargs == {"cdp_reachable": True, "last_error": None}


async def test_heartbeat_forever_reports_unreachable_chrome_with_a_reason() -> None:
    write = AsyncMock()
    with (
        patch(
            "business_scout_worker.chrome_health.is_cdp_reachable", AsyncMock(return_value=False)
        ),
        patch("business_scout_worker.chrome_health.write_heartbeat", write),
    ):
        await _run_heartbeat_for(0.05)
    assert write.await_count >= 1
    assert write.await_args_list[0].kwargs == {
        "cdp_reachable": False,
        "last_error": "Chrome/CDP unreachable at last poll",
    }


async def test_heartbeat_forever_survives_a_failing_tick() -> None:
    # A DB/network hiccup in one tick must not end the loop (monitoring never kills the runner).
    write = AsyncMock(side_effect=[RuntimeError("db down"), None, None, None, None, None])
    with (
        patch("business_scout_worker.chrome_health.is_cdp_reachable", AsyncMock(return_value=True)),
        patch("business_scout_worker.chrome_health.write_heartbeat", write),
    ):
        await _run_heartbeat_for(0.1)
    assert write.await_count >= 3  # kept going after the first tick raised


async def test_heartbeat_forever_never_relaunches_chrome() -> None:
    # Relaunching stays with the between-jobs check; a tick must not race a running job over Chrome.
    ensure = AsyncMock()
    with (
        patch(
            "business_scout_worker.chrome_health.is_cdp_reachable", AsyncMock(return_value=False)
        ),
        patch("business_scout_worker.chrome_health.write_heartbeat", AsyncMock()),
        patch("business_scout_worker.chrome_health.ensure_chrome_running", ensure),
    ):
        await _run_heartbeat_for(0.05)
    ensure.assert_not_awaited()
