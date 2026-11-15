"""Authored by: Mohit Singh

Unit tests for the e-commerce platform adapters (search_url/product_key/normalize_product_url)
and the get_adapter registry. No Playwright/browser involved — these are the pure, synchronous
helper methods each adapter exposes; DOM-scraping methods (extract_card/is_blocked/prepare_page)
are async and Playwright-driven, out of scope for a unit test without a real/mocked Page.
"""

from __future__ import annotations

import pytest

from business_scout_worker.ecom.adapters import cdp_required_platforms, get_adapter
from business_scout_worker.ecom.adapters.aliexpress import AliExpressAdapter
from business_scout_worker.ecom.adapters.amazon import AmazonAdapter
from business_scout_worker.ecom.adapters.amazon_in import AmazonInAdapter
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


def test_noon_product_key_extracts_sku_before_p_segment() -> None:
    # Real noon URL shape (verified 2026-08-07 against live hrefs): the SKU is the segment
    # immediately BEFORE `/p/`, followed by a `?o=` tracking param.
    href = "https://www.noon.com/uae-en/some-product-title/N70062533V/p/?o=fec286202e0d640a"
    assert NoonAdapter().product_key(href) == "N70062533V"


def test_noon_product_key_extracts_alphanumeric_sku() -> None:
    href = "https://www.noon.com/uae-en/cuckoo-rice-cooker/ZC7E09604077A091EA1B4Z/p/?o=zc7e-1"
    assert NoonAdapter().product_key(href) == "ZC7E09604077A091EA1B4Z"


def test_noon_product_key_same_across_tracking_params() -> None:
    # The whole point of the key: the same product linked from two pages (different `?o=`)
    # dedups to one SKU.
    a = "https://www.noon.com/uae-en/x/N11043863A/p/?o=aaaa"
    b = "https://www.noon.com/uae-en/x/N11043863A/p/?o=bbbb"
    adapter = NoonAdapter()
    assert adapter.product_key(a) == adapter.product_key(b) == "N11043863A"


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


def test_get_adapter_aliexpress_returns_correct_type() -> None:
    adapter = get_adapter("aliexpress")
    assert isinstance(adapter, AliExpressAdapter)
    assert adapter.platform == "aliexpress"
    assert adapter.REQUIRES_CDP is True  # Akamai-blocked — host runner only


def test_get_adapter_unknown_platform_raises_value_error() -> None:
    with pytest.raises(ValueError):
        get_adapter("bogus")


# --- aliexpress.search_url / product_key --------------------------------------------------------


def test_aliexpress_search_url_rating_maps_to_best_selling() -> None:
    # AliExpress has no rating sort — rating_desc maps to best-selling (orders).
    url = AliExpressAdapter().search_url("rice cooker", "rating_desc", 1)
    assert url == (
        "https://www.aliexpress.com/w/wholesale-rice-cooker.html?page=1&SortType=total_tranpro_desc"
    )


def test_aliexpress_search_url_price_asc_page_2() -> None:
    url = AliExpressAdapter().search_url("yoga mat", "price_asc", 2)
    assert url == ("https://www.aliexpress.com/w/wholesale-yoga-mat.html?page=2&SortType=price_asc")


def test_aliexpress_search_url_relevance_is_default_sort() -> None:
    url = AliExpressAdapter().search_url("dumbbells", "relevance", 1)
    assert url.endswith("SortType=default")


def test_aliexpress_product_key_extracts_item_id() -> None:
    key = AliExpressAdapter().product_key(
        "https://www.aliexpress.us/item/3256807217377289.html?spm=abc"
    )
    assert key == "3256807217377289"


def test_aliexpress_product_key_none_for_non_item_href() -> None:
    assert AliExpressAdapter().product_key("https://www.aliexpress.com/w/wholesale-x.html") is None


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


# --- amazon.in (amazon_in) ----------------------------------------------------------------------
# A sibling marketplace that reuses amazon.ae's selectors/parsing via subclassing — these pin down
# the few things that must differ (host, locale, currency, key) and that amazon.ae is unaffected.


def test_amazon_in_search_url_relevance_no_sort_param() -> None:
    url = AmazonInAdapter().search_url("kids wooden toys", "relevance", 1)
    assert url == "https://www.amazon.in/s?k=kids%20wooden%20toys&page=1&language=en_IN"


@pytest.mark.parametrize(
    ("sort", "suffix"),
    [
        ("rating_desc", "&s=review-rank"),
        ("price_asc", "&s=price-asc-rank"),
        ("price_desc", "&s=price-desc-rank"),
    ],
)
def test_amazon_in_search_url_sort_params(sort: str, suffix: str) -> None:
    url = AmazonInAdapter().search_url("kids wooden toys", sort, 2)  # type: ignore[arg-type]
    assert url == f"https://www.amazon.in/s?k=kids%20wooden%20toys&page=2&language=en_IN{suffix}"


def test_amazon_in_registered_with_inr_currency_and_own_key() -> None:
    adapter = get_adapter("amazon_in")
    assert isinstance(adapter, AmazonInAdapter)
    assert adapter.platform == "amazon_in"
    assert adapter.default_currency == "INR"


def test_amazon_in_does_not_change_amazon_ae() -> None:
    adapter = get_adapter("amazon")
    assert type(adapter) is AmazonAdapter
    assert adapter.platform == "amazon"
    assert adapter.default_currency == "AED"
    assert (
        adapter.search_url("x", "relevance", 1)
        == "https://www.amazon.ae/s?k=x&page=1&language=en_AE"
    )


def test_amazon_in_is_a_host_runner_platform_and_amazon_ae_stays_in_the_container() -> None:
    # amazon.in 503s the headless container browser, so it runs on the host runner over the
    # operator's real Chrome (like noon). cdp_required_platforms() is what splits the queue between
    # the container daemon (excludes these) and the host runner (claims only these), so it must
    # contain amazon_in — and must NOT contain amazon.ae, which still runs headless in the
    # container.
    assert AmazonInAdapter.REQUIRES_CDP is True
    assert AmazonAdapter.REQUIRES_CDP is False
    assert cdp_required_platforms() == frozenset({"noon", "aliexpress", "amazon_in"})
    assert "amazon" not in cdp_required_platforms()


def test_amazon_in_product_key_extracts_asin_and_normalizes_to_amazon_in_host() -> None:
    adapter = AmazonInAdapter()
    assert adapter.product_key("/Wooden-Toy/dp/B0ABCDE123/ref=sr_1_1?qid=1") == "B0ABCDE123"
    href = "/Wooden-Toy/dp/B0ABCDE123/ref=sr_1_1?qid=1"
    url = adapter.normalize_product_url(href, adapter.base_url)
    assert url.startswith("https://www.amazon.in/Wooden-Toy/dp/B0ABCDE123")
    assert "qid=" not in url
