"""Authored by: Mohit Singh

Stage B field parsing for the e-commerce pipeline — pure regex functions over a merged OCR line
list (mirrors ocr/parse_fields.py's style/shape exactly, retargeted at product-listing fields
instead of Maps-panel fields). idx/title/product_url/image_url are NOT parsed here (they come
from the DOM capture, authoritative) — this module only fills whatever the DOM adapter missed:
price, rating, review_count, bought_past_month, free_delivery, delivery_date, discount_pct, and
rank_in_category/category (from a "#N in <category>" badge line).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from business_scout_worker.ecom.models import DomProductFields, ParsedProduct
from business_scout_worker.ocr.ocr_engine import OcrLine, OcrResult

# Currency + amount: AED, د.إ, SAR, or $ followed by a number with optional thousands separators.
PRICE_RE = re.compile(
    r"(?:AED|SAR|USD|\$|د\.إ)\s*([\d]{1,3}(?:[,\s]\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)",
    re.I,
)
RATING_RE = re.compile(r"\b([0-5](?:\.\d)?)\s*(?:out of\s*5)?\b", re.I)
REVIEWS_RE = re.compile(r"\(?([\d,]+)\)?\s*(?:ratings?|reviews?)\b", re.I)
BOUGHT_RE = re.compile(r"([\d,]+)\+?\s*bought in (?:the )?past month", re.I)
# AliExpress demand signal ("4,000+ sold", "2,000+ sold") — the analogue of Amazon's
# bought-in-past-month; feeds the same bought_past_month field so the opportunity score's demand
# component works uniformly across platforms. OCRs cleanly (Latin digits) even when other fields
# lose a decimal.
SOLD_RE = re.compile(r"([\d,]+)\+?\s*sold\b", re.I)
FREE_DELIVERY_RE = re.compile(r"free (?:delivery|shipping)", re.I)
DELIVERY_DATE_RE = re.compile(
    r"(?:Get it|Delivery|Arrives)\b[^\n]*?"
    r"((?:Tomorrow|Today)|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*,?\s*\d{1,2}\s*[A-Za-z]{3,9})",
    re.I,
)
DISCOUNT_RE = re.compile(r"(\d{1,3})\s*%\s*off", re.I)
BADGE_RE = re.compile(r"#\s*(\d+)\s*in\s*([A-Za-z0-9 &'/-]+)", re.I)
# The capture step's placeholder when the adapter read no DOM title (pure-OCR platforms) — see
# ecom/capture.py's `title = dom.title or f"Product {n}"`.
_PLACEHOLDER_TITLE_RE = re.compile(r"^Product \d+$")


@dataclass
class _Field:
    value: Any = None
    confidence: float = 0.0
    source_line: str | None = None


def _parse_price(lines: list[OcrLine]) -> _Field:
    for line in lines:
        m = PRICE_RE.search(line.text)
        if m:
            raw = m.group(1).replace(",", "").replace(" ", "")
            try:
                return _Field(value=float(raw), confidence=line.confidence, source_line=line.text)
            except ValueError:
                continue
    return _Field()


def _parse_rating(lines: list[OcrLine]) -> _Field:
    for line in lines:
        m = RATING_RE.search(line.text)
        if m:
            val = float(m.group(1))
            if 0.0 <= val <= 5.0:
                return _Field(value=val, confidence=line.confidence, source_line=line.text)
    return _Field()


def _parse_reviews(lines: list[OcrLine]) -> _Field:
    for line in lines:
        m = REVIEWS_RE.search(line.text)
        if m:
            digits = m.group(1).replace(",", "")
            if digits.isdigit():
                return _Field(value=int(digits), confidence=line.confidence, source_line=line.text)
    return _Field()


def _parse_bought(lines: list[OcrLine]) -> _Field:
    for line in lines:
        m = BOUGHT_RE.search(line.text)
        if m:
            digits = m.group(1).replace(",", "")
            if digits.isdigit():
                return _Field(value=int(digits), confidence=line.confidence, source_line=line.text)
    return _Field()


def _parse_sold(lines: list[OcrLine]) -> _Field:
    for line in lines:
        m = SOLD_RE.search(line.text)
        if m:
            digits = m.group(1).replace(",", "")
            if digits.isdigit():
                return _Field(value=int(digits), confidence=line.confidence, source_line=line.text)
    return _Field()


# Lines that are chrome, NOT a product title (price/sold/promo/delivery). Deliberately does NOT
# include badge words like "Choice" — those bleed into the start of the real title line on an
# AliExpress card, so we strip them as a prefix (below) rather than rejecting the whole line.
_TITLE_SKIP_RE = re.compile(
    r"(\bsold\b|\bsave\b|shipping|delivery|%\s*off|top selling|new shopper|\$|"
    r"^\s*[\d.,+\s|-]+\s*$)",
    re.I,
)
# Leading badge/promo tokens OCR prepends to the title line — stripped from the front only.
_TITLE_PREFIX_RE = re.compile(r"^\s*(choice|best\s*seller|ad|sponsored)\b[\s:|-]*", re.I)


def _derive_title(lines: list[OcrLine]) -> str | None:
    """Pure-OCR title fallback: pick the longest text-heavy line that isn't price/sold/promo chrome,
    then strip a leading badge token (e.g. "Choice"). Noisy by nature (the card visually truncates
    long titles), but it's the only title source when the adapter reads nothing from the DOM
    (AliExpress). Returns None if nothing plausible was OCR'd."""
    best: str | None = None
    for line in lines:
        text = line.text.strip()
        if sum(c.isalpha() for c in text) < 8:  # too few letters to be a title
            continue
        if _TITLE_SKIP_RE.search(text):
            continue
        if best is None or len(text) > len(best):
            best = text
    if best is None:
        return None
    stripped = _TITLE_PREFIX_RE.sub("", best).strip()
    return stripped or best


def _parse_free_delivery(lines: list[OcrLine]) -> _Field:
    for line in lines:
        if FREE_DELIVERY_RE.search(line.text):
            return _Field(value=True, confidence=line.confidence, source_line=line.text)
    return _Field(value=False)


def _parse_delivery_date(lines: list[OcrLine]) -> _Field:
    for line in lines:
        m = DELIVERY_DATE_RE.search(line.text)
        if m:
            return _Field(
                value=m.group(0).strip(), confidence=line.confidence, source_line=line.text
            )
    return _Field()


def _parse_discount(lines: list[OcrLine]) -> _Field:
    for line in lines:
        m = DISCOUNT_RE.search(line.text)
        if m:
            val = float(m.group(1))
            if 0.0 <= val <= 100.0:
                return _Field(value=val, confidence=line.confidence, source_line=line.text)
    return _Field()


def _parse_badge_rank(lines: list[OcrLine]) -> tuple[_Field, _Field]:
    """Returns (rank_in_category, category) from a "#N in <category>" badge line."""
    for line in lines:
        m = BADGE_RE.search(line.text)
        if m:
            rank = _Field(value=int(m.group(1)), confidence=line.confidence, source_line=line.text)
            category = _Field(
                value=m.group(2).strip(), confidence=line.confidence, source_line=line.text
            )
            return rank, category
    return _Field(), _Field()


def parse_product(
    lines: list[OcrLine],
    *,
    idx: int,
    title: str,
    product_url: str | None = None,
    image_url: str | None = None,
    page_num: int = 1,
    ocr: OcrResult | None = None,
    dom: DomProductFields | None = None,
    default_currency: str = "AED",
) -> ParsedProduct:
    """Combines the DOM-extracted fields (authoritative, exact — see ecom/models.py's
    DomProductFields) with whatever this module parses from the OCR line list, mirroring
    ocr/parse_fields.py's DOM-wins-over-OCR merge + needs_review logic. `idx`/`title`/
    `product_url`/`image_url` always come from the capture step (never parsed here)."""
    dom = dom or DomProductFields()

    price = _parse_price(lines)
    rating = _parse_rating(lines)
    reviews = _parse_reviews(lines)
    bought = _parse_bought(lines)
    sold = _parse_sold(lines)
    free_delivery = _parse_free_delivery(lines)
    delivery_date = _parse_delivery_date(lines)
    discount = _parse_discount(lines)
    rank, category = _parse_badge_rank(lines)

    # Pure-OCR platforms (AliExpress) read no title from the DOM, so the capture step handed us a
    # "Product N" placeholder — derive a real title from the OCR text in that case only.
    derived_title = (
        _derive_title(lines) if dom.title is None and _PLACEHOLDER_TITLE_RE.match(title) else None
    )

    final_price = dom.price if dom.price is not None else price.value
    final_list_price = dom.list_price
    final_rating = dom.rating if dom.rating is not None else rating.value
    final_reviews = dom.review_count if dom.review_count is not None else reviews.value
    # bought_past_month is the shared demand field: DOM value wins, then Amazon "bought in past
    # month", then AliExpress "N sold".
    final_bought = (
        dom.bought_past_month
        if dom.bought_past_month is not None
        else (bought.value if bought.value is not None else sold.value)
    )
    final_bought_raw = dom.bought_past_month_raw
    final_free_delivery = dom.free_delivery or bool(free_delivery.value)
    final_delivery_date = dom.delivery_date or delivery_date.value
    final_discount = dom.discount_pct if dom.discount_pct is not None else discount.value
    final_category = dom.category or category.value
    final_rank = dom.rank_in_category if dom.rank_in_category is not None else rank.value

    contributing = [
        f.confidence
        for f in (price, rating, reviews, bought, sold, delivery_date, discount)
        if f.value is not None
    ]
    ocr_confidence = (
        sum(contributing) / len(contributing)
        if contributing
        else (ocr.mean_confidence if ocr is not None else 0.0)
    )

    price_ok = dom.price is not None or final_price is None or final_price > 0
    rating_ok = dom.rating is not None or final_rating is None or 0.0 <= float(final_rating) <= 5.0
    dom_covered_key_fields = dom.price is not None or dom.rating is not None
    needs_review = (
        (not dom_covered_key_fields and ocr_confidence < 70) or not price_ok or not rating_ok
    )

    extraction_source: str
    dom_has_any = any(
        v is not None for v in (dom.price, dom.rating, dom.review_count, dom.title, dom.product_url)
    )
    ocr_used = bool(contributing)
    if dom_has_any and ocr_used:
        extraction_source = "dom+ocr"
    elif dom_has_any:
        extraction_source = "dom"
    else:
        extraction_source = "ocr"

    return ParsedProduct(
        idx=idx,
        page_num=page_num,
        title=dom.title or derived_title or title,
        product_url=dom.product_url or product_url,
        image_url=dom.image_url or image_url,
        price=final_price,
        list_price=final_list_price,
        currency=dom.currency or default_currency,
        discount_pct=final_discount,
        rating=final_rating,
        review_count=final_reviews,
        bought_past_month=final_bought,
        bought_past_month_raw=final_bought_raw,
        free_delivery=final_free_delivery,
        delivery_date=final_delivery_date,
        category=final_category,
        badges=dom.badges,
        rank_in_category=final_rank,
        sponsored=dom.sponsored,
        extraction_source=extraction_source,
        ocr_confidence=round(ocr_confidence, 1),
        needs_review=needs_review,
        raw_text=ocr.raw_text if ocr is not None else None,
        source_images=[],
    )
