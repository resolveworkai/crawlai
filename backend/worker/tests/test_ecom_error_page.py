"""Authored by: Mohit Singh

Tests for the transient-error-page recovery (adapters' `is_error_page` hook + the capture engine's
`_recover_from_error_page`). Found live on amazon.ae 2026-11-15: Amazon intermittently served its
generic "something went wrong" page, which has no CAPTCHA marker and no result cards, so the engine
read it as an empty search and finished the job "ready" with 0 rows. No browser — a fake page that
returns canned text stands in for Playwright.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any, cast

import pytest
from playwright.async_api import ElementHandle, Page

from business_scout_worker.ecom.adapters.amazon import AmazonAdapter
from business_scout_worker.ecom.adapters.amazon_in import AmazonInAdapter
from business_scout_worker.ecom.adapters.noon import NoonAdapter
from business_scout_worker.ecom.capture import (
    ERROR_PAGE_RETRIES,
    EcomBlockedError,
    EcomCaptureEngine,
)
from business_scout_worker.settings import Settings

ENGLISH_ERROR = (
    "Sorry! Something went wrong on our end. There was an error processing your request."
)
ARABIC_ERROR = "عذرًا! حدث خطأ عند محاولة معالجة طلبك. نحن نعمل على حل المشكلة"
RUSH_HOUR_ERROR = (
    "Oops! It's rush hour and traffic is piling up on that page. Please try again in a short while."
)
NORMAL_PAGE = "Skip to Main content | Results | Cart | kids wooden toys | Melissa & Doug"


class FakePage:
    def __init__(self, bodies: list[str]) -> None:
        self._bodies = bodies  # one body per navigation; the last one repeats
        self.visits = 0
        self.cookies_cleared = 0
        self.title_text = ""
        self.context = SimpleNamespace(clear_cookies=self._clear)

    async def _clear(self) -> None:
        self.cookies_cleared += 1

    async def title(self) -> str:
        return self.title_text

    async def inner_text(self, selector: str) -> str:
        assert selector == "body"
        return self._bodies[min(self.visits, len(self._bodies) - 1)]

    async def screenshot(self, path: str) -> None:
        Path(path).write_bytes(b"png")


def _page(*bodies: str) -> Page:
    return cast(Page, FakePage(list(bodies)))


@pytest.fixture(autouse=True)
def _no_real_sleeping(monkeypatch: pytest.MonkeyPatch) -> None:
    async def instant(lo: int, hi: int) -> None:
        return None

    monkeypatch.setattr("business_scout_worker.ecom.capture.humanize.dwell", instant)


@pytest.mark.parametrize("adapter_cls", [AmazonAdapter, AmazonInAdapter])
@pytest.mark.parametrize("body", [ENGLISH_ERROR, ARABIC_ERROR, RUSH_HOUR_ERROR])
async def test_amazon_recognizes_known_error_pages(
    adapter_cls: type[AmazonAdapter], body: str
) -> None:
    assert await adapter_cls().is_error_page(_page(body)) is True


@pytest.mark.parametrize("adapter_cls", [AmazonAdapter, AmazonInAdapter])
async def test_amazon_does_not_flag_a_normal_results_page(adapter_cls: type[AmazonAdapter]) -> None:
    assert await adapter_cls().is_error_page(_page(NORMAL_PAGE)) is False


async def test_platforms_without_a_known_error_page_never_report_one() -> None:
    # noon/aliexpress run over the operator's real Chrome — the default hook must stay False so the
    # engine can never clear that browser's cookies on a platform that has no such page.
    assert await NoonAdapter().is_error_page(_page(ENGLISH_ERROR)) is False


class _QuietAmazon(AmazonAdapter):
    async def prepare_page(self, page: Page) -> None:
        return None


class _ScriptedEngine(EcomCaptureEngine):
    """Real recovery logic, scripted navigation. `cards[i]` is whether the i-th card lookup finds
    results; lookups before recovery runs (the caller's own) are not counted here."""

    def __init__(self, tmp_path: Path, cdp_url: str | None, cards: list[bool]) -> None:
        settings = cast(Settings, SimpleNamespace(ecom_cdp_url=cdp_url))
        super().__init__(_QuietAmazon(), settings, tmp_path, "test")
        self._cards = cards
        self._lookups = 0

    async def _goto_with_download_retry(self, page: Any, url: str) -> None:
        page.visits += 1

    async def _wait_for_cards(self, page: Any) -> None:
        return None

    async def _find_cards(self, page: Any) -> list[ElementHandle]:
        found = self._cards[min(self._lookups, len(self._cards) - 1)]
        self._lookups += 1
        return [cast(ElementHandle, object())] if found else []


async def test_recovers_when_the_error_page_clears_on_retry(tmp_path: Path) -> None:
    page = _page(ARABIC_ERROR, NORMAL_PAGE)
    engine = _ScriptedEngine(tmp_path, cdp_url=None, cards=[True])
    await engine._recover_from_error_page(page, "https://x/s?k=a", 1)
    fake = cast(FakePage, page)
    assert fake.visits == 1  # one reload was enough
    assert fake.cookies_cleared == 1


async def test_raises_blocked_when_the_error_page_persists(tmp_path: Path) -> None:
    page = _page(ARABIC_ERROR)  # never clears
    engine = _ScriptedEngine(tmp_path, cdp_url=None, cards=[False])
    with pytest.raises(EcomBlockedError, match="kept serving an error page"):
        await engine._recover_from_error_page(page, "https://x/s?k=a", 2)
    assert cast(FakePage, page).visits == ERROR_PAGE_RETRIES
    assert (tmp_path / "debug_error_page.png").exists()


async def test_genuinely_empty_page_is_left_alone(tmp_path: Path) -> None:
    page = _page(NORMAL_PAGE)
    engine = _ScriptedEngine(tmp_path, cdp_url=None, cards=[False])
    await engine._recover_from_error_page(page, "https://x/s?k=a", 1)  # must not raise
    fake = cast(FakePage, page)
    assert fake.visits == 0
    assert fake.cookies_cleared == 0


async def test_never_clears_cookies_when_attached_over_cdp(tmp_path: Path) -> None:
    page = _page(ARABIC_ERROR, NORMAL_PAGE)
    engine = _ScriptedEngine(tmp_path, cdp_url="http://127.0.0.1:9222", cards=[True])
    await engine._recover_from_error_page(page, "https://x/s?k=a", 1)
    assert cast(FakePage, page).cookies_cleared == 0  # the operator's real Chrome is not ours


# --- title selection: brand <h2> vs in-link product-title <h2> ---------------------------------


class _FakeEl:
    def __init__(self, text: str = "", attrs: dict[str, str] | None = None) -> None:
        self._text, self._attrs = text, attrs or {}

    async def inner_text(self) -> str:
        return self._text

    async def get_attribute(self, name: str) -> str | None:
        return self._attrs.get(name)


class _FakeCard:
    """Answers only the selectors it was given; every other lookup finds nothing."""

    def __init__(self, by_selector: dict[str, _FakeEl]) -> None:
        self._by = by_selector

    async def query_selector(self, selector: str) -> _FakeEl | None:
        return self._by.get(selector)

    async def query_selector_all(self, selector: str) -> list[_FakeEl]:
        return []


LINK = _FakeEl(attrs={"href": "/Wooden-Train/dp/B0ABCDE123/ref=sr_1_1"})


async def test_title_is_the_in_link_product_title_not_the_brand() -> None:
    card = _FakeCard(
        {
            "h2 span": _FakeEl("Hape"),  # brand line — what the old selector order returned
            "a h2 span": _FakeEl("Hape Wooden Railway Train Set, 50 pieces"),
            "a:has(h2)": LINK,
        }
    )
    dom = await AmazonAdapter().extract_card(cast(ElementHandle, card))
    assert dom.title == "Hape Wooden Railway Train Set, 50 pieces"
    assert dom.product_url is not None
    assert dom.product_url.startswith("https://www.amazon.ae/Wooden-Train/dp/B0ABCDE123")


async def test_title_falls_back_to_legacy_single_h2_layout() -> None:
    card = _FakeCard({"h2 span": _FakeEl("Classic Wooden Puzzle"), "h2 a": LINK})
    dom = await AmazonAdapter().extract_card(cast(ElementHandle, card))
    assert dom.title == "Classic Wooden Puzzle"


async def test_amazon_in_titles_and_urls_use_the_amazon_in_host() -> None:
    card = _FakeCard({"a h2 span": _FakeEl("Funskool Wooden Blocks"), "a:has(h2)": LINK})
    dom = await AmazonInAdapter().extract_card(cast(ElementHandle, card))
    assert dom.title == "Funskool Wooden Blocks"
    assert dom.currency == "INR"
    assert dom.product_url is not None
    assert dom.product_url.startswith("https://www.amazon.in/Wooden-Train/dp/B0ABCDE123")


async def test_amazon_in_503_title_alone_is_enough_to_flag_the_error_page() -> None:
    fake = FakePage(["Go to the Amazon.in home page to continue shopping"])
    fake.title_text = "503 - Service Unavailable Error"
    assert await AmazonInAdapter().is_error_page(cast(Page, fake)) is True
