"""Authored by: Mohit Singh

The capture loop must survive the page re-rendering under its card handles. Found live on amazon.in
over CDP (2026-11-15): after 32 good products Amazon re-rendered the result list and the next
`card.query_selector` died with `Protocol error (DOM.describeNode): Cannot find context with
specified id`, which failed the whole job at 32/90 and threw everything away. These tests drive the
real `EcomCaptureEngine.run()` loop against fake pages/cards (no browser) with that error injected.
"""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar, cast

import pytest
from playwright.async_api import Browser, BrowserContext, ElementHandle, Page
from playwright.async_api import Error as PlaywrightError

from business_scout_worker.ecom import capture as capture_module
from business_scout_worker.ecom.adapters.base import PlatformAdapter
from business_scout_worker.ecom.capture import (
    STALE_CARD_REFRESHES,
    EcomCaptureEngine,
    is_stale_handle_error,
)
from business_scout_worker.ecom.models import DomProductFields, SortMode
from business_scout_worker.settings import Settings

STALE = (
    "ElementHandle.query_selector: Protocol error (DOM.describeNode): "
    "Cannot find context with specified id"
)


class FakeCard:
    def __init__(self, n: int) -> None:
        self.n = n

    async def scroll_into_view_if_needed(self, timeout: int = 0) -> None:
        return None

    async def screenshot(self, path: str, **kwargs: Any) -> None:
        Path(path).write_bytes(b"png")


class FakePage:
    def __init__(self, card_count: int) -> None:
        self._count = card_count
        self.queries = 0

    def set_default_timeout(self, ms: int) -> None:
        return None

    async def goto(self, url: str, **kwargs: Any) -> None:
        return None

    async def wait_for_selector(self, selector: str, **kwargs: Any) -> None:
        return None

    async def query_selector_all(self, selector: str) -> list[FakeCard]:
        self.queries += 1
        return [FakeCard(i) for i in range(self._count)]

    async def close(self) -> None:
        return None


class ScriptedAdapter(PlatformAdapter):
    platform: ClassVar[str] = "amazon_in"  # any valid manifest platform; nothing real is touched
    uses_pagination: ClassVar[bool] = True
    CARD_SELECTOR: ClassVar[str] = "div.card"
    CARD_SCREENSHOTS: ClassVar[bool] = True

    def __init__(self, fail_on_calls: set[int], error: Exception) -> None:
        self.calls = 0
        self._fail_on = fail_on_calls
        self._error = error

    def search_url(self, query: str, sort: SortMode, page: int) -> str:
        return f"https://fake.test/s?k={query}&page={page}"

    async def prepare_page(self, page: Page) -> None:
        return None

    async def is_blocked(self, page: Page) -> bool:
        return False

    async def extract_card(self, card: ElementHandle) -> DomProductFields:
        self.calls += 1
        if self.calls in self._fail_on:
            raise self._error
        n = cast(FakeCard, card).n
        return DomProductFields(title=f"Product {n}", product_url=f"https://fake.test/dp/{n}")

    def product_key(self, href: str | None) -> str | None:
        return href.rsplit("/", 1)[-1] if href else None


class _Engine(EcomCaptureEngine):
    def __init__(self, adapter: PlatformAdapter, tmp_path: Path, page: FakePage) -> None:
        settings = cast(Settings, SimpleNamespace(ecom_cdp_url=None, ecom_nav_timeout_ms=1000))
        super().__init__(adapter, settings, tmp_path, "job")
        self._fake_page = page
        self.screenshots = 0

    async def _screenshot_card(self, card: ElementHandle, path: str) -> None:
        self.screenshots += 1
        await super()._screenshot_card(card, path)

    async def _open_context(self, p: Any) -> tuple[BrowserContext, Browser | None]:
        context = SimpleNamespace(
            pages=[self._fake_page], new_page=self._new_page, close=self._close
        )
        return cast(BrowserContext, context), None

    async def _new_page(self) -> FakePage:
        return self._fake_page

    async def _close(self) -> None:
        return None


@pytest.fixture(autouse=True)
def _fakes(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    async def instant(lo: int, hi: int) -> None:
        return None

    @asynccontextmanager
    async def fake_playwright() -> Any:
        yield SimpleNamespace()

    monkeypatch.setattr("business_scout_worker.ecom.capture.humanize.dwell", instant)
    monkeypatch.setattr(capture_module, "async_playwright", fake_playwright)
    yield


async def _run(adapter: ScriptedAdapter, tmp_path: Path, cards: int = 5) -> Any:
    engine = _Engine(adapter, tmp_path, FakePage(cards))
    return await engine.run(
        query="q", sort="relevance", max_pages=1, max_products=50, started_at="t0"
    )


def test_classifier_matches_stale_handle_errors_only() -> None:
    assert is_stale_handle_error(PlaywrightError(STALE))
    assert is_stale_handle_error(PlaywrightError("Execution context was destroyed, most likely"))
    assert is_stale_handle_error(PlaywrightError("Element is not attached to the DOM"))
    # A closed page/browser is a real failure and must NOT be swallowed.
    assert not is_stale_handle_error(
        PlaywrightError("Target page, context or browser has been closed")
    )
    assert not is_stale_handle_error(PlaywrightError("Timeout 30000ms exceeded"))


async def test_a_stale_card_mid_walk_does_not_fail_the_job_or_duplicate_rows(
    tmp_path: Path,
) -> None:
    # The 3rd extraction dies; everything captured so far must be kept and the walk must finish.
    adapter = ScriptedAdapter({3}, PlaywrightError(STALE))
    manifest = await _run(adapter, tmp_path, cards=5)
    titles = [item.title for item in manifest.items]
    assert titles == [f"Product {i}" for i in range(5)]  # all five, in order, no duplicates
    assert len({item.product_key for item in manifest.items}) == 5


async def test_gives_up_after_the_refresh_budget_when_cards_never_recover(tmp_path: Path) -> None:
    adapter = ScriptedAdapter(set(range(1, 100)), PlaywrightError(STALE))
    with pytest.raises(PlaywrightError, match="Cannot find context"):
        await _run(adapter, tmp_path)
    # first attempt + one retry per allowed refresh, then it stops instead of looping forever
    assert adapter.calls == STALE_CARD_REFRESHES + 1


async def test_a_non_stale_playwright_error_still_fails_fast(tmp_path: Path) -> None:
    adapter = ScriptedAdapter(
        {2}, PlaywrightError("Target page, context or browser has been closed")
    )
    with pytest.raises(PlaywrightError, match="has been closed"):
        await _run(adapter, tmp_path)
    assert adapter.calls == 2  # no retry for a genuinely fatal error


class _NoShotsAdapter(ScriptedAdapter):
    CARD_SCREENSHOTS: ClassVar[bool] = False


async def test_screenshots_are_taken_per_card_by_default(tmp_path: Path) -> None:
    engine = _Engine(ScriptedAdapter(set(), PlaywrightError(STALE)), tmp_path, FakePage(4))
    manifest = await engine.run(
        query="q", sort="relevance", max_pages=1, max_products=50, started_at="t0"
    )
    assert engine.screenshots == 4
    assert all(item.images for item in manifest.items)


async def test_card_screenshots_can_be_switched_off_per_platform(tmp_path: Path) -> None:
    # amazon.in sets CARD_SCREENSHOTS = False: no per-card scroll+screenshot (the visible-Chrome
    # flicker and the 20-40s stalls), rows captured exactly the same, just without audit PNGs.
    engine = _Engine(_NoShotsAdapter(set(), PlaywrightError(STALE)), tmp_path, FakePage(4))
    manifest = await engine.run(
        query="q", sort="relevance", max_pages=1, max_products=50, started_at="t0"
    )
    assert engine.screenshots == 0
    assert [item.title for item in manifest.items] == [f"Product {i}" for i in range(4)]
    assert all(item.images == [] for item in manifest.items)
    assert not (tmp_path / "raw").exists() or not list((tmp_path / "raw").glob("*.png"))


def test_only_amazon_in_skips_card_screenshots() -> None:
    from business_scout_worker.ecom.adapters import get_adapter

    assert get_adapter("amazon_in").CARD_SCREENSHOTS is False
    for platform in ("amazon", "noon", "aliexpress"):
        assert get_adapter(platform).CARD_SCREENSHOTS is True  # their behavior is unchanged
