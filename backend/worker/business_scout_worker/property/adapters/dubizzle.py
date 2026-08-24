"""Authored by: Mohit Singh

dubizzle.com (Dubai) adapter. Card selectors and the detail-page phone-reveal flow were verified
live 2026-08-22 via the operator's real Chrome (CDP) against a real "1 bedroom, JVC" search:
- Card container: `div[class*="property-lpv-card"]` — one full listing (price/beds/baths/sqft/
  title/location/verified badge) per card, confirmed via ancestor inspection of a real listing
  anchor.
- Listing detail URL shape: `/property-for-sale/residential/<type>/<YYYY>/<M>/<D>/<slug>-<id>/`
  (date-in-path + slug + a >=6-digit numeric ad ID suffix) — NOT the `/ad/...` shape an earlier,
  unverified guess assumed.
- Phone reveal: clicking the "Call" button on the detail page reveals a real UAE mobile number in
  the page body with NO login required (confirmed: `+971522043855` appeared after one click, no
  redirect, no auth wall) — this is what makes the WhatsApp-link feature possible at all.
- REQUIRES_CDP = True (inherited from base) — dubizzle blocks plain headless Chromium (confirmed:
  an identical URL returns HTTP 200 with an EMPTY body under `p.chromium.launch(headless=True)`,
  while loading fully through CDP-attached real Chrome).

Bathroom filtering is NOT confirmed to have a working server-side URL param on dubizzle (only
`bedrooms=`/`keywords=` were verified) — capture.py applies a client-side bathroom-count floor as a
safety net regardless of whether the URL param actually narrows results server-side, so an
unverified/no-op filter param degrades gracefully rather than silently ignoring the user's filter.

STABLE data-testid SELECTORS (confirmed live 2026-08-22, a real "dubai sports city" 100-listing
run): both the search-card and detail page are MUI-based and expose per-field `data-testid`
attributes — a MUCH more reliable extraction path than the innerText-line-heuristic this file
originally used exclusively. That original heuristic is what caused 3 real bugs found in that same
live run: bedrooms silently null on ~90% of rows (BEDROOMS_RE never matched a hyphen separator —
fixed separately in parse_property.py), the literal string "WhatsApp" stored as location_text (the
card's own WhatsApp CTA button text line won the "last candidate" heuristic — also fixed in
parse_property.py), and description always empty (the old `[class*="description"]` selector
matches nothing on the real MUI markup). `extract_card`/`extract_detail` below now read the
testid-tagged elements DIRECTLY when present, with the regex/heuristic parsers kept ONLY as a
fallback for whatever a testid selector doesn't find (defense in depth if dubizzle's markup drifts
— never remove the fallback layer). Confirmed testids used here: card `listing-price`,
`listing-bedrooms` (2 nodes — count + unit label, `.first` is the count),
`listing-bathrooms` (same shape), `listing-size`, `category-text`, `listing-location`,
`offplan-badge`; detail `description`, `Property Age`, `Average Rent`, `Completion Status`.
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

BASE_URL = "https://dubai.dubizzle.com"

# dubizzle's own URL segment per property_type — "villahouse" (not "villa") verified from the
# off-plan filter links present on every search page; the rest are the same segment as our own
# property_type value.
_TYPE_SEGMENT = {
    "apartment": "apartment",
    "villa": "villahouse",
    "townhouse": "townhouse",
    "penthouse": "penthouse",
    "studio": "apartment",  # dubizzle has no separate studio URL segment — bedrooms=0 does this
}
_PURPOSE_SEGMENT = {"buy": "property-for-sale", "rent": "property-for-rent"}

# Real dubizzle "Sort" dropdown values (2026-08-24) — empirically confirmed live via the operator's
# real Chrome: opened the "Sort: Popular" control on a real JVC apartment search and clicked
# through each option, reading the resulting `sorting=` query param back off the URL. "Popular"
# (the default) carries NO `sorting` param at all — confirmed via the same method, not assumed.
# "Verified" (visually grouped in the same dropdown) is NOT a sort mode — clicking it left the URL
# unchanged, it's the same "Show Verified First" toggle already present elsewhere on the page.
_SORT_PARAM: dict[str, str] = {
    "newest": "date_desc",
    "price_low_high": "price_asc",
    "price_high_low": "price_desc",
}

_CARD_SELECTORS: tuple[str, ...] = (
    'div[class*="property-lpv-card"]',
    'a[href*="/property-for-sale/"]',
)
# Real ad detail URLs carry a >=6-digit numeric ID as the last `-<digits>` segment before the
# trailing slash — e.g. `...-fully-furnished-vaca-2-547320/`.
_LISTING_ID_RE = re.compile(r"-(\d{6,})/?(?:\?.*)?$")
_BLOCKED_TEXT = ("captcha", "verify you are a human", "access denied", "unusual traffic")
_PHONE_RE = re.compile(r"\+?971[\s-]?5\d[\s-]?\d{3}[\s-]?\d{4}")


async def _testid_text(el: ElementHandle | Page, testid: str) -> str | None:
    """Reads `[data-testid="<testid>"]`'s own inner text — the stable-selector fast path shared
    by extract_card (an ElementHandle scoped to one card) and extract_detail (the whole Page).
    Returns None on no-match rather than raising, so every call site can fall through to its own
    regex/heuristic fallback (see module docstring)."""
    node = await el.query_selector(f'[data-testid="{testid}"]')
    if node is None:
        return None
    txt = (await node.inner_text()).strip()
    return txt or None


async def _testid_number(el: ElementHandle | Page, testid: str) -> float | None:
    """Same as _testid_text, plus extracting the first comma-grouped number in it — for fields
    like `listing-price` ("939,998") / `listing-size` ("861") that carry no unit text of their
    own (the unit is a SEPARATE sibling data-testid node, e.g. "sqft")."""
    txt = await _testid_text(el, testid)
    if txt is None:
        return None
    m = re.search(r"[\d,]+(?:\.\d+)?", txt)
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


class DubizzleAdapter(PlatformAdapter):
    platform: ClassVar[str] = "dubizzle"
    default_currency: ClassVar[str] = "AED"
    CARD_SELECTOR: ClassVar[str] = _CARD_SELECTORS[0]
    BLOCK_SELECTORS: ClassVar[tuple[str, ...]] = _CARD_SELECTORS

    def search_url(self, filters: SearchFilters, page: int) -> str:
        purpose_seg = _PURPOSE_SEGMENT.get(filters.purpose, "property-for-sale")
        type_seg = _TYPE_SEGMENT.get(filters.property_type, "apartment")
        params = [f"keywords={quote(filters.location)}"]
        bedrooms = 0 if filters.property_type == "studio" else filters.bedrooms
        if bedrooms is not None:
            params.append(f"bedrooms={bedrooms}")
        if filters.bathrooms is not None:
            # Unverified server-side param (see module docstring) — harmless if dubizzle ignores
            # it; capture.py's client-side floor is the real enforcement either way.
            params.append(f"bathrooms={filters.bathrooms}")
        if filters.sort in _SORT_PARAM:
            params.append(f"sorting={_SORT_PARAM[filters.sort]}")
        if page > 1:
            params.append(f"page={page}")
        return f"{BASE_URL}/en/{purpose_seg}/residential/{type_seg}/?{'&'.join(params)}"

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
                logger.debug("dubizzle banner dismiss skipped", selector=selector, error=str(exc))

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

        anchor = await card.query_selector(
            'a[href*="/property-for-sale/"], a[href*="/property-for-rent/"]'
        )
        href = (await anchor.get_attribute("href")) if anchor is not None else None
        listing_url = self.normalize_listing_url(href, BASE_URL) if href else None

        image_el = await card.query_selector("img")
        image_url = (await image_el.get_attribute("src")) if image_el is not None else None

        # Stable testid selectors first (see module docstring) — query_selector always returns the
        # FIRST DOM match, and for listing-bedrooms/listing-bathrooms that's confirmed to be the
        # numeric count node (it precedes the "beds"/"baths" unit-label sibling in real markup).
        price_val = await _testid_number(card, "listing-price")
        bedrooms_val = await _testid_number(card, "listing-bedrooms")
        bathrooms_val = await _testid_number(card, "listing-bathrooms")
        area_val = await _testid_number(card, "listing-size")
        location_val = await _testid_text(card, "listing-location")
        property_type_val = await _testid_text(card, "category-text")
        # Confirmed live 2026-08-22: presence of this testid IS the off-plan signal — a ready/
        # resale card simply doesn't render it at all (not a "false" value, an absent element).
        offplan_el = await card.query_selector('[data-testid="offplan-badge"]')

        # Regex/heuristic fallback for whatever a testid selector didn't find.
        title, heuristic_location = pp.guess_title_and_location(lines)
        price = pp.parse_price(text)
        bedrooms = pp.parse_bedrooms(text)
        bathrooms = pp.parse_bathrooms(text)
        area = pp.parse_area_sqft(text)

        return DomListingFields(
            title=title,
            listing_url=listing_url,
            image_url=image_url,
            price=price_val if price_val is not None else price.value,
            currency=self.default_currency,
            area_sqft=area_val if area_val is not None else area.value,
            bedrooms=int(bedrooms_val) if bedrooms_val is not None else bedrooms.value,
            bathrooms=int(bathrooms_val) if bathrooms_val is not None else bathrooms.value,
            property_type=property_type_val,
            location_text=location_val or heuristic_location,
            verified=pp.parse_verified(text),
            is_offplan=offplan_el is not None,
        )

    def listing_key(self, href: str | None) -> str | None:
        if not href:
            return None
        m = _LISTING_ID_RE.search(href)
        return m.group(1) if m else None

    async def extract_detail(self, page: Page) -> DomDetailFields:
        phone: str | None = None
        try:
            call_btn = await page.query_selector('button:has-text("Call")')
            if call_btn is not None:
                await call_btn.click(timeout=5000)
                await page.wait_for_timeout(2000)
                body = await page.inner_text("body")
                m = _PHONE_RE.search(body)
                if m:
                    phone = re.sub(r"[\s-]", "", m.group(0))
                    if not phone.startswith("+"):
                        phone = "+" + phone
        except Exception as exc:  # noqa: BLE001 - phone reveal is best-effort, never blocks the job
            logger.info("dubizzle phone reveal failed", error=str(exc))

        description: str | None = None
        try:
            # Confirmed live 2026-08-22: [data-testid="description"] already holds the FULL text
            # in the DOM regardless of the "Read More" button's collapsed/expanded visual state —
            # clicking it is unnecessary. It's also actively harmful: a stray modal (e.g. a promo
            # dialog) can intercept the click and abort this whole block via the except below,
            # losing description extraction for a reason that has nothing to do with the text
            # actually being there. No click at all now.
            description = await _testid_text(page, "description")
            if description is None:
                # Fallback for whatever the testid doesn't find (see module docstring) — this was
                # the ONLY selector before 2026-08-22 and matched nothing on the real MUI markup,
                # which is why description came back empty on every detail-scraped row.
                desc_el = await page.query_selector(
                    '[class*="description"], [class*="Description"]'
                )
                if desc_el is not None:
                    description = (await desc_el.inner_text()).strip() or None
        except Exception as exc:  # noqa: BLE001 - description is best-effort
            logger.debug("dubizzle description extraction skipped", error=str(exc))

        age_years: int | None = None
        try:
            age_text = await _testid_text(page, "Property Age")
            if age_text:
                m = re.search(r"\d+", age_text)
                if m:
                    age_years = int(m.group(0))
        except Exception as exc:  # noqa: BLE001 - not every listing shows an age (e.g. off-plan)
            logger.debug("dubizzle property-age extraction skipped", error=str(exc))

        average_rent: float | None = None
        try:
            rent_text = await _testid_text(page, "Average Rent")
            if rent_text:
                m = re.search(r"[\d,]+", rent_text)
                if m:
                    average_rent = float(m.group(0).replace(",", ""))
        except Exception as exc:  # noqa: BLE001 - not every listing/building has a rent estimate
            logger.debug("dubizzle average-rent extraction skipped", error=str(exc))

        listed_date: str | None = None
        try:
            posted_text = await _testid_text(page, "posted-on")
            if posted_text:
                # Confirmed live: "Posted on:\xa04th June 2026" — strip the label, keep the raw
                # date string as-is (never parsed into a structured date — see module docstring).
                listed_date = re.sub(r"^Posted on:\s*", "", posted_text, flags=re.I).strip() or None
        except Exception as exc:  # noqa: BLE001 - posted date is best-effort
            logger.debug("dubizzle posted-date extraction skipped", error=str(exc))

        image_urls: list[str] = []
        try:
            srcs = await page.eval_on_selector_all(
                "img[src]", "els => els.map(e => e.getAttribute('src'))"
            )
            image_urls = list(
                dict.fromkeys(
                    s
                    for s in srcs
                    if s and ("dubizzle" in s or "olx" in s) and "logo" not in s.lower()
                )
            )[:20]
        except Exception as exc:  # noqa: BLE001 - image gallery is best-effort
            logger.debug("dubizzle image gallery extraction skipped", error=str(exc))

        # Detail-page's own price — confirmed live 2026-08-22: the FIRST `[data-testid="listing-
        # price"]` match on the page is the listing's own price; a "similar properties" carousel
        # further down the page reuses the same testid on unrelated cards, but always sorts after
        # it in DOM order, so query_selector's first-match semantics are safe here (verified
        # against a real listing whose DB-stored card price matched this element exactly).
        price_val: float | None = None
        try:
            price_val = await _testid_number(page, "listing-price")
            if price_val is None:
                body = await page.inner_text("body")
                price_val = pp.parse_price(body).value
        except Exception as exc:  # noqa: BLE001 - price refresh is best-effort
            logger.debug("dubizzle detail-page price extraction skipped", error=str(exc))

        return DomDetailFields(
            description=description,
            phone_number=phone,
            image_urls=image_urls,
            age_years=age_years,
            average_rent=average_rent,
            listed_date=listed_date,
            price=price_val,
        )
