"""Authored by: Mohit Singh

Unit tests for the deterministic Stage-B core — field parsing and the segment overlap-merge.
No Tesseract, no browser: parse_fields runs over synthetic OcrLine lists (exactly what OCR would
hand it), and the merge test feeds pre-built line lists. These are the "near-exhaustively tested
deterministic core" the engineering standards call for.
"""

from __future__ import annotations

from business_scout_worker.ocr import parse_fields
from business_scout_worker.ocr.ocr_engine import OcrLine, OcrResult


def _lines(*texts: str, conf: float = 92.0) -> list[OcrLine]:
    return [OcrLine(text=t, confidence=conf) for t in texts]


def _result(*texts: str, conf: float = 92.0) -> OcrResult:
    ls = _lines(*texts, conf=conf)
    return OcrResult(lines=ls, raw_text="\n".join(texts), mean_confidence=conf)


def test_parses_a_full_gym_panel() -> None:
    ocr = _result(
        "XFit Gym Mamzar 2",
        "4.9 (140)",
        "Gym",
        "HC Floor, Onyx Tower - Al Mamzar - Dubai",
        "Open 24 hours",
        "xfitgym.ae",
        "+971 58 531 5770",
        "79M4+3F Dubai",
    )
    biz = parse_fields.parse_business(
        1, "XFit Gym Mamzar 2", "https://maps/x", ["raw/1_p1.png"], ocr, expand_hours=False
    )

    assert biz.rating == 4.9
    assert biz.review_count == 140
    assert biz.phone == "+971585315770"  # normalized to E.164
    assert biz.website == "xfitgym.ae"
    assert biz.plus_code == "79M4+3F"
    assert biz.hours_summary == "Open 24 hours"
    assert biz.address is not None and "Onyx Tower" in biz.address
    assert biz.needs_review is False
    assert biz.name == "XFit Gym Mamzar 2"  # from manifest, not OCR


def test_normalizes_comma_rating_and_local_phone() -> None:
    ocr = _result("Some Library", "4,7 (94)", "Library", "058 531 5770")
    biz = parse_fields.parse_business(2, "Some Library", None, [], ocr, expand_hours=False)
    assert biz.rating == 4.7  # comma normalized to dot
    assert biz.phone == "+971585315770"  # leading 0 -> +971


def test_website_blocklist_skips_google_domains() -> None:
    ocr = _result("Name", "4.5 (10)", "maps.google.com", "gstatic.com", "realgym.ae")
    biz = parse_fields.parse_business(3, "Name", None, [], ocr, expand_hours=False)
    assert biz.website == "realgym.ae"


def test_missing_fields_leave_nulls_and_flag_review_on_low_confidence() -> None:
    ocr = _result("Mystery Place", conf=40.0)
    biz = parse_fields.parse_business(4, "Mystery Place", None, [], ocr, expand_hours=False)
    assert biz.rating is None
    assert biz.phone is None
    assert biz.needs_review is True  # confidence 40 < 70


def test_weekly_hours_only_when_expand_hours() -> None:
    ocr = _result("Name", "4.8 (50)", "Monday 9 AM–9 PM", "Tuesday 9 AM–9 PM", "Sunday Closed")
    without = parse_fields.parse_business(5, "Name", None, [], ocr, expand_hours=False)
    assert without.hours_weekly is None

    with_hours = parse_fields.parse_business(6, "Name", None, [], ocr, expand_hours=True)
    assert with_hours.hours_weekly is not None
    assert with_hours.hours_weekly["Monday"].startswith("9 AM")
    assert with_hours.hours_weekly["Sunday"] == "Closed"


def test_parses_real_limited_view_panel_layout() -> None:
    # Exactly the shape of a real capture (see the live-run raw_text): hero-image garbage lines
    # at the top, then a standalone rating, then "Gym: &" category, "Open: Closes 12AM" hours,
    # and a "©"-prefixed address. This is the layout the initial parser missed.
    ocr = _result(
        "1 ' —__ >",
        "a rn a i]",
        "Stay Fit Fitness Club",
        "4.8",
        "Gym: &",
        "Overview About",
        "© Al Shamsi Building - 54 Amman St - Dubai",
        "Open: Closes 12AM",
        "stayfitgymdubai.com",
        "04 238 9957",
        "79R9+RC Dubai",
    )
    biz = parse_fields.parse_business(1, "Stay Fit Fitness Club", None, [], ocr, expand_hours=False)
    assert biz.rating == 4.8  # standalone rating below the garbage lines
    assert biz.category == "Gym"  # ":" and "&" stripped
    assert biz.hours_summary == "Open: Closes 12AM"
    assert biz.phone == "+97142389957"  # "04 238 9957" -> +971
    assert biz.website == "stayfitgymdubai.com"
    assert biz.plus_code == "79R9+RC"
    assert biz.address == "Al Shamsi Building - 54 Amman St - Dubai"  # leading "©" stripped


def test_dom_fields_override_ocr_and_never_flag_review() -> None:
    from business_scout_worker.ocr.models import DomFields

    # OCR misread the phone (the exact "R04..." style failure we saw live); the DOM has it exact.
    ocr = _result("BAJRANG FITNESS", "4.9", "Fitness center", "R91 8445S 8880G")
    dom = DomFields(
        phone="+91 84455 88806",
        website="https://bajrangfitness.com/",
        address="Pilikothi Rd, opp. Primary School, Haldwani",
        plus_code="6G64+J7 Haldwani",
        rating=4.9,
        review_count=47,
        category="Fitness center",
    )
    biz = parse_fields.parse_business(
        1, "BAJRANG FITNESS", None, [], ocr, expand_hours=False, dom=dom
    )
    assert biz.phone == "+918445588806"  # DOM value, normalized — NOT the OCR misread
    assert biz.website == "https://bajrangfitness.com/"
    assert biz.review_count == 47
    assert biz.rating == 4.9
    assert biz.plus_code == "6G64+J7 Haldwani"
    assert biz.needs_review is False  # DOM-sourced key fields => trusted, never flagged


def test_source_images_and_maps_url_pass_through() -> None:
    ocr = _result("A", "5.0 (3)")
    biz = parse_fields.parse_business(
        7, "A", "https://maps/a", ["raw/007_a_p1.png", "raw/007_a_p2.png"], ocr, expand_hours=False
    )
    assert biz.maps_url == "https://maps/a"
    assert biz.source_images == ["raw/007_a_p1.png", "raw/007_a_p2.png"]
