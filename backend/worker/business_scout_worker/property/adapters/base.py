"""Authored by: Mohit Singh

Abstract PlatformAdapter — the contract every property-portal integration implements. Mirrors the
role ecom/adapters/base.py plays for the e-commerce module (same shape: one shared interface that
property/capture.py's PropertyCaptureEngine drives without knowing which site it's on), but the
search is filter-based (location/bedrooms/bathrooms/property_type/purpose) rather than a free-text
query, and there's a real phone-reveal step in extract_detail — the whole point of the detail scrape
here is building a WhatsApp link, not just enriching description text.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import ClassVar
from urllib.parse import urljoin, urlsplit, urlunsplit

from playwright.async_api import BrowserContext, ElementHandle, Locator, Page

from business_scout_worker.property.models import (
    DomDetailFields,
    DomListingFields,
    PropertyStatus,
    Purpose,
)

_TRACKING_PARAM_PREFIXES = ("utm_", "ref", "gclid", "fbclid")


class SearchFilters:
    """Plain holder for one job's search criteria — passed to search_url() instead of a bare query
    string, since property search is filter-based (location + bedrooms/bathrooms/type/purpose) on
    both supported platforms."""

    def __init__(
        self,
        *,
        location: str,
        bedrooms: int | None,
        bathrooms: int | None,
        property_type: str,
        purpose: Purpose,
        property_status: PropertyStatus = "ready",
    ) -> None:
        self.location = location
        self.bedrooms = bedrooms
        self.bathrooms = bathrooms
        self.property_type = property_type
        self.purpose = purpose
        self.property_status = property_status


class PlatformAdapter(ABC):
    """One instance per capture run (stateless beyond the class-level constants below)."""

    platform: ClassVar[str]
    default_currency: ClassVar[str] = "AED"
    CARD_SELECTOR: ClassVar[str]
    BLOCK_SELECTORS: ClassVar[tuple[str, ...]] = ()
    # Both supported platforms (dubizzle.com, propertyfinder.ae) block plain headless Chromium —
    # confirmed 2026-08-22: dubizzle returns an empty-body 200, propertyfinder returns a bare 403,
    # while both load fine through the operator's real Chrome via CDP. Same REQUIRES_CDP pattern as
    # noon.com/AliExpress in the ecom module — this module has no headless-capable platform at all,
    # so (unlike ecom) there is no container-daemon claim branch for it, only the host runner
    # (run_property_host.py).
    REQUIRES_CDP: ClassVar[bool] = True

    async def on_context_ready(self, context: BrowserContext) -> None:  # noqa: B027 - intentional optional no-op hook, not abstract
        """Runs ONCE right after the browser context is opened, before the first navigation.
        Default no-op — override to set cookies/locale a site needs before its first page load.
        Must never raise."""

    @abstractmethod
    def search_url(self, filters: SearchFilters, page: int) -> str:
        """Builds the search-results URL for `filters` at 1-based `page`."""

    @abstractmethod
    async def prepare_page(self, page: Page) -> None:
        """Best-effort dismissal of cookie-consent / location banners that would otherwise cover
        the results grid. Must never raise — absence of a banner is normal."""

    @abstractmethod
    async def is_blocked(self, page: Page) -> bool:
        """True if the current page is a CAPTCHA / robot-check / block wall. The caller stops
        cleanly on True, never attempts to solve it."""

    @abstractmethod
    async def extract_card(self, card: ElementHandle) -> DomListingFields:
        """Reads whatever structured fields this platform's search-result card DOM exposes.
        Fields it can't find stay None/default — Stage B's OCR fallback fills the rest."""

    @abstractmethod
    def listing_key(self, href: str | None) -> str | None:
        """A stable per-listing identifier extracted from a listing URL (the numeric ad ID both
        dubizzle and propertyfinder embed in their detail-page URLs) used to dedupe across
        pagination. Returns None when `href` is absent or doesn't carry a recognizable key — such a
        card is treated as non-listing chrome (a promo/ad tile) and skipped, not admitted with a
        synthetic fallback key (see ecom/capture.py's 2026-08-22 fix for exactly this bug class)."""

    def normalize_listing_url(self, href: str, base_url: str = "") -> str:
        """Resolves `href` to an absolute URL and strips common tracking query params."""
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
        """Default infinite-scroll loader for a platform with no page-N pagination. Neither
        supported platform currently needs this (both paginate via `?page=N`) — kept for parity
        with the ecom adapter contract in case a future platform requires it."""
        from business_scout_worker.ocr import humanize

        for _ in range(3):
            await feed_locator.hover()
            await page.mouse.wheel(0, 1200)
            await humanize.dwell(250, 450)
        await humanize.dwell(300, 600)

    @abstractmethod
    async def extract_detail(self, page: Page) -> DomDetailFields:
        """Visits the listing detail page and reveals the phone number (clicking a "Call"/"Show
        number" control where the site requires it — confirmed working on dubizzle without login,
        2026-08-22) plus the full description and photo gallery. Only called for a job's
        `detail_scrape_top_n` highest-scoring listings — this is the one step in the whole pipeline
        that performs a real interaction (a click) rather than pure reading, so it's kept optional
        and bounded rather than run for every captured listing."""
