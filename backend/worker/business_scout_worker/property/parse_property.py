"""Authored by: Mohit Singh

Stage B field parsing for the Property Research pipeline — pure regex functions, shared by both
adapters' `extract_card`/`extract_detail`. Both dubizzle.com and propertyfinder.ae render a card's
price/beds/baths/area/title/location as adjacent text nodes rather than exposing each behind a
stable per-field selector (confirmed 2026-08-22 via live DOM inspection — the field VALUES are
real DOM text, this module just locates them within the card's own `innerText` rather than one
`querySelector` per field, since neither site's markup offers that). This is still DOM-first (real
page text, not OCR'd pixels) — the OCR fallback in pipeline.py only kicks in when a card's
screenshot is the only thing left to read (a genuinely missing field, not a parsing gap here).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from business_scout_worker.property.models import DomListingFields, ParsedListing

# AED/USD/GBP + amount, comma-grouped. Both sites show AED for UAE listings.
PRICE_RE = re.compile(r"(?:AED|USD|GBP|SAR)\s*\xa0?\s*([\d,]{4,})", re.I)
# Real captured titles (2026-08-22 live dubizzle run, "dubai sports city") showed a HYPHEN
# separator ("2-Bedroom", "2-bhk") that the original whitespace-only separator class missed
# entirely — bedrooms came back null on ~90% of rows despite the title spelling it out plainly.
# BHK ("Bedroom-Hall-Kitchen") is a real, common notation on Dubai listings alongside "Bed"/"BR".
BEDROOMS_RE = re.compile(r"\b(\d+)[\s\xa0-]*(?:Bed(?:room)?s?\b|BR\b|BHK\b)", re.I)
# Studio listings show "Studio" instead of a bedroom count — mapped to 0 bedrooms.
STUDIO_RE = re.compile(r"\bstudio\b", re.I)
BATHROOMS_RE = re.compile(r"\b(\d+)\s*\xa0?\s*baths?\b", re.I)
AREA_SQFT_RE = re.compile(r"([\d,]{2,})\s*\xa0?\s*(?:sq\s?ft|ft²|sqft)", re.I)
LISTED_DAYS_AGO_RE = re.compile(r"Listed\s+(\d+)\s+days?\s+ago", re.I)
LISTED_TODAY_RE = re.compile(r"Listed\s+(?:today|yesterday)", re.I)
# propertyfinder shows "Listed N weeks/months/years ago" for older listings (confirmed live
# 2026-08-22 — "Listed 2 months ago"), not just "N days ago" — LISTED_DAYS_AGO_RE alone left every
# such card's freshness silently None, which also silently understates analysis.py's freshness
# signal for anything older than ~29 days. Converted to an approximate day count (30/365 per
# month/year) since the UI only ever shows a rounded unit anyway, not an exact day count.
LISTED_AGO_UNIT_RE = re.compile(r"Listed\s+(\d+)\s+(day|week|month|year)s?\s+ago", re.I)
_LISTED_AGO_UNIT_DAYS = {"day": 1, "week": 7, "month": 30, "year": 365}

# Distress-sale language a real buyer would look for — title/description keyword scan feeding
# analysis.py's distress_score. Deliberately broad (a false-positive keyword match costs nothing;
# a missed one loses a real signal) but each phrase is genuinely distress-adjacent, not generic
# marketing ("motivated seller" is a real signal, "spacious" is not).
DISTRESS_KEYWORDS = (
    "motivated seller",
    "must sell",
    "urgent sale",
    "urgent",
    "distress",
    "below market",
    "quick sale",
    "reduced price",
    "price reduced",
    "negotiable",
    "vacant on transfer",
    "owner leaving",
    "relocating",
    "below original price",
)

VERIFIED_RE = re.compile(r"\bverified\b", re.I)

# Real captured cards (2026-08-22 live dubizzle run) include a "WhatsApp" contact-button label as
# its own text line — it passes every other noise check (long enough, alpha-heavy, no price/beds/
# baths/date match), so it was winning as the "last candidate" and getting stored as the
# location_text on ~90% of rows instead of the real community string. Any single-word UI/CTA
# button label goes here, not just WhatsApp — the same class of bug applies to "Call"/"Chat"/etc.
_UI_ACTION_WORDS = frozenset(
    {
        "whatsapp",
        "call",
        "chat",
        "message",
        "contact",
        "share",
        "save",
        "compare",
        "favourite",
        "favorite",
    }
)


@dataclass
class _Field:
    value: Any = None
    confidence: float = 0.0


def parse_price(text: str) -> _Field:
    m = PRICE_RE.search(text)
    if not m:
        return _Field()
    try:
        return _Field(value=float(m.group(1).replace(",", "")), confidence=85.0)
    except ValueError:
        return _Field()


def parse_bedrooms(text: str) -> _Field:
    if STUDIO_RE.search(text):
        return _Field(value=0, confidence=90.0)
    m = BEDROOMS_RE.search(text)
    if not m:
        return _Field()
    return _Field(value=int(m.group(1)), confidence=80.0)


def parse_bathrooms(text: str) -> _Field:
    m = BATHROOMS_RE.search(text)
    if not m:
        return _Field()
    return _Field(value=int(m.group(1)), confidence=80.0)


def parse_area_sqft(text: str) -> _Field:
    m = AREA_SQFT_RE.search(text)
    if not m:
        return _Field()
    try:
        return _Field(value=float(m.group(1).replace(",", "")), confidence=80.0)
    except ValueError:
        return _Field()


def parse_listed_days_ago(text: str) -> _Field:
    if LISTED_TODAY_RE.search(text):
        return _Field(value=0, confidence=85.0)
    m = LISTED_DAYS_AGO_RE.search(text)
    if m:
        return _Field(value=int(m.group(1)), confidence=85.0)
    m2 = LISTED_AGO_UNIT_RE.search(text)
    if not m2:
        return _Field()
    unit_days = _LISTED_AGO_UNIT_DAYS[m2.group(2).lower()]
    # Approximate (see LISTED_AGO_UNIT_RE's comment) — lower confidence than the exact-days match.
    return _Field(value=int(m2.group(1)) * unit_days, confidence=60.0)


def parse_verified(text: str) -> bool:
    return bool(VERIFIED_RE.search(text))


def find_distress_keywords(text: str) -> list[str]:
    lowered = text.lower()
    return [kw for kw in DISTRESS_KEYWORDS if kw in lowered]


def guess_title_and_location(lines: list[str]) -> tuple[str | None, str | None]:
    """Heuristic split of a card's non-empty text lines into (title, location): the title is the
    longest letters-heavy line that isn't a price/beds/baths/sqft/badge token, and the location is
    the LAST such candidate line (both sites put the community/area string at the end of the
    card). Falls back to (None, None) when nothing plausible is found — the caller then leaves
    both for the OCR fallback rather than guessing wrong."""
    noise = (PRICE_RE, BEDROOMS_RE, BATHROOMS_RE, AREA_SQFT_RE, LISTED_DAYS_AGO_RE, VERIFIED_RE)
    candidates = []
    for raw in lines:
        line = raw.strip()
        if len(line) < 6 or sum(c.isalpha() for c in line) < 5:
            continue
        if any(p.search(line) for p in noise):
            continue
        if line.lower() in ("apartment", "villa", "townhouse", "penthouse", "studio"):
            continue
        if line.lower() in _UI_ACTION_WORDS:
            continue
        candidates.append(line)
    if not candidates:
        return None, None
    title = max(candidates, key=len)
    location = (
        candidates[-1]
        if candidates[-1] != title or len(candidates) == 1
        else (candidates[-2] if len(candidates) > 1 else None)
    )
    return title, location


def parse_listing(
    ocr_text: str,
    *,
    idx: int,
    title: str,
    listing_url: str | None,
    image_url: str | None,
    page_num: int,
    dom: DomListingFields | None = None,
    ocr_confidence: float = 0.0,
    default_currency: str = "AED",
) -> ParsedListing:
    """Combines the DOM-extracted fields (authoritative — from adapters/*.extract_card) with
    whatever this module can additionally parse from `ocr_text` (the OCR'd card screenshot,
    used only as a last-resort fallback when DOM extraction came back genuinely empty — see
    pipeline.py's `_dom_is_complete` gate). Mirrors ecom/parse_product.py's parse_product()
    DOM-wins-over-OCR merge + needs_review shape. `idx`/`title`/`listing_url`/`image_url` always
    come from the capture step, never re-derived here."""
    dom = dom or DomListingFields()

    price = dom.price if dom.price is not None else parse_price(ocr_text).value
    area = dom.area_sqft if dom.area_sqft is not None else parse_area_sqft(ocr_text).value
    bedrooms = dom.bedrooms if dom.bedrooms is not None else parse_bedrooms(ocr_text).value
    bathrooms = dom.bathrooms if dom.bathrooms is not None else parse_bathrooms(ocr_text).value
    listed_days = (
        dom.listed_days_ago
        if dom.listed_days_ago is not None
        else parse_listed_days_ago(ocr_text).value
    )

    dom_has_core = dom.price is not None or dom.area_sqft is not None or dom.title is not None
    extraction_source = (
        "dom" if dom_has_core and not ocr_text else ("dom+ocr" if dom_has_core else "ocr")
    )

    price_ok = price is None or price > 0
    needs_review = not dom_has_core or not price_ok

    keywords = find_distress_keywords(dom.title or title)

    return ParsedListing(
        idx=idx,
        page_num=page_num,
        title=dom.title or title,
        listing_url=dom.listing_url or listing_url,
        image_urls=[dom.image_url or image_url] if (dom.image_url or image_url) else [],
        price=price,
        currency=dom.currency or default_currency,
        area_sqft=area,
        bedrooms=bedrooms,
        bathrooms=bathrooms,
        property_type=dom.property_type,
        location_text=dom.location_text,
        community=dom.community,
        listed_days_ago=listed_days,
        verified=dom.verified,
        badges=dom.badges,
        is_offplan=dom.is_offplan,
        distress_keywords=keywords,
        extraction_source=extraction_source,
        ocr_confidence=ocr_confidence if ocr_text else None,
        needs_review=needs_review,
    )
