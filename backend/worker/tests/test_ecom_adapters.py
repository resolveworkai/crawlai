"""Authored by: Mohit Singh

Unit tests for the e-commerce platform adapters (search_url/product_key/normalize_product_url)
and the get_adapter registry. No Playwright/browser involved — these are the pure, synchronous
helper methods each adapter exposes; DOM-scraping methods (extract_card/is_blocked/prepare_page)
are async and Playwright-driven, out of scope for a unit test without a real/mocked Page.
"""

from __future__ import annotations

import pytest

from business_scout_worker.ecom.adapters import get_adapter
from business_scout_worker.ecom.adapters.amazon import AmazonAdapter
from business_scout_worker.ecom.adapters.base import extract_asin
from business_scout_worker.ecom.adapters.noon import (
    NoonAdapter,
    _parse_amount,
    _parse_rating,
    _parse_review_count,
)

# --- noon.search_url ---------------------------------------------------------------------------


def test_noon_search_url_relevance_no_sort_params() -> None:
    url = NoonAdapter().search_url("yoga mat", "relevance", 1)
    assert url == "https://www.noon.com/uae-en/search/?q=yoga%20mat&page=1"


def test_noon_search_url_rating_desc() -> None:
    url = NoonAdapter().search_url("yoga mat", "rating_desc", 1)
    assert url == (
        "https://www.noon.com/uae-en/search/?q=yoga%20mat&page=1"
        "&sort[by]=best_rating&sort[dir]=desc"
    )


def test_noon_search_url_price_asc_page_2() -> None:
    url = NoonAdapter().search_url("dumbbells", "price_asc", 2)
    assert url == (
        "https://www.noon.com/uae-en/search/?q=dumbbells&page=2&sort[by]=price&sort[dir]=asc"
    )


def test_noon_search_url_price_desc() -> None:
    url = NoonAdapter().search_url("dumbbells", "price_desc", 3)
    assert url == (
        "https://www.noon.com/uae-en/search/?q=dumbbells&page=3&sort[by]=price&sort[dir]=desc"
    )


# --- amazon.search_url --------------------------------------------------------------------------


def test_amazon_search_url_relevance_no_sort_param() -> None:
    url = AmazonAdapter().search_url("yoga mat", "relevance", 1)
    assert url == "https://www.amazon.ae/s?k=yoga%20mat&page=1&language=en_AE"


def test_amazon_search_url_rating_desc() -> None:
    url = AmazonAdapter().search_url("yoga mat", "rating_desc", 1)
    assert url == "https://www.amazon.ae/s?k=yoga%20mat&page=1&language=en_AE&s=review-rank"


def test_amazon_search_url_price_asc_page_2() -> None:
    url = AmazonAdapter().search_url("dumbbells", "price_asc", 2)
    assert url == "https://www.amazon.ae/s?k=dumbbells&page=2&language=en_AE&s=price-asc-rank"


def test_amazon_search_url_price_desc() -> None:
    url = AmazonAdapter().search_url("dumbbells", "price_desc", 5)
    assert url == "https://www.amazon.ae/s?k=dumbbells&page=5&language=en_AE&s=price-desc-rank"


# --- product_key ---------------------------------------------------------------------------------


def test_noon_product_key_extracts_sku_after_p_segment() -> None:
    href = "https://www.noon.com/uae-en/some-product-title/p/N70062533V/"
    assert NoonAdapter().product_key(href) == "N70062533V"


def test_noon_product_key_none_for_malformed_href() -> None:
    assert NoonAdapter().product_key("https://www.noon.com/uae-en/some-product-title") is None


def test_noon_product_key_none_for_missing_href() -> None:
    assert NoonAdapter().product_key(None) is None


def test_amazon_product_key_extracts_asin() -> None:
    href = "https://www.amazon.ae/Some-Product-Name/dp/B0BSHF7WHW/ref=sr_1_1?keywords=x"
    assert AmazonAdapter().product_key(href) == "B0BSHF7WHW"


def test_amazon_product_key_none_for_malformed_href() -> None:
    # ASIN must be exactly 10 upper-case alphanumeric chars — a short id doesn't match.
    assert AmazonAdapter().product_key("https://www.amazon.ae/dp/short") is None


def test_amazon_product_key_none_for_missing_href() -> None:
    assert AmazonAdapter().product_key(None) is None


def test_extract_asin_helper_directly() -> None:
    assert extract_asin("https://www.amazon.ae/gp/product/B08N5WRWNW") is None  # not /dp/ shape
    assert extract_asin("https://www.amazon.ae/dp/B08N5WRWNW") == "B08N5WRWNW"
    assert extract_asin(None) is None


# --- normalize_product_url ------------------------------------------------------------------------


def test_normalize_product_url_resolves_relative_to_absolute() -> None:
    url = NoonAdapter().normalize_product_url("/uae-en/p/N123/", "https://www.noon.com")
    assert url == "https://www.noon.com/uae-en/p/N123/"


def test_normalize_product_url_strips_tracking_params() -> None:
    href = "/Product-Name/dp/B0BSHF7WHW/ref=sr_1_1?ref=sxin&psc=1&qid=169&keep=me"
    url = AmazonAdapter().normalize_product_url(href, "https://www.amazon.ae")
    assert url.startswith("https://www.amazon.ae/Product-Name/dp/B0BSHF7WHW/ref=sr_1_1?")
    assert "ref=sxin" not in url
    assert "psc=1" not in url
    assert "qid=169" not in url
    assert "keep=me" in url


def test_normalize_product_url_no_query_string_passthrough() -> None:
    url = NoonAdapter().normalize_product_url("/uae-en/p/N123", "https://www.noon.com")
    assert url == "https://www.noon.com/uae-en/p/N123"


# --- get_adapter registry -------------------------------------------------------------------------


def test_get_adapter_noon_and_amazon_return_correct_types() -> None:
    assert isinstance(get_adapter("noon"), NoonAdapter)
    assert isinstance(get_adapter("amazon"), AmazonAdapter)


def test_get_adapter_aliexpress_constructs_but_methods_raise() -> None:
    # Registered (so the DB CHECK/typed Platform literal both already accept it) but not
    # implemented — the adapter object itself constructs fine, only calling its methods fails.
    adapter = get_adapter("aliexpress")
    assert adapter.platform == "aliexpress"
    with pytest.raises(NotImplementedError):
        adapter.search_url("yoga mat", "relevance", 1)


def test_get_adapter_unknown_platform_raises_value_error() -> None:
    with pytest.raises(ValueError):
        get_adapter("bogus")


# --- noon._parse_review_count / _parse_rating / _parse_amount -----------------------------------
# Regression coverage for the 2026-08-07 fix: a real captured noon.com card DOM (user-provided
# live inspect-element dump) showed the review-count element renders as a bare "23.7K" — no
# parens, K/M suffix — which the original parenthesized-digits-only regex silently returned None
# for. See noon.py's module comments for the full before/after context.


def test_noon_parse_review_count_k_suffix() -> None:
    assert _parse_review_count("23.7K") == 23700


def test_noon_parse_review_count_m_suffix() -> None:
    assert _parse_review_count("1.2M") == 1_200_000


def test_noon_parse_review_count_parenthesized_still_works() -> None:
    assert _parse_review_count("(1,234)") == 1234


def test_noon_parse_review_count_none_for_empty() -> None:
    assert _parse_review_count(None) is None
    assert _parse_review_count("") is None


def test_noon_parse_rating_real_sample() -> None:
    assert _parse_rating("4.6") == 4.6


def test_noon_parse_amount_real_sample() -> None:
    assert _parse_amount("199") == 199.0
