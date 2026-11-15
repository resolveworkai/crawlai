"""Authored by: Mohit Singh

amazon.ae adapter. `s-search-result` is Amazon's own stable data-component-type attribute for a
search-result card (used by their own analytics), the closest thing to a durable selector on this
site — still backed by a `[data-asin]` fallback since Amazon periodically restructures result
cards around promotions/sponsored slots.
"""

from __future__ import annotations

import re
from typing import ClassVar
from urllib.parse import quote

from playwright.async_api import ElementHandle, Page

from business_scout_worker.ecom.adapters.base import PlatformAdapter, extract_asin
from business_scout_worker.ecom.models import DomDetailFields, DomProductFields, SortMode
from business_scout_worker.logging_config import get_logger

logger = get_logger(__name__)

BASE_URL = "https://www.amazon.ae"

_CARD_SELECTORS: tuple[str, ...] = (
    'div[data-component-type="s-search-result"]',
    "div[data-asin]:not([data-asin=''])",
)
_CAPTCHA_TEXT = "type the characters you see in this image"
# Amazon's generic "dog page" error, served intermittently (seen live on amazon.ae, 2026-11-15, as
# the ARABIC variant even with language=en_AE — hence both languages). Not a CAPTCHA: no
# #captchacharacters, so is_blocked() is False and the page used to read as "0 results".
_ERROR_PAGE_MARKERS: tuple[str, ...] = (
    "there was an error processing your request",
    "sorry! something went wrong",
    "حدث خطأ عند محاولة معالجة طلبك",
    # amazon.in's variant (2026-11-15): HTTP-503 titled "503 - Service Unavailable Error" with this
    # body. It is Amazon refusing the request, not an empty search — same recovery, and if it
    # persists the job must end visibly `blocked` rather than "ready" with 0 rows.
    "traffic is piling up on that page",
)
_ERROR_PAGE_TITLES: tuple[str, ...] = ("503 - service unavailable error", "service unavailable")


class AmazonAdapter(PlatformAdapter):
    platform: ClassVar[str] = "amazon"
    default_currency: ClassVar[str] = "AED"
    # Marketplace host + `language=` locale — class-level so a sibling marketplace (amazon.in)
    # reuses every selector/parse path below by overriding just these, not copying the adapter.
    base_url: ClassVar[str] = BASE_URL
    language: ClassVar[str] = "en_AE"
    uses_pagination: ClassVar[bool] = True
    CARD_SELECTOR: ClassVar[str] = _CARD_SELECTORS[0]
    BLOCK_SELECTORS: ClassVar[tuple[str, ...]] = _CARD_SELECTORS

    def search_url(self, query: str, sort: SortMode, page: int) -> str:
        term = quote(query)
        params = [f"k={term}", f"page={page}", f"language={self.language}"]
        if sort == "rating_desc":
            params.append("s=review-rank")
        elif sort == "price_asc":
            params.append("s=price-asc-rank")
        elif sort == "price_desc":
            params.append("s=price-desc-rank")
        # relevance: no `s` param — Amazon's own default ranking.
        return f"{self.base_url}/s?{'&'.join(params)}"

    async def prepare_page(self, page: Page) -> None:
        for selector in (
            "#sp-cc-accept",
            'input[data-action-type="DISMISS"]',
            "#nav-global-location-popover-link ~ * button",
        ):
            try:
                btn = await page.query_selector(selector)
                if btn is not None:
                    await btn.click()
                    await page.wait_for_timeout(300)
            except Exception as exc:  # noqa: BLE001 - banner dismissal is best-effort
                logger.debug("amazon banner dismiss skipped", selector=selector, error=str(exc))

    async def is_blocked(self, page: Page) -> bool:
        if await page.query_selector("#captchacharacters") is not None:
            return True
        try:
            body = await page.inner_text("body")
        except Exception:  # noqa: BLE001 - a torn-down page must not crash the block check
            return False
        return _CAPTCHA_TEXT in body.lower()

    async def is_error_page(self, page: Page) -> bool:
        try:
            title = (await page.title()).lower()
            body = (await page.inner_text("body"))[:2000].lower()
        except Exception:  # noqa: BLE001 - a torn-down page must not crash the error check
            return False
        return any(t in title for t in _ERROR_PAGE_TITLES) or any(
            marker in body for marker in _ERROR_PAGE_MARKERS
        )

    async def extract_card(self, card: ElementHandle) -> DomProductFields:
        async def text_of(selector: str) -> str | None:
            el = await card.query_selector(selector)
            if el is None:
                return None
            t = (await el.inner_text()).strip()
            return t or None

        # Current Amazon cards carry TWO <h2>s: a brand line (outside the link) and the real
        # product title (inside the link, also its aria-label). The bare "h2 span" the adapter used
        # to try first matched the brand, so every row came back titled "Hape" / "Fisher-Price"
        # (confirmed live on amazon.ae 2026-11-15). Prefer the in-link title; the old selectors
        # stay as fallbacks for cards still on the single-<h2> layout.
        title = (
            await text_of("a h2 span")
            or await text_of("a h2")
            or await text_of("h2 span")
            or await text_of("h2 a")
        )
        anchor = (
            await card.query_selector("a:has(h2)")
            or await card.query_selector("h2 a")
            or await card.query_selector("a.a-link-normal")
        )
        href = (await anchor.get_attribute("href")) if anchor is not None else None
        product_url = self.normalize_product_url(href, self.base_url) if href else None

        price_text = await text_of("span.a-price > span.a-offscreen")
        list_price_text = await text_of("span.a-price.a-text-price > span.a-offscreen")
        rating_alt = await text_of("span.a-icon-alt") or await text_of("i.a-icon-star-small")
        review_count_text = await text_of(
            'span[aria-label*="stars"] + span a span, a[href*="#customerReviews"] span'
        )
        bought_text = await text_of('span:has-text("bought in past month")')

        image_el = await card.query_selector("img.s-image")
        image_url = (await image_el.get_attribute("src")) if image_el is not None else None

        badges: list[str] = []
        for el in await card.query_selector_all("span.a-badge-text"):
            t = (await el.inner_text()).strip()
            if t:
                badges.append(t)

        sponsored_el = await card.query_selector(
            'span:has-text("Sponsored"), div[data-component-type="sp-sponsored-result"]'
        )
        delivery_text = await text_of('[data-cy="delivery-recipe"], span:has-text("Get it")')

        price = _parse_amount(price_text)
        list_price = _parse_amount(list_price_text)
        discount_pct = None
        if price is not None and list_price is not None and list_price > price > 0:
            discount_pct = round((1 - price / list_price) * 100, 1)

        return DomProductFields(
            title=title,
            product_url=product_url,
            image_url=image_url,
            price=price,
            list_price=list_price,
            currency=self.default_currency,
            discount_pct=discount_pct,
            rating=_parse_stars(rating_alt),
            review_count=_parse_review_count(review_count_text),
            bought_past_month=_parse_bought(bought_text),
            bought_past_month_raw=bought_text,
            free_delivery="free delivery" in (delivery_text or "").lower(),
            delivery_date=delivery_text,
            badges=badges,
            sponsored=sponsored_el is not None,
        )

    def product_key(self, href: str | None) -> str | None:
        return extract_asin(href)

    async def extract_detail(self, page: Page) -> DomDetailFields:
        async def text_of(selector: str) -> str | None:
            el = await page.query_selector(selector)
            if el is None:
                return None
            t = (await el.inner_text()).strip()
            return t or None

        description = await text_of("#productDescription") or await text_of("#feature-bullets")
        bullets: list[str] = []
        for el in await page.query_selector_all("#feature-bullets li span.a-list-item"):
            t = (await el.inner_text()).strip()
            if t:
                bullets.append(t)
        breadcrumb = await text_of("#wayfinding-breadcrumbs_feature_div")
        seller = await text_of("#sellerProfileTriggerId") or await text_of("#merchant-info a")
        return DomDetailFields(
            description=description,
            about_bullets=bullets,
            breadcrumb_category=breadcrumb,
            seller_name=seller,
        )


_AMOUNT_RE = re.compile(r"([\d,]+(?:\.\d+)?)")


def _parse_amount(text: str | None) -> float | None:
    if not text:
        return None
    cleaned = re.sub(r"[^\d.,]", "", text)
    m = _AMOUNT_RE.search(cleaned.replace(",", ""))
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


_STARS_RE = re.compile(r"([0-5](?:\.\d)?)\s*out of\s*5", re.I)


def _parse_stars(text: str | None) -> float | None:
    """ "4.3 out of 5 stars" -> 4.3."""
    if not text:
        return None
    m = _STARS_RE.search(text)
    if not m:
        return None
    val = float(m.group(1))
    return val if 0.0 <= val <= 5.0 else None


def _parse_review_count(text: str | None) -> int | None:
    if not text:
        return None
    digits = re.sub(r"[^\d]", "", text)
    return int(digits) if digits else None


_BOUGHT_RE = re.compile(r"([\d,]+)\+?\s*bought in (?:the )?past month", re.I)


def _parse_bought(text: str | None) -> int | None:
    if not text:
        return None
    m = _BOUGHT_RE.search(text)
    if not m:
        return None
    digits = m.group(1).replace(",", "")
    return int(digits) if digits.isdigit() else None
