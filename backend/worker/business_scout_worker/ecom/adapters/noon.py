"""Authored by: Mohit Singh

noon.com/uae-en adapter. Card DOM and class names drift like any other e-commerce SPA, so
CARD_SELECTOR/BLOCK_SELECTORS carry 2-3 fallbacks tried in order (mirrors ocr/selectors.py's
role/aria-over-class-name philosophy, adapted to noon's markup).
"""

from __future__ import annotations

import re
from typing import ClassVar
from urllib.parse import quote

from playwright.async_api import ElementHandle, Page

from business_scout_worker.ecom.adapters.base import PlatformAdapter
from business_scout_worker.ecom.models import DomDetailFields, DomProductFields, SortMode
from business_scout_worker.logging_config import get_logger

logger = get_logger(__name__)

BASE_URL = "https://www.noon.com"

# Tried in order. Verified 2026-08-07 against live noon.com (via CDP) DOM: each product is a
# `div[data-qa="plp-product-box"]` wrapping an `a._productBoxLink_*` anchor that contains the
# name/price/image. The old `product-card`/`productContainer` guesses matched NOTHING (0 cards).
# `plp-product-box` also naturally excludes the top sponsored banner cards (they lack it). The
# `a[href*="/p/"]` href-shape fallback is the last resort (also matches a few non-product ad
# anchors, so it's not first).
_CARD_SELECTORS: tuple[str, ...] = (
    'div[data-qa="plp-product-box"]',
    'a[class*="_productBoxLink_"]',
    'a[href*="/p/"]',
)
# noon product URLs are `.../<slug>/<SKU>/p/?o=<tracking>` — the SKU is the path segment
# immediately BEFORE `/p/`, NOT after it. Verified 2026-08-07 against live hrefs (e.g.
# `.../white/N11043863A/p/?o=fec2...`, `.../ZC7E09604077A091EA1B4Z/p/?o=...`). The previous
# `/p/([...])` pattern matched nothing (there's only `?o=` after `/p/`), so product_key returned
# None and dedup silently fell back to the full tracking-param'd href — same product on two pages
# could survive as two rows. This is the stable cross-page dedup key.
_SKU_RE = re.compile(r"/([A-Za-z0-9]+)/p(?:/|\?|$)")
_BLOCKED_TEXT = (
    "unusual traffic",
    "verify you are a human",
    "access denied",
    "are you a robot",
)


class NoonAdapter(PlatformAdapter):
    platform: ClassVar[str] = "noon"
    default_currency: ClassVar[str] = "AED"
    uses_pagination: ClassVar[bool] = True
    CARD_SELECTOR: ClassVar[str] = _CARD_SELECTORS[0]
    BLOCK_SELECTORS: ClassVar[tuple[str, ...]] = _CARD_SELECTORS
    # noon.com resets EVERY automated-launch transport (HTTP/2, HTTP/1.1, QUIC, DoH+ECH,
    # real-Chrome channel — all confirmed failing 2026-08-07). Attaching over CDP to the
    # operator's already-running real Chrome is the only working path. FORCE_HTTP1 is therefore
    # moot under CDP (no launch args), kept only to document the failed HTTP/2 finding.
    FORCE_HTTP1: ClassVar[bool] = True
    REQUIRES_CDP: ClassVar[bool] = True

    def search_url(self, query: str, sort: SortMode, page: int) -> str:
        term = quote(query)
        params = [f"q={term}", f"page={page}"]
        if sort == "rating_desc":
            params += ["sort[by]=best_rating", "sort[dir]=desc"]
        elif sort == "price_asc":
            params += ["sort[by]=price", "sort[dir]=asc"]
        elif sort == "price_desc":
            params += ["sort[by]=price", "sort[dir]=desc"]
        # relevance: no sort params — noon's own default ranking.
        return f"{BASE_URL}/uae-en/search/?{'&'.join(params)}"

    async def prepare_page(self, page: Page) -> None:
        for selector in (
            'button:has-text("Accept")',
            'button[data-qa="location-popup-close"]',
            'button[aria-label="Close"]',
        ):
            try:
                btn = await page.query_selector(selector)
                if btn is not None:
                    await btn.click()
                    await page.wait_for_timeout(300)
            except Exception as exc:  # noqa: BLE001 - banner dismissal is best-effort
                logger.debug("noon banner dismiss skipped", selector=selector, error=str(exc))

    async def is_blocked(self, page: Page) -> bool:
        if "/sorry/" in page.url or "/blocked" in page.url:
            return True
        try:
            body = await page.inner_text("body")
        except Exception:  # noqa: BLE001 - a torn-down page must not crash the block check
            return False
        # Absence of any card selector after a settled navigation is also treated as a soft
        # block/empty-results signal by the caller (capture.py checks card count separately);
        # this method stays limited to genuine CAPTCHA/robot-check walls.
        lowered = body.lower()
        return any(t in lowered for t in _BLOCKED_TEXT)

    async def extract_card(self, card: ElementHandle) -> DomProductFields:
        async def text_of(selector: str) -> str | None:
            el = await card.query_selector(selector)
            if el is None:
                return None
            t = (await el.inner_text()).strip()
            return t or None

        # data-qa strings below were verified 2026-08-07 against a real captured card DOM
        # (user-provided live inspect-element dump) — see md/ECOM_CRAWL.md "Known risks" for the
        # fields that remain unconfirmed (rating/review/badge have NO data-qa hook in that dump;
        # rating is matched structurally via its CSS-module class-name prefix, which is more
        # stable across noon's per-build hash rotation than the generic "rating"/"badge"
        # substring guesses this file shipped with before that verification).
        title = (
            await text_of('[data-qa="plp-product-box-name"]')
            or await text_of('[data-qa="product-name"]')
            or await text_of("h2, h3")
        )
        price_text = (
            await text_of('[data-qa="plp-product-box-price"] strong')
            or await text_of('[data-qa="plp-product-box-price"]')
            or await text_of('[data-qa="product-price"]')
            or await text_of('[class*="priceNow"], [class*="_amount_"]')
        )
        list_price_text = await text_of('[class*="priceOld"], [class*="oldPrice"]')
        # "_textCtr_" is the CSS-module class-name prefix noon compiles the rating digit into
        # (e.g. "_textCtr_1r83y_16" — the "_1r83y_16" suffix is a per-build hash that rotates on
        # redeploy, so match on the stable prefix only). "product-rating"/generic "rating" data-qa
        # do not exist on this page at all — kept as a fallback in case another noon page variant
        # (detail page, different locale) still uses them.
        rating_text = (
            await text_of('[class*="_textCtr_"]')
            or await text_of('[data-qa="product-rating"]')
            or await text_of('[class*="rating"]')
        )
        review_count_text = await text_of('[class*="_countCtr_"]')
        image_el = await card.query_selector("img")
        image_url = (await image_el.get_attribute("src")) if image_el is not None else None
        # The card is normally the plp-product-box div (anchor is a descendant), but when a
        # fallback selector matched, the card may itself BE the /p/ anchor — check its own href
        # first, then look for a descendant anchor.
        href = await card.get_attribute("href")
        if not href:
            anchor = await card.query_selector('a[href*="/p/"]')
            href = (await anchor.get_attribute("href")) if anchor is not None else None
        product_url = self.normalize_product_url(href, BASE_URL) if href else None

        badges: list[str] = []
        # "_nudgeText_" is noon's marquee-rotation strip under each card — carries rank-in-
        # category ("#8 in Dome Cameras"), stock scarcity ("Only 4 left in stock"), and delivery
        # estimate ("GET IN 54 MINS") text, none of which the old data-qa/"badge"/"express"
        # guesses below ever matched. Collected via query_selector_all since the strip can hold
        # several distinct nudges (deduped, since noon repeats entries in its animation loop).
        seen_badges: set[str] = set()
        for badge_sel in (
            '[class*="_nudgeText_"]',
            '[data-qa="pick-badge"]',
            '[class*="badge"]',
            '[class*="express"]',
        ):
            for el in await card.query_selector_all(badge_sel):
                badge_text = (await el.inner_text()).strip()
                if badge_text and badge_text not in seen_badges:
                    seen_badges.add(badge_text)
                    badges.append(badge_text)

        sponsored_text = await text_of('[data-qa="sponsored-label"]')
        # "GET IN <N> MINS" (nudge strip) is a delivery-speed estimate, not a price signal — do
        # NOT treat it as free_delivery evidence (a paid express fee is common on fast delivery).
        free_delivery = any("express" in b.lower() or "free" in b.lower() for b in badges)

        price = _parse_amount(price_text)
        list_price = _parse_amount(list_price_text)
        discount_pct = None
        if price is not None and list_price is not None and list_price > 0:
            discount_pct = round((1 - price / list_price) * 100, 1)

        return DomProductFields(
            title=title,
            product_url=product_url,
            image_url=image_url,
            price=price,
            list_price=list_price,
            currency=self.default_currency,
            discount_pct=discount_pct,
            rating=_parse_rating(rating_text),
            review_count=_parse_review_count(review_count_text) or _parse_review_count(rating_text),
            free_delivery=free_delivery,
            badges=badges,
            sponsored=sponsored_text is not None,
        )

    def product_key(self, href: str | None) -> str | None:
        if not href:
            return None
        m = _SKU_RE.search(href)
        return m.group(1) if m else None

    async def extract_detail(self, page: Page) -> DomDetailFields:
        async def text_of(selector: str) -> str | None:
            el = await page.query_selector(selector)
            if el is None:
                return None
            t = (await el.inner_text()).strip()
            return t or None

        description = await text_of('[data-qa="product-description"]') or await text_of(
            '[class*="description"]'
        )
        bullets_els = await page.query_selector_all(
            '[data-qa="product-highlights"] li, [class*="keyHighlights"] li'
        )
        about_bullets: list[str] = []
        for el in bullets_els:
            bullet_text = (await el.inner_text()).strip()
            if bullet_text:
                about_bullets.append(bullet_text)
        breadcrumb = await text_of('[data-qa="breadcrumb"]') or await text_of(
            'nav[aria-label="breadcrumb"]'
        )
        seller = await text_of('[data-qa="seller-name"]') or await text_of('[class*="sellerName"]')
        return DomDetailFields(
            description=description,
            about_bullets=about_bullets,
            breadcrumb_category=breadcrumb,
            seller_name=seller,
        )


_AMOUNT_RE = re.compile(r"([\d,]+(?:\.\d+)?)")


def _parse_amount(text: str | None) -> float | None:
    if not text:
        return None
    m = _AMOUNT_RE.search(text.replace(",", ""))
    if not m:
        return None
    try:
        return float(m.group(1))
    except ValueError:
        return None


_RATING_RE = re.compile(r"([0-5](?:\.\d)?)")
_REVIEW_COUNT_RE = re.compile(r"\(?([\d,]+)\)?\s*(?:ratings?|reviews?)?")


def _parse_rating(text: str | None) -> float | None:
    if not text:
        return None
    m = _RATING_RE.search(text)
    if not m:
        return None
    val = float(m.group(1))
    return val if 0.0 <= val <= 5.0 else None


_REVIEW_COUNT_KSUFFIX_RE = re.compile(r"([\d,]+(?:\.\d+)?)\s*([KM])\b", re.IGNORECASE)


def _parse_review_count(text: str | None) -> int | None:
    if not text:
        return None
    # noon's review-count element (e.g. "23.7K") carries no parens and uses a K/M suffix —
    # verified 2026-08-07 against a real card DOM. Checked before the parenthesized form since
    # a bare "23.7K" would otherwise fall through to the digits-only branch below and silently
    # truncate to "23".
    ksuffix = _REVIEW_COUNT_KSUFFIX_RE.search(text)
    if ksuffix:
        value = float(ksuffix.group(1).replace(",", ""))
        multiplier = 1_000 if ksuffix.group(2).upper() == "K" else 1_000_000
        return int(round(value * multiplier))
    m = re.search(r"\(([\d,]+)\)", text)
    if not m:
        return None
    digits = m.group(1).replace(",", "")
    return int(digits) if digits.isdigit() else None
