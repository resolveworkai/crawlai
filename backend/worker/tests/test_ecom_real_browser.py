"""Authored by: Mohit Singh

amazon.in must only ever run in the operator's real Chrome. It answers a headless browser with HTTP
503 on every attempt (2026-11-15), so a silent fallback to headless would just burn the job on that
wall. These tests pin the strict check: no real browser configured -> a clear error, never a
headless launch; real browser unreachable -> a clear error, never a headless launch.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from playwright.async_api import Playwright

from business_scout_worker.ecom.adapters.amazon import AmazonAdapter
from business_scout_worker.ecom.adapters.amazon_in import AmazonInAdapter
from business_scout_worker.ecom.adapters.base import PlatformAdapter
from business_scout_worker.ecom.capture import EcomCaptureEngine, EcomRealBrowserRequiredError
from business_scout_worker.settings import Settings


def _engine(adapter: PlatformAdapter, tmp_path: Path, cdp_url: str | None) -> EcomCaptureEngine:
    settings = SimpleNamespace(
        ecom_cdp_url=cdp_url,
        ecom_nav_timeout_ms=1000,
        ecom_headless=True,
        ecom_device_scale=1,
        ecom_captures_dir=str(tmp_path / "captures"),
    )
    return EcomCaptureEngine(adapter, cast(Settings, settings), tmp_path, "job")


class _Playwright:
    """Records every browser launch/attach so a test can prove what was (not) tried."""

    def __init__(self, connect_error: Exception | None = None) -> None:
        self.launched_headless = 0
        self.attach_attempts = 0
        self._connect_error = connect_error
        self.chromium = SimpleNamespace(
            launch_persistent_context=self._launch, connect_over_cdp=self._connect
        )

    async def _launch(self, **kwargs: Any) -> str:
        self.launched_headless += 1
        return "headless-context"

    async def _connect(self, url: str) -> Any:
        self.attach_attempts += 1
        if self._connect_error is not None:
            raise self._connect_error
        context = SimpleNamespace(set_default_timeout=lambda ms: None)
        return SimpleNamespace(contexts=[context], new_context=None)


def _p(fake: _Playwright) -> Playwright:
    return cast(Playwright, fake)


async def test_amazon_in_without_a_real_browser_is_refused_and_never_goes_headless(
    tmp_path: Path,
) -> None:
    fake = _Playwright()
    engine = _engine(AmazonInAdapter(), tmp_path, cdp_url=None)
    with pytest.raises(EcomRealBrowserRequiredError) as err:
        await engine._open_context(_p(fake))
    assert fake.launched_headless == 0  # the whole point: no silent headless fallback
    assert fake.attach_attempts == 0
    message = str(err.value)
    assert "amazon_in only runs in your real Chrome" in message
    assert "deliberately never used" in message
    assert "start-noon-host.bat" in message  # tells the operator exactly what to do


async def test_amazon_in_with_an_unreachable_real_browser_is_refused_with_the_reason(
    tmp_path: Path,
) -> None:
    fake = _Playwright(connect_error=RuntimeError("connect ECONNREFUSED 127.0.0.1:9222\nCall log:"))
    engine = _engine(AmazonInAdapter(), tmp_path, cdp_url="http://127.0.0.1:9222")
    with pytest.raises(EcomRealBrowserRequiredError) as err:
        await engine._open_context(_p(fake))
    assert fake.attach_attempts == 1
    assert fake.launched_headless == 0  # failed to attach -> still never headless
    message = str(err.value)
    assert "http://127.0.0.1:9222" in message
    assert "ECONNREFUSED" in message
    assert "Not falling back to headless" in message
    assert "Call log" not in message  # only the first line of Playwright's noisy error


async def test_amazon_in_attaches_to_the_real_browser_when_it_is_there(tmp_path: Path) -> None:
    fake = _Playwright()
    engine = _engine(AmazonInAdapter(), tmp_path, cdp_url="http://127.0.0.1:9222")
    context, browser = await engine._open_context(_p(fake))
    assert browser is not None  # attached over CDP
    assert fake.launched_headless == 0
    assert context is not None


async def test_amazon_ae_is_unaffected_and_still_runs_headless_without_a_cdp_url(
    tmp_path: Path,
) -> None:
    # Only REQUIRES_CDP platforms get the strict check; amazon.ae's headless path is unchanged.
    fake = _Playwright()
    engine = _engine(AmazonAdapter(), tmp_path, cdp_url=None)
    context, browser = await engine._open_context(_p(fake))
    assert browser is None
    assert cast(Any, context) == "headless-context"  # the fake launch's sentinel
    assert fake.launched_headless == 1


async def test_a_non_cdp_platform_keeps_the_original_connect_error(tmp_path: Path) -> None:
    # Pointing amazon.ae at an unreachable CDP url is the operator's own override; its raw error
    # must surface unchanged rather than being rewritten into the real-browser-only message.
    fake = _Playwright(connect_error=RuntimeError("boom"))
    engine = _engine(AmazonAdapter(), tmp_path, cdp_url="http://127.0.0.1:9222")
    with pytest.raises(RuntimeError, match="boom"):
        await engine._open_context(_p(fake))
