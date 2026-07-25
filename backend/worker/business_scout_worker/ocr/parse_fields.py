"""Authored by: Mohit Singh

Stage B field parsing (§B4) — pure functions over the merged OCR line list. Each returns
(value, confidence, source_line) so a misread lands in `needs_review` rather than as a silently-
wrong "clean" row. name + maps_url are NOT parsed here (they come from the manifest/DOM,
authoritative). Rules are tuned for the Google Maps English panel; UAE phone format first.
"""

from __future__ import annotations

import re

from business_scout_worker.ocr.models import DomFields, ParsedBusiness, ParsedField
from business_scout_worker.ocr.ocr_engine import OcrLine, OcrResult

RATING_RE = re.compile(r"\b([0-5][.,]\d)\b")
REVIEWS_RE = re.compile(r"\(([\d,.]+)\)")
PHONE_UAE_RE = re.compile(r"(?:\+971|00971|0)[\s-]?\d{1,2}[\s-]?\d{3}[\s-]?\d{4}")
PHONE_GENERIC_RE = re.compile(r"\+\d[\d\s-]{6,15}\d")
DOMAIN_RE = re.compile(r"\b(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}\b", re.I)
PLUS_CODE_RE = re.compile(r"\b[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}\b")
EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
# Standalone rating line ("4.8" on its own line — the Maps panel's rating display, which OCR
# emits separately from the review count). Tolerates a trailing star/icon glyph.
STANDALONE_RATING_RE = re.compile(r"^\s*([0-5][.,]\d)\b")
# Hours: the separator between "Open" and "Closes" is whatever OCR read (":", "·", " ") and the
# time may be "12AM" (no space) — kept lenient. `[^\n]*?` because OCR joins the row onto one line.
HOURS_SUMMARY_RE = re.compile(
    r"(Open 24 hours|Temporarily closed|Permanently closed|"
    r"Open\b[^\n]*?Closes\s*\d{1,2}(?::\d{2})?\s*[AP]M|"
    r"Closed\b[^\n]*?Opens\s*\d{1,2}(?::\d{2})?\s*[AP]M|"
    r"Closes\s*\d{1,2}(?::\d{2})?\s*[AP]M|Closed)",
    re.I,
)
# Leading map-pin / link glyphs OCR emits before real values (©, @, ®, ·, dots, arrows).
LEADING_GLYPHS = "©@®*·•>◄ \t.-_"
WEEKDAY_RE = re.compile(r"^((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\w*)\s+(.+)$", re.I)
WEBSITE_BLOCKLIST = ("google.", "gstatic.", "goo.gl", "maps.", "schema.org", "ggpht.")
ADDRESS_TOKENS = re.compile(
    r"\b(St|Rd|Street|Road|Ave|Avenue|Floor|Fl|Shop|Building|Tower|Block|Al |Sheikh|Plaza|Mall)\b",
    re.I,
)


def _find_rating(lines: list[OcrLine]) -> tuple[ParsedField, int]:
    """Returns (rating, line_index). The hero image produces garbage lines at the top, so scan
    ALL lines (not just the first few). Prefer an inline "X.X (N)" (carries reviews too); else a
    standalone "X.X" line — that's how the Maps panel renders its rating. The index anchors the
    category + reviews parsers (both sit right by the rating)."""
    for i, line in enumerate(lines):
        m = RATING_RE.search(line.text)
        if m and REVIEWS_RE.search(line.text):
            val = float(m.group(1).replace(",", "."))
            if 1.0 <= val <= 5.0:
                return ParsedField(value=val, confidence=line.confidence, source_line=line.text), i
    for i, line in enumerate(lines):
        m = STANDALONE_RATING_RE.match(line.text)
        if m:
            val = float(m.group(1).replace(",", "."))
            if 1.0 <= val <= 5.0:
                return ParsedField(value=val, confidence=line.confidence, source_line=line.text), i
    return ParsedField(), -1


def _parse_reviews(lines: list[OcrLine], rating_idx: int) -> ParsedField:
    """Review count in "(N)" — it renders on/next to the rating line, so search a small window
    around it (and the first few lines as a fallback for the inline layout)."""
    window = (
        range(max(0, rating_idx - 1), min(len(lines), rating_idx + 2))
        if rating_idx >= 0
        else range(min(6, len(lines)))
    )
    for i in window:
        m = REVIEWS_RE.search(lines[i].text)
        if m:
            digits = re.sub(r"[^\d]", "", m.group(1))
            if digits:
                return ParsedField(
                    value=int(digits), confidence=lines[i].confidence, source_line=lines[i].text
                )
    return ParsedField()


def _parse_category(lines: list[OcrLine], rating_idx: int) -> ParsedField:
    """The category renders on the line directly below the rating (e.g. "Gym: &",
    "Fitness center: &"). Take that line, cut at the first ':' or '&' (icon), keep it if it's a
    short, mostly-letters phrase."""
    if rating_idx < 0:
        return ParsedField()
    for i in range(rating_idx + 1, min(len(lines), rating_idx + 3)):
        raw = lines[i].text
        t = raw.split(":")[0].split("&")[0].strip(LEADING_GLYPHS + " ")
        if 2 < len(t) <= 30 and re.fullmatch(r"[A-Za-z][A-Za-z /'-]*", t):
            return ParsedField(value=t, confidence=lines[i].confidence, source_line=raw)
    return ParsedField()


def _normalize_phone(raw: str) -> str:
    digits = re.sub(r"[^\d+]", "", raw)
    if digits.startswith("00971"):
        digits = "+971" + digits[5:]
    elif digits.startswith("0") and not digits.startswith("+"):
        digits = "+971" + digits[1:]
    return digits


def _parse_phone(lines: list[OcrLine]) -> ParsedField:
    for line in lines:
        m = PHONE_UAE_RE.search(line.text)
        if m:
            return ParsedField(
                value=_normalize_phone(m.group(0)),
                confidence=line.confidence,
                source_line=line.text,
            )
    for line in lines:
        m = PHONE_GENERIC_RE.search(line.text)
        if m:
            return ParsedField(
                value=re.sub(r"[\s-]", "", m.group(0)),
                confidence=line.confidence,
                source_line=line.text,
            )
    return ParsedField()


def _parse_website(lines: list[OcrLine]) -> ParsedField:
    for line in lines:
        for m in DOMAIN_RE.finditer(line.text):
            domain = m.group(0).lower()
            if any(b in domain for b in WEBSITE_BLOCKLIST):
                continue
            if "@" in line.text and domain in line.text.split("@")[-1]:
                continue  # part of an email, not a website
            return ParsedField(value=domain, confidence=line.confidence, source_line=line.text)
    return ParsedField()


def _parse_plus_code(lines: list[OcrLine]) -> ParsedField:
    for line in lines:
        m = PLUS_CODE_RE.search(line.text)
        if m:
            return ParsedField(value=m.group(0), confidence=line.confidence, source_line=line.text)
    return ParsedField()


def _parse_hours_summary(lines: list[OcrLine]) -> ParsedField:
    for line in lines:
        m = HOURS_SUMMARY_RE.search(line.text)
        if m:
            return ParsedField(
                value=m.group(0).strip(), confidence=line.confidence, source_line=line.text
            )
    return ParsedField()


def _parse_weekly_hours(lines: list[OcrLine]) -> dict[str, str]:
    weekly: dict[str, str] = {}
    for line in lines:
        m = WEEKDAY_RE.match(line.text)
        if m:
            weekly[m.group(1).title()] = m.group(2).strip()
    return weekly


def _parse_email(lines: list[OcrLine]) -> ParsedField:
    for line in lines:
        m = EMAIL_RE.search(line.text)
        if m:
            return ParsedField(
                value=m.group(0).lower(), confidence=line.confidence, source_line=line.text
            )
    return ParsedField()


def _parse_address(lines: list[OcrLine]) -> ParsedField:
    # Best-effort: the line(s) with street tokens, skipping the rating/hours lines. Strips the
    # leading map-pin glyph OCR emits (e.g. "© Al Shamsi Building ..." -> "Al Shamsi Building ...").
    for line in lines:
        if RATING_RE.search(line.text) or HOURS_SUMMARY_RE.search(line.text):
            continue
        if ADDRESS_TOKENS.search(line.text) and len(line.text) > 8:
            cleaned = line.text.strip(LEADING_GLYPHS + " ").strip()
            return ParsedField(value=cleaned, confidence=line.confidence, source_line=line.text)
    return ParsedField()


def parse_business(
    idx: int,
    name: str,
    maps_url: str | None,
    source_images: list[str],
    ocr: OcrResult,
    *,
    expand_hours: bool,
    dom: DomFields | None = None,
) -> ParsedBusiness:
    dom = dom or DomFields()
    lines = ocr.lines
    rating, rating_idx = _find_rating(lines)
    reviews = _parse_reviews(lines, rating_idx)
    phone = _parse_phone(lines)
    website = _parse_website(lines)
    plus_code = _parse_plus_code(lines)
    hours = _parse_hours_summary(lines)
    address = _parse_address(lines)
    category = _parse_category(lines, rating_idx)
    email = _parse_email(lines)
    weekly = _parse_weekly_hours(lines) if expand_hours else {}

    # DOM value wins over the OCR value for every field the DOM exposed — it's exact, OCR is
    # a guess. OCR is the fallback for whatever the DOM didn't carry (and the raw_text audit).
    # Phone especially: `_normalize_phone` turns the DOM's "+91 84455 88806" into "+918445588806".
    final_phone = _normalize_phone(dom.phone) if dom.phone else phone.value
    final_website = dom.website or website.value
    final_address = dom.address or address.value
    final_plus = dom.plus_code or plus_code.value
    final_rating = dom.rating if dom.rating is not None else rating.value
    final_reviews = dom.review_count if dom.review_count is not None else reviews.value
    final_category = dom.category or category.value
    final_image_url = dom.image_url

    # ocr_confidence = mean of the confidences of fields that actually matched (falls back to the
    # segment-level mean when nothing matched).
    contributing = [
        f.confidence
        for f in (rating, reviews, phone, website, plus_code, hours, address)
        if f.value is not None
    ]
    ocr_confidence = sum(contributing) / len(contributing) if contributing else ocr.mean_confidence

    # A field sourced from the DOM is exact, so it never triggers needs_review. Only flag when the
    # value came from OCR AND looks off (low confidence, or a phone/rating that fails validation).
    phone_ok = (
        dom.phone is not None
        or final_phone is None
        or 7 <= len(re.sub(r"[^\d]", "", str(final_phone))) <= 15
    )
    rating_ok = dom.rating is not None or final_rating is None or 1.0 <= float(final_rating) <= 5.0
    dom_covered_key_fields = dom.phone is not None or dom.website is not None
    needs_review = (
        (not dom_covered_key_fields and ocr_confidence < 70) or not phone_ok or not rating_ok
    )

    return ParsedBusiness(
        idx=idx,
        name=name,
        maps_url=maps_url,
        rating=final_rating,
        review_count=final_reviews,
        category=final_category,
        address=final_address,
        phone=final_phone,
        website=final_website,
        plus_code=final_plus,
        hours_summary=hours.value,
        hours_weekly=weekly or None,
        email=email.value,
        image_url=final_image_url,
        ocr_confidence=round(ocr_confidence, 1),
        needs_review=needs_review,
        raw_text=ocr.raw_text,
        source_images=source_images,
    )
