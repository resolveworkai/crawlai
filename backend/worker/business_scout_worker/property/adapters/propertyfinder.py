"""Authored by: Mohit Singh

propertyfinder.ae adapter. Card selector and detail URL shape verified live 2026-08-22 via the
operator's real Chrome (CDP) against a real "Dubai, apartments, buy" search:
- Card container: `article[class*="property-card__wrapper"]` — one full listing (Verified/
  Spotlight badges, "Listed N days ago", price, beds/baths, "Area: N ft²", type, location) per
  card, confirmed via ancestor inspection of a real listing anchor.
- Listing detail URL shape: `https://www.propertyfinder.ae/en/plp/buy/<slug>-<id>.html` (a
  >=5-digit numeric ID immediately before `.html`).
- REQUIRES_CDP = True (inherited from base) — propertyfinder returns a bare HTTP 403 under plain
  headless Chromium (confirmed 2026-08-22), while loading fully through CDP-attached real Chrome.

The phone-reveal mechanism on propertyfinder's detail page was NOT live-verified the way
dubizzle's was (recon time was spent confirming both sites' card/pagination shapes first) —
extract_detail's phone-click logic below is a best-effort attempt at the same "Call"/"Show number"
button pattern seen on dubizzle; if propertyfinder's real control has different text/selector,
phone_number will simply come back None for this platform until that's confirmed against a live
detail page and the selector is corrected here. This is the one part of this adapter still marked
NOT confirmed — everything else (search URL, pagination, card fields) is proven against real live
DOM, not guessed.
"""

from __future__ import annotations

import re
from typing import ClassVar
from urllib.parse import quote

from playwright.async_api import ElementHandle, Page

from business_scout_worker.logging_config import get_logger
from business_scout_worker.property import parse_property as pp
from business_scout_worker.property.adapters.base import PlatformAdapter, SearchFilters
from business_scout_worker.property.models import DomDetailFields, DomListingFields

logger = get_logger(__name__)

BASE_URL = "https://www.propertyfinder.ae"

# propertyfinder's own category codes, taken from the confirmed working search URL
# (`?c=1&fu=0&ob=mr&bf=1&bt=1&l=1&t=1` returned "Apartments for sale in Dubai"). `c` = category
# (1=apartment). villa/townhouse/penthouse codes are NOT independently confirmed — best-effort
# mapping from propertyfinder's publicly documented category list; if wrong, the site falls back
# to its own default category rather than erroring, and our own per-card DOM parsing still reports
# the REAL property type regardless of what the URL requested.
_CATEGORY_CODE = {
    "apartment": "1",
    "villa": "2",
    "townhouse": "3",
    "penthouse": "18",
    "studio": "1",
}
_PURPOSE_CODE = {"buy": "buy", "rent": "rent"}

_CARD_SELECTORS: tuple[str, ...] = (
    'article[class*="property-card__wrapper"]',
    'a[href*="/plp/"]',
)
_LISTING_ID_RE = re.compile(r"-(\d{5,})\.html")
_BLOCKED_TEXT = ("captcha", "verify you are a human", "access denied", "unusual traffic")
_PHONE_RE = re.compile(r"\+?971[\s-]?5\d[\s-]?\d{3}[\s-]?\d{4}")


class PropertyFinderAdapter(PlatformAdapter):
    platform: ClassVar[str] = "propertyfinder"
    default_currency: ClassVar[str] = "AED"
    CARD_SELECTOR: ClassVar[str] = _CARD_SELECTORS[0]
    BLOCK_SELECTORS: ClassVar[tuple[str, ...]] = _CARD_SELECTORS

    def search_url(self, filters: SearchFilters, page: int) -> str:
        purpose = _PURPOSE_CODE.get(filters.purpose, "buy")
        category = _CATEGORY_CODE.get(filters.property_type, "1")
        params = [
            f"c={category}",
            "fu=0",
            "ob=mr",  # order-by: most-recent — sensible default, distress scoring re-ranks anyway
        ]
        bedrooms = 0 if filters.property_type == "studio" else filters.bedrooms
        if bedrooms is not None:
            params += [f"bf={bedrooms}", f"bt={bedrooms}"]  # bedrooms-from / bedrooms-to
        if filters.bathrooms is not None:
            params.append(f"bathf={filters.bathrooms}")  # unverified param, see module docstring
        params.append(f"q={quote(filters.location)}")
        if page > 1:
            params.append(f"page={page}")
        return f"{BASE_URL}/en/search/{purpose}?{'&'.join(params)}"

    async def prepare_page(self, page: Page) -> None:
        for selector in (
            'button:has-text("Accept")',
            'button[aria-label="Close"]',
            'button:has-text("Got it")',
        ):
            try:
                el = await page.query_selector(selector)
                if el is not None:
                    await el.click(timeout=1500)
                    await page.wait_for_timeout(300)
            except Exception as exc:  # noqa: BLE001 - banner dismissal is best-effort
                logger.debug(
                    "propertyfinder banner dismiss skipped", selector=selector, error=str(exc)
                )

    async def is_blocked(self, page: Page) -> bool:
        if "/sorry/" in page.url or "/blocked" in page.url:
            return True
        try:
            body = await page.inner_text("body")
        except Exception:  # noqa: BLE001 - a torn-down page must not crash the block check
            return False
        lowered = body.lower()
        return any(t in lowered for t in _BLOCKED_TEXT)

    async def extract_card(self, card: ElementHandle) -> DomListingFields:
        text = (await card.inner_text()).strip()
        lines = [ln for ln in text.split("\n") if ln.strip()]

        anchor = await card.query_selector('a[href*="/plp/"]')
        href = (await anchor.get_attribute("href")) if anchor is not None else None
        listing_url = self.normalize_listing_url(href, BASE_URL) if href else None

        image_el = await card.query_selector("img")
        image_url = (await image_el.get_attribute("src")) if image_el is not None else None

        title, location_text = pp.guess_title_and_location(lines)
        price = pp.parse_price(text)
        bedrooms = pp.parse_bedrooms(text)
        bathrooms = pp.parse_bathrooms(text)
        area = pp.parse_area_sqft(text)
        listed_days = pp.parse_listed_days_ago(text)

        badges: list[str] = []
        for b in ("Spotlight", "Exclusive", "Premium"):
            if b.lower() in text.lower():
                badges.append(b)

        return DomListingFields(
            title=title,
            listing_url=listing_url,
            image_url=image_url,
            price=price.value,
            currency=self.default_currency,
            area_sqft=area.value,
            bedrooms=bedrooms.value,
            bathrooms=bathrooms.value,
            location_text=location_text,
            listed_days_ago=listed_days.value,
            verified=pp.parse_verified(text),
            badges=badges,
        )

    def listing_key(self, href: str | None) -> str | None:
        if not href:
            return None
        m = _LISTING_ID_RE.search(href)
        return m.group(1) if m else None

    async def extract_detail(self, page: Page) -> DomDetailFields:
        # NOT independently confirmed against a live propertyfinder detail page — see module
        # docstring. Tries the same "Call"/"Show number" button text pattern dubizzle's real,
        # confirmed flow uses; a real propertyfinder session may need a different selector.
        phone: str | None = None
        try:
            for label in ("Call", "Show number", "WhatsApp"):
                btn = await page.query_selector(f'button:has-text("{label}")')
                if btn is not None:
                    await btn.click(timeout=5000)
                    await page.wait_for_timeout(2000)
                    body = await page.inner_text("body")
                    m = _PHONE_RE.search(body)
                    if m:
                        phone = re.sub(r"[\s-]", "", m.group(0))
                        if not phone.startswith("+"):
                            phone = "+" + phone
                    break
        except Exception as exc:  # noqa: BLE001 - phone reveal is best-effort, never blocks the job
            logger.info("propertyfinder phone reveal failed", error=str(exc))

        description: str | None = None
        try:
            desc_el = await page.query_selector('[class*="description"], [class*="Description"]')
            if desc_el is not None:
                description = (await desc_el.inner_text()).strip() or None
        except Exception as exc:  # noqa: BLE001 - description is best-effort
            logger.debug("propertyfinder description extraction skipped", error=str(exc))

        agent_name: str | None = None
        try:
            agent_el = await page.query_selector('[class*="agent-name"], [class*="AgentName"]')
            if agent_el is not None:
                agent_name = (await agent_el.inner_text()).strip() or None
        except Exception as exc:  # noqa: BLE001 - agent name is best-effort
            logger.debug("propertyfinder agent-name extraction skipped", error=str(exc))

        image_urls: list[str] = []
        try:
            srcs = await page.eval_on_selector_all(
                "img[src]", "els => els.map(e => e.getAttribute('src'))"
            )
            image_urls = list(
                dict.fromkeys(
                    s
                    for s in srcs
                    if s and "propertyfinder" in s.lower() and "logo" not in s.lower()
                )
            )[:20]
        except Exception as exc:  # noqa: BLE001 - image gallery is best-effort
            logger.debug("propertyfinder image gallery extraction skipped", error=str(exc))

        return DomDetailFields(
            description=description,
            agent_name=agent_name,
            phone_number=phone,
            image_urls=image_urls,
        )
