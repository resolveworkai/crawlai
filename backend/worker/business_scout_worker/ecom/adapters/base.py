"""Authored by: Mohit Singh

Abstract PlatformAdapter — the contract every e-commerce site integration implements. Mirrors the
role ocr/selectors.py + the DOM-extraction helpers in ocr/capture.py play for the Maps module, but
generalized: each site has a different search-URL shape, a different card DOM, and different
block/CAPTCHA signals, so those differences are isolated per-adapter behind one shared interface
that ecom/capture.py's EcomCaptureEngine drives without knowing which site it's on.
"""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from typing import ClassVar
from urllib.parse import urljoin, urlsplit, urlunsplit

from playwright.async_api import BrowserContext, ElementHandle, Locator, Page

from business_scout_worker.ecom.models import DomDetailFields, DomProductFields, SortMode

# Tracking-param prefixes stripped by the default normalize_product_url — common across
# noon/amazon query strings. Adapter subclasses may override normalize_product_url entirely if a
# site needs different handling.
_TRACKING_PARAM_PREFIXES = ("ref", "ref_", "pd_rd", "th", "psc", "qid", "sr", "tag", "_encoding")


class PlatformAdapter(ABC):
    """One instance per capture run (stateless beyond the class-level constants below)."""

    platform: ClassVar[str]
    default_currency: ClassVar[str] = "AED"
    uses_pagination: ClassVar[bool]
    CARD_SELECTOR: ClassVar[str]
    # Elements/text whose presence on a "product card" means it's actually a sponsored banner,
    # a "customers also viewed" rail, or similar non-product chrome — extract_card / the capture
    # loop should skip cards matching these where practical.
    BLOCK_SELECTORS: ClassVar[tuple[str, ...]] = ()
    # When True, EcomCaptureEngine launches Chromium with --disable-http2 for this platform.
    # Added 2026-08-07: noon.com's Akamai edge resets the connection at the HTTP/2 protocol
    # level (`HTTP/2 stream ... INTERNAL_ERROR`) against this deployment's network before any
    # page content loads — confirmed via curl AND Playwright, both inside the container and from
    # the host. Forcing HTTP/1.1 is a low-cost mitigation to try first; it is NOT confirmed to
    # fully resolve Akamai's block (a bot-detection wall can still trigger over HTTP/1.1) — see
    # md/ECOM_CRAWL.md "Known risks" for the current status and the proxy-based fallback plan.
    FORCE_HTTP1: ClassVar[bool] = False
    # When True, this platform CANNOT be captured by a launched headless Chromium — its edge
    # (Akamai, for noon.com) resets the connection at the transport layer against every
    # automated-launch transport tried (HTTP/2, HTTP/1.1, QUIC, DoH+ECH, real-Chrome channel —
    # all confirmed failing 2026-08-07). The only working path is attaching over CDP to the
    # operator's ALREADY-RUNNING real Chrome (which reaches the site fine). Such a platform is
    # skipped by the containerized daemon (no Chrome there) and handled only by the host runner
    # (run_noon_host.py) with ECOM_CDP_URL set. See md/ECOM_CRAWL.md "noon.com requires CDP".
    REQUIRES_CDP: ClassVar[bool] = False

    async def on_context_ready(self, context: BrowserContext) -> None:  # noqa: B027 - intentional optional no-op hook, not abstract
        """Runs ONCE right after the browser context is opened, before the first navigation.
        Default no-op. Override to set cookies the site needs BEFORE its first page load — e.g.
        AliExpress uses this to force the English/USD locale (aep_usuc_f cookie), which page-1
        navigation would otherwise render in the profile's geo language. Must never raise."""

    @abstractmethod
    def search_url(self, query: str, sort: SortMode, page: int) -> str:
        """Builds the search-results URL for `query`, sorted by `sort`, at 1-based `page`."""

    @abstractmethod
    async def prepare_page(self, page: Page) -> None:
        """Best-effort dismissal of cookie-consent / "deliver to" location banners that would
        otherwise cover the results grid. Must never raise — absence of a banner is normal."""

    @abstractmethod
    async def is_blocked(self, page: Page) -> bool:
        """True if the current page is a CAPTCHA / robot-check / block wall. Checked at
        navigation and periodically mid-walk; the caller stops cleanly on True, never attempts to
        solve it."""

    @abstractmethod
    async def extract_card(self, card: ElementHandle) -> DomProductFields:
        """Reads whatever structured fields this platform's search-result card DOM exposes.
        Fields it can't find stay None/default — Stage B's OCR fallback fills the rest."""

    @abstractmethod
    def product_key(self, href: str | None) -> str | None:
        """A stable per-product identifier extracted from a product URL (ASIN for amazon, SKU
        for noon, …) used to dedupe across pagination/scroll rounds. Returns None when `href` is
        absent or doesn't carry a recognizable key — the caller then falls back to the normalized
        URL itself as the dedupe key."""

    def normalize_product_url(self, href: str, base_url: str = "") -> str:
        """Resolves `href` to an absolute URL and strips common tracking query params. Adapters
        with site-specific tracking params may override this; the default covers the common
        `ref=`/`pd_rd_*`/`qid=`/`sr=`/`tag=` shapes seen on both noon and amazon."""
        absolute = urljoin(base_url, href) if base_url else href
        parts = urlsplit(absolute)
        if not parts.query:
            return absolute
        kept = [
            kv
            for kv in parts.query.split("&")
            if kv and not kv.split("=", 1)[0].startswith(_TRACKING_PARAM_PREFIXES)
        ]
        return urlunsplit((parts.scheme, parts.netloc, parts.path, "&".join(kept), ""))

    async def load_more(self, page: Page, feed_locator: Locator) -> None:
        """Default infinite-scroll loader for adapters where `uses_pagination` is False: scrolls
        the results container down a few viewport-heights with humanized dwell, letting lazy-load
        fire. Paginated adapters (noon/amazon both navigate `&page=N` instead) don't need this —
        their capture loop calls search_url() with an incremented page number instead."""
        from business_scout_worker.ocr import humanize

        for _ in range(3):
            await feed_locator.hover()
            await page.mouse.wheel(0, 1200)
            await humanize.dwell(250, 450)
        await humanize.dwell(300, 600)

    async def extract_detail(self, page: Page) -> DomDetailFields:
        """Phase 2b — reads the product detail page's description/about-bullets/breadcrumb/seller
        fields. Default raises NotImplementedError; adapters that support detail scraping (noon,
        amazon) override this. Not `@abstractmethod` because detail scraping is optional per job
        (`detail_scrape_top_n`) and aliexpress's stub has no search/capture at all yet."""
        raise NotImplementedError(f"{self.platform} adapter does not support detail scraping")


_ASIN_RE = re.compile(r"/dp/([A-Z0-9]{10})")


def extract_asin(href: str | None) -> str | None:
    """Shared helper (amazon.ae's ASIN also appears in aliexpress-adjacent future adapters'
    cross-links occasionally) — kept module-level so it's independently unit-testable."""
    if not href:
        return None
    m = _ASIN_RE.search(href)
    return m.group(1) if m else None
