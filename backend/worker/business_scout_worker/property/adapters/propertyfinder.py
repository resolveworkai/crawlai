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

Search URL — REBUILT 2026-08-22 (was returning 0 results for every job). Two real bugs, both
confirmed via live recon against the operator's real Chrome + direct API calls, neither guessed:
1. The results path was `/en/search/{purpose}` (e.g. `/en/search/buy?...`) — that path is a bare
   404 on the real site. The real path is just `/en/search` with NO purpose segment; purpose is
   controlled entirely by the `fu` query param (`fu=0` = buy/for-sale, `fu=1` = rent — confirmed by
   comparing real listing prices at each value: ~1.9M AED sale vs ~560K AED/yr rent for the same
   community).
2. The location filter was `q=<free-text location>` — that param is silently ignored (propertyfinder
   has no free-text location search on this endpoint at all; it returns an unfiltered, whole-UAE
   result set instead, which is exactly the "0 relevant results" symptom this was reported as).
   propertyfinder resolves a location name to a location the same way its own UI does: a public,
   unauthenticated GET to `{BASE_URL}/b2c-location/api/v1/en/locations` (confirmed via direct curl,
   no CDP/session needed) returns a ranked list of `{id, name, location_type, level}` matches; the
   working URL param is `l=<id>&t=1` (confirmed: `l=73&t=1` for the resolved "Jumeirah Village
   Circle" id correctly returned "Apartments for sale in Jumeirah Village Circle - 9,144 Flats").
   Resolved ONCE per job in resolve_location() (an async hook called before pagination begins,
   since search_url() itself must stay synchronous — see base.py) and cached on the instance.

Off-plan detection (2026-08-22): unlike dubizzle's single `data-testid="offplan-badge"` element,
propertyfinder's card badges carry the literal text "Offplan" (e.g. "Offplan: First Sale") when a
listing is off-plan — confirmed live across real search results. Checked case-insensitively against
each badge element's own text (not the whole card, to avoid a false match from unrelated prose).

The phone-reveal mechanism on propertyfinder's detail page was NOT live-verified the way dubizzle's
was (recon time was spent confirming the search/card/pagination shapes) — extract_detail's
phone-click logic below is a best-effort attempt at the same "Call"/"Show number" button pattern
seen on dubizzle; if propertyfinder's real control has different text/selector, phone_number will
simply come back None for this platform until that's confirmed against a live detail page and the
selector is corrected here. This is the one part of this adapter still marked NOT confirmed —
everything else (search URL, pagination, card fields, off-plan badge) is proven against real live
DOM/API responses, not guessed.
"""

from __future__ import annotations

import re
from typing import Any, ClassVar

from playwright.async_api import BrowserContext, ElementHandle, Page

from business_scout_worker.logging_config import get_logger
from business_scout_worker.property import parse_property as pp
from business_scout_worker.property.adapters.base import PlatformAdapter, SearchFilters
from business_scout_worker.property.models import DomDetailFields, DomListingFields

logger = get_logger(__name__)

BASE_URL = "https://www.propertyfinder.ae"

# propertyfinder's own category codes, taken from the confirmed working search URL
# (`?c=1&fu=0&ob=mr&l=73&t=1` returned "Apartments for sale in Jumeirah Village Circle"). `c` =
# category (1=apartment). villa/townhouse/penthouse codes are NOT independently confirmed —
# best-effort mapping from propertyfinder's publicly documented category list; if wrong, the site
# falls back to its own default category rather than erroring, and our own per-card DOM parsing
# still reports the REAL property type regardless of what the URL requested. Also used as the
# `filters.category_id` param on the location-resolution API call (confirmed working for both
# category_id=1 and category_id=2 — see resolve_location()).
_CATEGORY_CODE = {
    "apartment": "1",
    "villa": "2",
    "townhouse": "3",
    "penthouse": "18",
    "studio": "1",
}

_CARD_SELECTORS: tuple[str, ...] = (
    'article[class*="property-card__wrapper"]',
    'a[href*="/plp/"]',
)
_LISTING_ID_RE = re.compile(r"-(\d{5,})\.html")
_BLOCKED_TEXT = ("captcha", "verify you are a human", "access denied", "unusual traffic")
_PHONE_RE = re.compile(r"\+?971[\s-]?5\d[\s-]?\d{3}[\s-]?\d{4}")
_BADGE_SELECTOR = '[class*="badge" i], [class*="tag-container" i]'


async def _testid_text(el: ElementHandle | Page, testid: str) -> str | None:
    """Reads `[data-testid="<testid>"]`'s own inner text — the stable-selector fast path, same
    convention as dubizzle.py's own helper of the same name (kept as a separate copy here, not a
    shared import, per this module's own "each adapter is self-contained" pattern). Returns None
    on no-match rather than raising, so every call site can fall through to its own regex/heuristic
    fallback (see extract_card below)."""
    node = await el.query_selector(f'[data-testid="{testid}"]')
    if node is None:
        return None
    txt = (await node.inner_text()).strip()
    return txt or None


async def _testid_number(el: ElementHandle | Page, testid: str) -> float | None:
    """Same as _testid_text, plus extracting the first comma-grouped number in it — for fields
    like `property-card-price` ("1,950,000") / `property-card-spec-bedroom` ("2") that render as a
    bare number next to an icon, with no unit/label text of their own (confirmed live 2026-08-22 —
    this is exactly why the generic AED/Bed/bath-word regex fallback in parse_property.py never
    matched a propertyfinder card: there's no such word anywhere in the card's text at all)."""
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


class PropertyFinderAdapter(PlatformAdapter):
    platform: ClassVar[str] = "propertyfinder"
    default_currency: ClassVar[str] = "AED"
    CARD_SELECTOR: ClassVar[str] = _CARD_SELECTORS[0]
    BLOCK_SELECTORS: ClassVar[tuple[str, ...]] = _CARD_SELECTORS

    def __init__(self) -> None:
        # Set by resolve_location() once per job, before pagination starts — search_url() reads it
        # synchronously on every page. None = location lookup failed/found nothing; search_url()
        # then falls back to an unfiltered (whole-UAE) search rather than erroring the job.
        self._location_id: int | None = None

    async def resolve_location(self, context: BrowserContext, filters: SearchFilters) -> None:
        """One-time async lookup of filters.location -> propertyfinder's own numeric location id
        (see module docstring, bug 2). Uses context.request (shares the CDP session's cookies, no
        extra page needed — confirmed working live 2026-08-22) rather than adding a new HTTP
        dependency. Best-effort: any failure leaves self._location_id as None so the job still
        runs (unfiltered) instead of failing outright."""
        self._location_id = None
        category = _CATEGORY_CODE.get(filters.property_type, "1")
        try:
            resp = await context.request.get(
                f"{BASE_URL}/b2c-location/api/v1/en/locations",
                params={
                    "filters.category_id": category,
                    "filters.name": filters.location,
                    "pagination.limit": "5",
                    "filters.use_popularity": "true",
                },
                timeout=10000,
            )
            if resp.ok:
                data: dict[str, Any] = await resp.json()
                attrs = data.get("data", {}).get("attributes", [])
                if attrs:
                    self._location_id = attrs[0].get("id")
        except Exception as exc:  # noqa: BLE001 - location resolution is best-effort, see docstring
            logger.warning(
                "propertyfinder location resolution failed",
                location=filters.location,
                error=str(exc),
            )
        if self._location_id is None:
            logger.warning(
                "propertyfinder location not resolved — search will run unfiltered (whole UAE)",
                location=filters.location,
            )

    def search_url(self, filters: SearchFilters, page: int) -> str:
        purpose_fu = "0" if filters.purpose == "buy" else "1"  # confirmed 2026-08-22, see docstring
        category = _CATEGORY_CODE.get(filters.property_type, "1")
        params = [
            f"c={category}",
            f"fu={purpose_fu}",
            "ob=mr",  # order-by: most-recent — sensible default, distress scoring re-ranks anyway
        ]
        bedrooms = 0 if filters.property_type == "studio" else filters.bedrooms
        if bedrooms is not None:
            params += [f"bf={bedrooms}", f"bt={bedrooms}"]  # bedrooms-from / bedrooms-to
        if filters.bathrooms is not None:
            params.append(f"bathf={filters.bathrooms}")  # unverified param, see module docstring
        if self._location_id is not None:
            params += [f"l={self._location_id}", "t=1"]
        if page > 1:
            params.append(f"page={page}")
        return f"{BASE_URL}/en/search?{'&'.join(params)}"

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

        # The card's own gallery renders each real photo as a lazy-loaded placeholder.webp/real-src
        # <img> PAIR (confirmed live 2026-08-22) — the plain first-<img> a naive `query_selector`
        # would grab is always the placeholder, never a real photo. Picks the first genuine listing
        # image (its own CDN path, never the placeholder or an agent/broker logo).
        image_srcs = await card.eval_on_selector_all(
            "img", "els => els.map(e => e.getAttribute('src') || '')"
        )
        image_url = next(
            (
                s
                for s in image_srcs
                if s
                and "placeholder" not in s.lower()
                and "agent_image" not in s.lower()
                and "client_logos" not in s.lower()
            ),
            None,
        )

        # Stable testid selectors first (confirmed live 2026-08-22 — see module docstring). This
        # is the primary path: propertyfinder renders price/beds/baths as a bare number next to an
        # icon glyph, with NO "AED"/"Bed"/"bath" text anywhere on the card, so parse_property.py's
        # generic word-anchored regexes (built against dubizzle's differently-labelled cards) never
        # match a propertyfinder card at all — every one of these fields silently came back None
        # until this fix, even though the search itself was already returning real listings.
        price_val = await _testid_number(card, "property-card-price")
        bedrooms_val = await _testid_number(card, "property-card-spec-bedroom")
        bathrooms_val = await _testid_number(card, "property-card-spec-bathroom")
        area_val = await _testid_number(card, "property-card-spec-area")
        location_val = await _testid_text(card, "property-card-location")
        property_type_val = await _testid_text(card, "property-card-spec-propertyType")

        # Regex/heuristic fallback for whatever a testid selector didn't find (mirrors dubizzle.py's
        # own fallback-chaining pattern exactly).
        title, heuristic_location = pp.guess_title_and_location(lines)
        price = pp.parse_price(text)
        bedrooms = pp.parse_bedrooms(text)
        bathrooms = pp.parse_bathrooms(text)
        area = pp.parse_area_sqft(text)
        listed_days = pp.parse_listed_days_ago(text)

        badges: list[str] = []
        for b in ("Spotlight", "Exclusive", "Premium"):
            if b.lower() in text.lower():
                badges.append(b)

        # Off-plan detection — confirmed live 2026-08-22: propertyfinder's own badge elements carry
        # the literal text "Offplan" (e.g. "Offplan: First Sale") on off-plan listings. Checked
        # against each badge element's own text individually (not the whole card) so an unrelated
        # word elsewhere on the card can't false-positive.
        is_offplan = False
        try:
            badge_texts = await card.eval_on_selector_all(
                _BADGE_SELECTOR, "els => els.map(e => e.innerText || '')"
            )
            is_offplan = any("offplan" in (t or "").lower() for t in badge_texts)
        except Exception as exc:  # noqa: BLE001 - off-plan detection is best-effort
            logger.debug("propertyfinder offplan-badge check skipped", error=str(exc))

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
            listed_days_ago=listed_days.value,
            verified=pp.parse_verified(text),
            badges=badges,
            is_offplan=is_offplan,
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

        # Detail-page's own price — confirmed live 2026-08-22: `[data-testid="property-price"]` is
        # unique on the page (verified count == 1 against a real listing).
        price_val: float | None = None
        try:
            price_val = await _testid_number(page, "property-price")
            if price_val is None:
                body = await page.inner_text("body")
                price_val = pp.parse_price(body).value
        except Exception as exc:  # noqa: BLE001 - price refresh is best-effort
            logger.debug("propertyfinder detail-page price extraction skipped", error=str(exc))

        return DomDetailFields(
            description=description,
            agent_name=agent_name,
            phone_number=phone,
            image_urls=image_urls,
            price=price_val,
        )
