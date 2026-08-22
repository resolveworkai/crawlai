"""Authored by: Mohit Singh

Unit tests for property/parse_property.py — the pure regex field parsers shared by both adapters'
extract_card, plus the Stage B/C parse_listing() combiner. No Playwright/browser involved.
"""

from __future__ import annotations

from business_scout_worker.property.models import DomListingFields
from business_scout_worker.property.parse_property import (
    find_distress_keywords,
    guess_title_and_location,
    parse_area_sqft,
    parse_bathrooms,
    parse_bedrooms,
    parse_listed_days_ago,
    parse_listing,
    parse_price,
    parse_verified,
)

# --- parse_price ---------------------------------------------------------------------------------


def test_parse_price_aed_comma_grouped() -> None:
    assert parse_price("AED 1,250,000").value == 1_250_000.0


def test_parse_price_with_nbsp() -> None:
    assert parse_price("AED\xa0850,000").value == 850_000.0


def test_parse_price_no_match_returns_none_value() -> None:
    assert parse_price("Price on request").value is None


def test_parse_price_requires_at_least_4_digits() -> None:
    # A bare "AED 50" (e.g. a service fee mentioned elsewhere on the card) must not be mistaken
    # for a property price.
    assert parse_price("AED 50").value is None


def test_parse_price_case_insensitive() -> None:
    assert parse_price("aed 700,000").value == 700_000.0


# --- parse_bedrooms ------------------------------------------------------------------------------


def test_parse_bedrooms_studio_maps_to_zero() -> None:
    field = parse_bedrooms("Studio apartment for sale")
    assert field.value == 0


def test_parse_bedrooms_extracts_count() -> None:
    assert parse_bedrooms("2 Bed | 3 Baths | 1,200 sqft").value == 2


def test_parse_bedrooms_br_abbreviation() -> None:
    assert parse_bedrooms("3BR Villa in Arabian Ranches").value == 3


def test_parse_bedrooms_no_match_returns_none() -> None:
    assert parse_bedrooms("Luxury villa with pool").value is None


def test_parse_bedrooms_studio_takes_priority_over_absent_number() -> None:
    field = parse_bedrooms("Studio | 1 Bath | 450 sqft")
    assert field.value == 0


# --- parse_bathrooms -----------------------------------------------------------------------------


def test_parse_bathrooms_extracts_count() -> None:
    assert parse_bathrooms("2 Bed | 3 Baths | 1,200 sqft").value == 3


def test_parse_bathrooms_singular_bath() -> None:
    assert parse_bathrooms("Studio | 1 Bath | 450 sqft").value == 1


def test_parse_bathrooms_no_match_returns_none() -> None:
    assert parse_bathrooms("Luxury villa with pool").value is None


# --- parse_area_sqft -----------------------------------------------------------------------------


def test_parse_area_sqft_comma_grouped() -> None:
    assert parse_area_sqft("1,200 sqft").value == 1200.0


def test_parse_area_sqft_sq_ft_variant() -> None:
    assert parse_area_sqft("850 sq ft").value == 850.0


def test_parse_area_sqft_no_match_returns_none() -> None:
    assert parse_area_sqft("Price on request").value is None


# --- parse_listed_days_ago -----------------------------------------------------------------------


def test_parse_listed_days_ago_extracts_number() -> None:
    assert parse_listed_days_ago("Listed 14 days ago").value == 14


def test_parse_listed_days_ago_today_maps_to_zero() -> None:
    assert parse_listed_days_ago("Listed today").value == 0


def test_parse_listed_days_ago_yesterday_maps_to_zero() -> None:
    assert parse_listed_days_ago("Listed yesterday").value == 0


def test_parse_listed_days_ago_no_match_returns_none() -> None:
    assert parse_listed_days_ago("2 Bed | 3 Baths").value is None


# --- parse_verified ----------------------------------------------------------------------------


def test_parse_verified_true_when_present() -> None:
    assert parse_verified("Verified listing") is True


def test_parse_verified_false_when_absent() -> None:
    assert parse_verified("2 Bed | 3 Baths") is False


# --- find_distress_keywords -----------------------------------------------------------------------


def test_find_distress_keywords_matches_multiple_phrases() -> None:
    found = find_distress_keywords("Motivated seller, urgent sale, price reduced!")
    assert "motivated seller" in found
    assert "urgent sale" in found
    assert "price reduced" in found


def test_find_distress_keywords_case_insensitive() -> None:
    assert "urgent" in find_distress_keywords("URGENT SALE TODAY")


def test_find_distress_keywords_none_found_returns_empty_list() -> None:
    assert find_distress_keywords("Spacious apartment with a view") == []


# --- guess_title_and_location ------------------------------------------------------------------


def test_guess_title_and_location_picks_longest_and_last_candidate() -> None:
    lines = [
        "AED 850,000",
        "2 Bed | 3 Baths | 1,200 sqft",
        # Deliberately avoids a "<digit> Bed/Bedroom" phrase here — that would match BEDROOMS_RE
        # and get filtered out as noise, same as the price/beds/baths line above.
        "Spacious Furnished Apartment with Marina View",
        "Jumeirah Village Circle, Dubai",
    ]
    title, location = guess_title_and_location(lines)
    assert title == "Spacious Furnished Apartment with Marina View"
    assert location == "Jumeirah Village Circle, Dubai"


def test_guess_title_and_location_empty_when_nothing_plausible() -> None:
    lines = ["AED 850,000", "2 Bed | 3 Baths", "Verified"]
    title, location = guess_title_and_location(lines)
    assert title is None
    assert location is None


def test_guess_title_and_location_single_candidate_used_as_both() -> None:
    lines = ["AED 850,000", "Beautiful family home in JVC"]
    title, location = guess_title_and_location(lines)
    assert title == "Beautiful family home in JVC"
    assert location == "Beautiful family home in JVC"


# --- parse_listing (Stage B/C combiner) ----------------------------------------------------------


def test_parse_listing_dom_wins_over_ocr() -> None:
    dom = DomListingFields(price=900_000, area_sqft=1100, title="DOM Title")
    result = parse_listing(
        "AED 500,000 | 800 sqft | OCR Title",
        idx=1,
        title="fallback title",
        listing_url="https://example.com/1",
        image_url="https://example.com/1.jpg",
        page_num=1,
        dom=dom,
    )
    assert result.price == 900_000
    assert result.area_sqft == 1100
    assert result.title == "DOM Title"
    assert result.extraction_source == "dom+ocr"


def test_parse_listing_falls_back_to_ocr_when_dom_field_missing() -> None:
    dom = DomListingFields(title="Has a title")  # no price/area from DOM
    result = parse_listing(
        "AED 700,000 | 950 sqft",
        idx=2,
        title="fallback title",
        listing_url=None,
        image_url=None,
        page_num=1,
        dom=dom,
    )
    assert result.price == 700_000
    assert result.area_sqft == 950


def test_parse_listing_pure_ocr_source_when_no_dom_core_fields() -> None:
    result = parse_listing(
        "AED 700,000 | 950 sqft",
        idx=3,
        title="fallback title",
        listing_url=None,
        image_url=None,
        page_num=1,
        dom=None,
    )
    assert result.extraction_source == "ocr"


def test_parse_listing_dom_only_source_when_no_ocr_text() -> None:
    dom = DomListingFields(price=900_000, area_sqft=1100, title="DOM Title")
    result = parse_listing(
        "",
        idx=4,
        title="fallback title",
        listing_url=None,
        image_url=None,
        page_num=1,
        dom=dom,
    )
    assert result.extraction_source == "dom"


def test_parse_listing_needs_review_when_no_core_dom_fields_and_pure_ocr_empty() -> None:
    result = parse_listing(
        "",
        idx=5,
        title="fallback title",
        listing_url=None,
        image_url=None,
        page_num=1,
        dom=None,
    )
    assert result.needs_review is True


def test_parse_listing_needs_review_false_when_dom_has_core_fields_and_positive_price() -> None:
    dom = DomListingFields(price=500_000, area_sqft=1000, title="Good listing")
    result = parse_listing(
        "",
        idx=6,
        title="fallback",
        listing_url=None,
        image_url=None,
        page_num=1,
        dom=dom,
    )
    assert result.needs_review is False


def test_parse_listing_negative_or_zero_price_flags_needs_review() -> None:
    dom = DomListingFields(price=0, area_sqft=1000, title="Weird zero-price listing")
    result = parse_listing(
        "",
        idx=7,
        title="fallback",
        listing_url=None,
        image_url=None,
        page_num=1,
        dom=dom,
    )
    assert result.needs_review is True


def test_parse_listing_distress_keywords_scanned_from_title() -> None:
    dom = DomListingFields(price=500_000, area_sqft=1000, title="Urgent sale, motivated seller")
    result = parse_listing(
        "",
        idx=8,
        title="fallback",
        listing_url=None,
        image_url=None,
        page_num=1,
        dom=dom,
    )
    assert "urgent" in result.distress_keywords
    assert "motivated seller" in result.distress_keywords


def test_parse_listing_image_urls_prefers_dom_image_over_capture_image() -> None:
    dom = DomListingFields(image_url="https://example.com/dom.jpg", title="X", price=1, area_sqft=1)
    result = parse_listing(
        "",
        idx=9,
        title="fallback",
        listing_url=None,
        image_url="https://example.com/capture.jpg",
        page_num=1,
        dom=dom,
    )
    assert result.image_urls == ["https://example.com/dom.jpg"]


def test_parse_listing_image_urls_empty_when_neither_source_has_one() -> None:
    result = parse_listing(
        "",
        idx=10,
        title="fallback",
        listing_url=None,
        image_url=None,
        page_num=1,
        dom=None,
    )
    assert result.image_urls == []
