"""Authored by: Mohit Singh

Unit tests for ecom/parse_product.py's regex field-parsers and the parse_product() combiner.
Mirrors test_ocr_parse.py's style: synthetic OcrLine lists in, asserted fields out — no browser,
no Tesseract. Each field-level test only asserts behavior the real regex actually implements;
where a suggested input format isn't supported by the current regex (e.g. "1.7K" review-count
suffixes, "-13%" discount without "off", "1K+ bought"), that gap is called out in a comment next
to the test that documents the real (non-)behavior instead of forcing a false pass.
"""

from __future__ import annotations

from business_scout_worker.ecom import parse_product
from business_scout_worker.ecom.models import DomProductFields
from business_scout_worker.ocr.ocr_engine import OcrLine, OcrResult


def _lines(*texts: str, conf: float = 90.0) -> list[OcrLine]:
    return [OcrLine(text=t, confidence=conf) for t in texts]


def _result(*texts: str, conf: float = 90.0) -> OcrResult:
    ls = _lines(*texts, conf=conf)
    return OcrResult(lines=ls, raw_text="\n".join(texts), mean_confidence=conf)


# --- price ---------------------------------------------------------------------------------


def test_price_aed_simple() -> None:
    field = parse_product._parse_price(_lines("AED 129.00"))
    assert field.value == 129.0


def test_price_aed_thousands_separator() -> None:
    field = parse_product._parse_price(_lines("AED 5,899.00"))
    assert field.value == 5899.0


def test_price_arabic_currency_symbol() -> None:
    field = parse_product._parse_price(_lines("د.إ 1,299"))
    assert field.value == 1299.0


def test_price_dollar_sign() -> None:
    field = parse_product._parse_price(_lines("$45.99"))
    assert field.value == 45.99


def test_price_none_when_no_currency_marker() -> None:
    # PRICE_RE requires one of AED/SAR/USD/$/د.إ before the number — a bare number never matches.
    field = parse_product._parse_price(_lines("129.00"))
    assert field.value is None


def test_price_does_not_carry_currency() -> None:
    # NOTE: PRICE_RE and _parse_price only ever return the numeric amount — there is no currency
    # capture group anywhere in this function. `currency` on the final ParsedProduct always comes
    # from dom.currency or the adapter's default_currency, never parsed out of the OCR text itself.
    field = parse_product._parse_price(_lines("SAR 99.00"))
    assert field.value == 99.0
    assert not hasattr(field, "currency")


# --- rating ----------------------------------------------------------------------------------


def test_rating_out_of_5_phrase() -> None:
    field = parse_product._parse_rating(_lines("4.8 out of 5 stars"))
    assert field.value == 4.8


def test_rating_bare_decimal() -> None:
    field = parse_product._parse_rating(_lines("4.5"))
    assert field.value == 4.5


def test_rating_rejects_out_of_range() -> None:
    # RATING_RE's capture group is anchored to [0-5] as the leading digit, so "9.9" never matches
    # at all (not even partially) — this is how out-of-range values are rejected.
    field = parse_product._parse_rating(_lines("9.9"))
    assert field.value is None


# --- reviews -----------------------------------------------------------------------------------


def test_reviews_parenthesized_count_with_word() -> None:
    field = parse_product._parse_reviews(_lines("(1,732) ratings"))
    assert field.value == 1732


def test_reviews_bare_count_with_word() -> None:
    field = parse_product._parse_reviews(_lines("94 reviews"))
    assert field.value == 94


def test_reviews_k_suffix_not_supported() -> None:
    # REVIEWS_RE requires literal "rating(s)"/"review(s)" text right after the digit run, and its
    # digit class is [\d,]+ (no "K"/"k" suffix handling). "(1.7K)" has neither a trailing
    # ratings/reviews word nor a plain digit run immediately before one, so it does not match —
    # documented gap, not a bug: real noon "(1.7K)"-only badges are simply not parsed by this
    # field today.
    field = parse_product._parse_reviews(_lines("(1.7K)"))
    assert field.value is None


# --- bought past month -------------------------------------------------------------------------


def test_bought_past_month_plain() -> None:
    field = parse_product._parse_bought(_lines("400+ bought in past month"))
    assert field.value == 400


def test_bought_past_month_with_the() -> None:
    field = parse_product._parse_bought(_lines("50 bought in the past month"))
    assert field.value == 50


def test_bought_past_month_k_suffix_not_supported() -> None:
    # Same root cause as the reviews K-suffix gap: BOUGHT_RE's digit group is [\d,]+, so "1K+"
    # breaks the match (the "K" isn't a digit/comma and isn't consumed before "bought"). Documented
    # gap: real "1K+ bought in past month" badges are not parsed today.
    field = parse_product._parse_bought(_lines("1K+ bought in past month"))
    assert field.value is None


# --- free delivery -----------------------------------------------------------------------------


def test_free_delivery_true() -> None:
    field = parse_product._parse_free_delivery(_lines("FREE delivery Tomorrow, 8 Aug"))
    assert field.value is True


def test_free_delivery_false_when_charges_apply() -> None:
    field = parse_product._parse_free_delivery(_lines("Delivery charges apply"))
    assert field.value is False


# --- delivery date -----------------------------------------------------------------------------


def test_delivery_date_extracts_tomorrow() -> None:
    field = parse_product._parse_delivery_date(_lines("FREE delivery Tomorrow, 8 Aug"))
    # The captured value is the WHOLE regex match (m.group(0)), i.e. from the "Delivery"/"Get
    # it"/"Arrives" keyword through the date token — not just the trailing date substring.
    assert field.value is not None
    assert "Tomorrow" in field.value
    assert field.value.lower().startswith("delivery")


def test_delivery_date_extracts_weekday_form() -> None:
    field = parse_product._parse_delivery_date(_lines("Get it by Wednesday, 13 Aug"))
    assert field.value is not None
    assert "Wednesday, 13 Aug" in field.value


def test_delivery_date_none_when_absent() -> None:
    field = parse_product._parse_delivery_date(_lines("Ships from and sold by Amazon.ae"))
    assert field.value is None


# --- discount --------------------------------------------------------------------------------


def test_discount_percent_off() -> None:
    field = parse_product._parse_discount(_lines("17% off"))
    assert field.value == 17.0


def test_discount_dash_form_not_supported() -> None:
    # DISCOUNT_RE is `(\d{1,3})\s*%\s*off` — it requires the literal trailing "off". A dash-style
    # badge like "-13%" has no "off" text at all, so it never matches. Documented gap, not a bug.
    field = parse_product._parse_discount(_lines("-13%"))
    assert field.value is None


# --- badge / rank ------------------------------------------------------------------------------


def test_badge_rank_and_category() -> None:
    rank, category = parse_product._parse_badge_rank(_lines("#3 in Dumbbells"))
    assert rank.value == 3
    assert category.value == "Dumbbells"


def test_badge_rank_absent() -> None:
    rank, category = parse_product._parse_badge_rank(_lines("Best Seller"))
    assert rank.value is None
    assert category.value is None


# --- parse_product() combiner ------------------------------------------------------------------


def test_combiner_dom_fields_win_and_never_flag_review() -> None:
    dom = DomProductFields(price=99.0, rating=4.6, review_count=200)
    ocr = _result("AED 149.00", "3.2", conf=20.0)  # deliberately conflicting, low-confidence OCR
    parsed = parse_product.parse_product(ocr.lines, idx=1, title="Yoga Mat", ocr=ocr, dom=dom)
    assert parsed.price == 99.0  # DOM wins over OCR's 149.00
    assert parsed.rating == 4.6  # DOM wins over OCR's 3.2
    assert parsed.review_count == 200
    assert parsed.needs_review is False  # dom covers price+rating => never flagged
    assert parsed.extraction_source == "dom+ocr"  # dom present AND ocr lines contributed


def test_combiner_ocr_only_high_confidence_no_review_flag() -> None:
    ocr = _result("AED 79.00", "4.7 out of 5 stars", "120 reviews", conf=88.0)
    parsed = parse_product.parse_product(ocr.lines, idx=2, title="Resistance Bands", ocr=ocr)
    assert parsed.price == 79.0
    assert parsed.rating == 4.7
    assert parsed.review_count == 120
    assert parsed.needs_review is False  # ocr_confidence 88 >= 70
    assert parsed.extraction_source == "ocr"


def test_combiner_ocr_only_low_confidence_flags_review() -> None:
    ocr = _result("AED 79.00", conf=40.0)
    parsed = parse_product.parse_product(ocr.lines, idx=3, title="Foam Roller", ocr=ocr)
    assert parsed.needs_review is True  # ocr_confidence 40 < 70, no dom key-field coverage


def test_combiner_missing_everything_defaults_and_flags_review() -> None:
    # No dom, no ocr object at all, empty line list: ocr_confidence falls back to 0.0, and with no
    # dom coverage of price/rating that's enough on its own to flag needs_review.
    parsed = parse_product.parse_product([], idx=4, title="Mystery Product")
    assert parsed.price is None
    assert parsed.rating is None
    assert parsed.needs_review is True
    assert parsed.ocr_confidence == 0.0
    assert parsed.extraction_source == "ocr"  # dom_has_any is False, contributing is empty


def test_combiner_zero_price_flags_review_even_with_ok_confidence() -> None:
    # price_ok is False when dom.price is None and the OCR-derived price is not > 0 (here exactly
    # 0.0) — needs_review must be True regardless of OCR confidence being high.
    ocr = _result("AED 0.00", conf=95.0)
    parsed = parse_product.parse_product(ocr.lines, idx=5, title="Free Sample", ocr=ocr)
    assert parsed.price == 0.0
    assert parsed.needs_review is True


def test_combiner_source_images_and_identity_fields_pass_through() -> None:
    parsed = parse_product.parse_product(
        [],
        idx=6,
        title="Kettlebell 10kg",
        product_url="https://www.noon.com/uae-en/p/N123",
        image_url="https://images.noon.com/kb.jpg",
        page_num=2,
        default_currency="SAR",
    )
    assert parsed.idx == 6
    assert parsed.page_num == 2
    assert parsed.title == "Kettlebell 10kg"
    assert parsed.product_url == "https://www.noon.com/uae-en/p/N123"
    assert parsed.image_url == "https://images.noon.com/kb.jpg"
    assert parsed.currency == "SAR"  # falls back to default_currency when dom has none
