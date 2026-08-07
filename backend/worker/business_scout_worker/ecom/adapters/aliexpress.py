"""Authored by: Mohit Singh

AliExpress adapter — PURE-OCR extraction (by explicit design choice, 2026-08-07).

Unlike noon/amazon (DOM-first), this adapter reads NOTHING but the product link from the DOM:
title, price, rating, and "N sold" all come from OCR of the card screenshot in Stage B. Rationale:
AliExpress's card markup is heavily hashed/CSS-module class names that churn constantly, so pixel
OCR is more durable than field selectors here. `extract_card` therefore returns only product_url
(and image_url) — both are LINKS (a URL OCR can't read), not data fields — leaving every commercial
field to the OCR pass (see ecom/parse_product.py's AliExpress patterns).

Like noon, AliExpress sits behind Akamai and blocks automated-launch browsers, so REQUIRES_CDP is
set — it runs only via the host runner attached to the operator's real Chrome (run_noon_host.py).

Known limitations of pure OCR here (accepted tradeoff): the card visually TRUNCATES long titles
(so OCR titles are truncated too — the full title is only on the detail page), and OCR occasionally
drops a decimal in a price/rating (the 0-5 rating validation nulls a bad read rather than storing a
wrong one). Sort is by orders (`total_tranpro_desc`) since AliExpress has no rating sort; the "N
sold" demand signal OCRs cleanly and drives the opportunity score.
"""

from __future__ import annotations

import re
from typing import ClassVar
from urllib.parse import quote

from playwright.async_api import BrowserContext, ElementHandle, Page

from business_scout_worker.ecom.adapters.base import PlatformAdapter
from business_scout_worker.ecom.models import DomProductFields, SortMode
from business_scout_worker.logging_config import get_logger

logger = get_logger(__name__)

BASE_URL = "https://www.aliexpress.com"

# One full product card each (verified 2026-08-07 against live search). The `/item/` href-shape
# fallback is the stable last resort (the item link wraps the whole card).
_CARD_SELECTORS: tuple[str, ...] = (
    "div.search-item-card-wrapper-gallery",
    'div[class*="search-item-card-wrapper"]',
    'a[href*="/item/"]',
)
# SKU is the digits in `/item/<digits>.html` — works for both aliexpress.com and the aliexpress.us
# item links AliExpress redirects some cards to.
_SKU_RE = re.compile(r"/item/(\d+)\.html")
_BLOCKED_TEXT = (
    "slider to verify",
    "please slide",
    "verify to ensure",
    "captcha",
    "unusual traffic",
    "access denied",
)

# AliExpress SortType values. It has NO rating sort, so rating_desc maps to best-selling (orders),
# which is the closest demand-quality proxy and the field OCR reads most reliably.
_SORT_MAP = {
    "rating_desc": "total_tranpro_desc",
    "price_asc": "price_asc",
    "price_desc": "price_desc",
    "relevance": "default",
}


class AliExpressAdapter(PlatformAdapter):
    platform: ClassVar[str] = "aliexpress"
    default_currency: ClassVar[str] = "USD"
    uses_pagination: ClassVar[bool] = True
    CARD_SELECTOR: ClassVar[str] = _CARD_SELECTORS[0]
    BLOCK_SELECTORS: ClassVar[tuple[str, ...]] = _CARD_SELECTORS
    # Akamai-blocked to automated launch, exactly like noon — host runner + real Chrome only.
    REQUIRES_CDP: ClassVar[bool] = True

    async def on_context_ready(self, context: BrowserContext) -> None:
        # Force English + USD BEFORE the first navigation, else the page renders in the profile's
        # geo language (Arabic on a UAE profile) and OCR of the title is garbage. Verified: with
        # this cookie the search page title comes back "Rice cooker-AliExpress" (English).
        try:
            await context.add_cookies(
                [
                    {
                        "name": "aep_usuc_f",
                        "value": "site=glo&c_tp=USD&region=US&b_locale=en_US",
                        "domain": ".aliexpress.com",
                        "path": "/",
                    }
                ]
            )
        except Exception as exc:  # noqa: BLE001 - locale cookie is best-effort
            logger.debug("aliexpress locale cookie skipped", error=str(exc))

    def search_url(self, query: str, sort: SortMode, page: int) -> str:
        slug = quote(query.strip().replace(" ", "-"))
        sort_type = _SORT_MAP.get(sort, "default")
        return f"{BASE_URL}/w/wholesale-{slug}.html?page={page}&SortType={sort_type}"

    async def prepare_page(self, page: Page) -> None:
        # AliExpress throws a sign-in modal / cookie banner over the grid — dismiss best-effort.
        for selector in (
            'div[class*="_close"]',
            'div[class*="close-icon"]',
            'button:has-text("Accept")',
            'button[aria-label="Close"]',
        ):
            try:
                el = await page.query_selector(selector)
                if el is not None:
                    await el.click(timeout=1500)
                    await page.wait_for_timeout(300)
            except Exception as exc:  # noqa: BLE001 - modal dismissal is best-effort
                logger.debug("aliexpress modal dismiss skipped", selector=selector, error=str(exc))

    async def is_blocked(self, page: Page) -> bool:
        if "/sorry/" in page.url or "punish" in page.url:
            return True
        try:
            body = await page.inner_text("body")
        except Exception:  # noqa: BLE001 - a torn-down page must not crash the block check
            return False
        lowered = body.lower()
        return any(t in lowered for t in _BLOCKED_TEXT)

    async def extract_card(self, card: ElementHandle) -> DomProductFields:
        # PURE OCR: the only things read from the DOM are LINKS (URLs OCR can't produce). Every
        # commercial field stays None so Stage B's OCR pass fills them from the card screenshot.
        href = await card.get_attribute("href")
        if not href:
            anchor = await card.query_selector('a[href*="/item/"]')
            href = (await anchor.get_attribute("href")) if anchor is not None else None
        product_url = self.normalize_product_url(href, BASE_URL) if href else None

        image_el = await card.query_selector("img")
        image_url = (await image_el.get_attribute("src")) if image_el is not None else None

        return DomProductFields(
            product_url=product_url,
            image_url=image_url,
            currency=self.default_currency,
        )

    def product_key(self, href: str | None) -> str | None:
        if not href:
            return None
        m = _SKU_RE.search(href)
        return m.group(1) if m else None
