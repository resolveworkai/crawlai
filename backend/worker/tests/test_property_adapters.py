"""Authored by: Mohit Singh

Unit tests for the Property Research platform adapters (search_url/listing_key/
normalize_listing_url) and the get_adapter registry. No Playwright/browser involved — these are
the pure, synchronous helper methods each adapter exposes; DOM-scraping methods (extract_card/
extract_detail/is_blocked/prepare_page) are async and Playwright-driven, out of scope for a unit
test without a real/mocked Page.
"""

from __future__ import annotations

import pytest

from business_scout_worker.property.adapters import cdp_required_platforms, get_adapter
from business_scout_worker.property.adapters.base import SearchFilters
from business_scout_worker.property.adapters.dubizzle import DubizzleAdapter
from business_scout_worker.property.adapters.propertyfinder import PropertyFinderAdapter


def _filters(**kwargs: object) -> SearchFilters:
    base: dict[str, object] = {
        "location": "jvc",
        "bedrooms": 1,
        "bathrooms": None,
        "property_type": "apartment",
        "purpose": "buy",
    }
    base.update(kwargs)
    return SearchFilters(**base)  # type: ignore[arg-type]


# --- dubizzle.search_url -------------------------------------------------------------------------


def test_dubizzle_search_url_basic_apartment_buy() -> None:
    url = DubizzleAdapter().search_url(_filters(), 1)
    assert url.startswith("https://dubai.dubizzle.com/en/property-for-sale/residential/apartment/?")
    assert "keywords=jvc" in url
    assert "bedrooms=1" in url
    assert "page=" not in url  # page 1 omits the param


def test_dubizzle_search_url_page_2_appends_page_param() -> None:
    url = DubizzleAdapter().search_url(_filters(), 2)
    assert "page=2" in url


def test_dubizzle_search_url_villa_maps_to_villahouse_segment() -> None:
    url = DubizzleAdapter().search_url(_filters(property_type="villa"), 1)
    assert "/residential/villahouse/" in url


def test_dubizzle_search_url_studio_forces_bedrooms_zero() -> None:
    url = DubizzleAdapter().search_url(_filters(property_type="studio", bedrooms=3), 1)
    # A studio has no bedrooms in the conventional sense — bedrooms is forced to 0 regardless of
    # whatever value the caller passed.
    assert "bedrooms=0" in url
    assert "/residential/apartment/" in url  # dubizzle has no separate studio segment


def test_dubizzle_search_url_rent_purpose() -> None:
    url = DubizzleAdapter().search_url(_filters(purpose="rent"), 1)
    assert url.startswith("https://dubai.dubizzle.com/en/property-for-rent/")


def test_dubizzle_search_url_includes_bathrooms_when_given() -> None:
    url = DubizzleAdapter().search_url(_filters(bathrooms=2), 1)
    assert "bathrooms=2" in url


def test_dubizzle_search_url_omits_bathrooms_when_none() -> None:
    url = DubizzleAdapter().search_url(_filters(bathrooms=None), 1)
    assert "bathrooms=" not in url


def test_dubizzle_search_url_location_is_url_encoded() -> None:
    url = DubizzleAdapter().search_url(_filters(location="al barsha south"), 1)
    assert "keywords=al%20barsha%20south" in url


# --- dubizzle.listing_key ---------------------------------------------------------------------


def test_dubizzle_listing_key_extracts_trailing_numeric_id() -> None:
    href = (
        "/property-for-sale/residential/apartment/2026/8/1/"
        "fully-furnished-vacant-on-transfer-547320/"
    )
    assert DubizzleAdapter().listing_key(href) == "547320"


def test_dubizzle_listing_key_requires_at_least_6_digits() -> None:
    # A short numeric suffix (e.g. a page-fragment id) must not be mistaken for a real ad ID.
    assert DubizzleAdapter().listing_key("/property-for-sale/residential/apartment/x-123/") is None


def test_dubizzle_listing_key_none_for_missing_href() -> None:
    assert DubizzleAdapter().listing_key(None) is None


def test_dubizzle_listing_key_none_for_malformed_href() -> None:
    assert (
        DubizzleAdapter().listing_key("/property-for-sale/residential/apartment/no-id-here/")
        is None
    )


def test_dubizzle_listing_key_stable_across_query_string() -> None:
    a = "/property-for-sale/residential/apartment/2026/8/1/some-slug-547320/?ref=aaa"
    b = "/property-for-sale/residential/apartment/2026/8/1/some-slug-547320/?ref=bbb"
    adapter = DubizzleAdapter()
    assert adapter.listing_key(a) == adapter.listing_key(b) == "547320"


# --- propertyfinder.search_url -------------------------------------------------------------------


def test_propertyfinder_search_url_basic_apartment_buy() -> None:
    url = PropertyFinderAdapter().search_url(_filters(), 1)
    assert url.startswith("https://www.propertyfinder.ae/en/search/buy?")
    assert "c=1" in url  # apartment category code
    assert "bf=1" in url
    assert "bt=1" in url
    assert "q=jvc" in url


def test_propertyfinder_search_url_page_2_appends_page_param() -> None:
    url = PropertyFinderAdapter().search_url(_filters(), 2)
    assert "page=2" in url


def test_propertyfinder_search_url_rent_purpose() -> None:
    url = PropertyFinderAdapter().search_url(_filters(purpose="rent"), 1)
    assert url.startswith("https://www.propertyfinder.ae/en/search/rent?")


def test_propertyfinder_search_url_studio_forces_bedrooms_zero() -> None:
    url = PropertyFinderAdapter().search_url(_filters(property_type="studio", bedrooms=2), 1)
    assert "bf=0" in url
    assert "bt=0" in url


def test_propertyfinder_search_url_no_bedrooms_filter_when_none() -> None:
    url = PropertyFinderAdapter().search_url(_filters(bedrooms=None), 1)
    assert "bf=" not in url
    assert "bt=" not in url


def test_propertyfinder_search_url_includes_bathrooms_when_given() -> None:
    url = PropertyFinderAdapter().search_url(_filters(bathrooms=2), 1)
    assert "bathf=2" in url


# --- propertyfinder.listing_key -----------------------------------------------------------------


def test_propertyfinder_listing_key_extracts_id_before_html() -> None:
    href = "https://www.propertyfinder.ae/en/plp/buy/1-bedroom-apartment-in-jvc-12345.html"
    assert PropertyFinderAdapter().listing_key(href) == "12345"


def test_propertyfinder_listing_key_requires_at_least_5_digits() -> None:
    assert (
        PropertyFinderAdapter().listing_key("https://www.propertyfinder.ae/en/plp/buy/x-123.html")
        is None
    )


def test_propertyfinder_listing_key_none_for_missing_href() -> None:
    assert PropertyFinderAdapter().listing_key(None) is None


def test_propertyfinder_listing_key_none_for_non_html_href() -> None:
    assert (
        PropertyFinderAdapter().listing_key("https://www.propertyfinder.ae/en/search/buy") is None
    )


# --- normalize_listing_url (shared base.py helper) ------------------------------------------------


def test_normalize_listing_url_resolves_relative_to_absolute() -> None:
    url = DubizzleAdapter().normalize_listing_url(
        "/property-for-sale/residential/apartment/x-547320/", "https://dubai.dubizzle.com"
    )
    assert url == "https://dubai.dubizzle.com/property-for-sale/residential/apartment/x-547320/"


def test_normalize_listing_url_strips_tracking_params() -> None:
    href = "https://www.propertyfinder.ae/en/plp/buy/x-12345.html?utm_source=x&keep=me"
    url = PropertyFinderAdapter().normalize_listing_url(href)
    assert "utm_source=x" not in url
    assert "keep=me" in url


def test_normalize_listing_url_no_query_string_passthrough() -> None:
    url = DubizzleAdapter().normalize_listing_url(
        "/property-for-sale/x-1/", "https://dubai.dubizzle.com"
    )
    assert url == "https://dubai.dubizzle.com/property-for-sale/x-1/"


# --- get_adapter / cdp_required_platforms registry -----------------------------------------------


def test_get_adapter_dubizzle_and_propertyfinder_return_correct_types() -> None:
    assert isinstance(get_adapter("dubizzle"), DubizzleAdapter)
    assert isinstance(get_adapter("propertyfinder"), PropertyFinderAdapter)


def test_get_adapter_unknown_platform_raises_value_error() -> None:
    with pytest.raises(ValueError):
        get_adapter("bogus")


def test_both_platforms_require_cdp() -> None:
    # The whole point of this module's architecture (no container-daemon claim branch) — both
    # confirmed 2026-08-22 to block plain headless Chromium.
    assert cdp_required_platforms() == frozenset({"dubizzle", "propertyfinder"})


def test_adapter_default_currency_is_aed() -> None:
    assert DubizzleAdapter().default_currency == "AED"
    assert PropertyFinderAdapter().default_currency == "AED"
