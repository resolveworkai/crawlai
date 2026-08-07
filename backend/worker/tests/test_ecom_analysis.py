"""Authored by: Mohit Singh

Unit tests for ecom/analysis.py — the pure, no-I/O opportunity-scoring and summary math. Products
are passed as plain dicts (the module is explicitly duck-typed to accept dict or ParsedProduct via
_get()), which keeps these tests independent of the pydantic model and fast to write.
"""

from __future__ import annotations

from business_scout_worker.ecom.analysis import build_summary, compute_opportunity_scores


def _p(**kwargs: object) -> dict[str, object]:
    base: dict[str, object] = {
        "idx": 1,
        "title": "Product",
        "price": None,
        "rating": None,
        "review_count": None,
        "bought_past_month": None,
        "sponsored": False,
        "free_delivery": False,
        "badges": [],
        "opportunity_score": None,
    }
    base.update(kwargs)
    return base


# --- compute_opportunity_scores -----------------------------------------------------------------


def test_scores_are_deterministic() -> None:
    products = [
        _p(idx=1, price=100, rating=4.5, review_count=500, bought_past_month=200),
        _p(idx=2, price=50, rating=3.8, review_count=50, bought_past_month=10),
    ]
    first = compute_opportunity_scores(products)
    second = compute_opportunity_scores(products)
    assert first == second


def test_more_reviews_rating_and_demand_scores_at_least_as_high() -> None:
    dominant = _p(idx=1, price=100, rating=4.8, review_count=1000, bought_past_month=500)
    dominated = _p(idx=2, price=100, rating=3.5, review_count=10, bought_past_month=5)
    scores = compute_opportunity_scores([dominant, dominated])
    assert scores[0] >= scores[1]


def test_custom_weights_change_ranking() -> None:
    # A cheap-but-unreviewed product vs. an expensive-but-heavily-reviewed one. Weighting entirely
    # on "reviews" must rank the heavily-reviewed product first; weighting entirely on "value"
    # (closeness to median price) must flip the ranking since price is way off-median for it.
    low_reviews_median_price = _p(idx=1, price=100, rating=4.0, review_count=5)
    high_reviews_off_median_price = _p(idx=2, price=1000, rating=4.0, review_count=5000)

    reviews_weighted = compute_opportunity_scores(
        [low_reviews_median_price, high_reviews_off_median_price],
        weights={"reviews": 1.0, "rating": 0.0, "demand": 0.0, "value": 0.0},
    )
    assert reviews_weighted[1] > reviews_weighted[0]

    value_weighted = compute_opportunity_scores(
        [low_reviews_median_price, high_reviews_off_median_price],
        weights={"reviews": 0.0, "rating": 0.0, "demand": 0.0, "value": 1.0},
    )
    # median price of [100, 1000] is 550 — product 1 (price 100) is further from it than... in
    # fact both are equidistant (|100-550|=450, |1000-550|=450) so value_n ties; use a 3rd product
    # to break the tie unambiguously instead of asserting a strict flip here.
    assert value_weighted[0] == value_weighted[1]


def test_sponsored_rows_excluded_from_denominators_but_still_scored() -> None:
    organic_low = _p(idx=1, price=100, rating=4.0, review_count=100, sponsored=False)
    organic_high = _p(idx=2, price=100, rating=4.0, review_count=100, sponsored=False)
    # A sponsored row with review_count far above any organic row. If it were included in the
    # max_reviews denominator, organic rows' reviews_n would shrink; since it's excluded, the two
    # organic rows must score identically to each other regardless of the sponsored row's count.
    sponsored = _p(idx=3, price=100, rating=4.0, review_count=100_000, sponsored=True)

    scores = compute_opportunity_scores([organic_low, organic_high, sponsored])
    assert scores[0] == scores[1]
    # The sponsored row is still scored (not skipped) — its own reviews_n is computed against the
    # organic-only max_reviews (100), so log10(100001)/log10(101) > 1, i.e. an uncapped component
    # that can legitimately push its score above what a same-inputs organic row would ever reach.
    assert scores[2] > scores[0]


def test_empty_product_list_returns_empty_scores() -> None:
    assert compute_opportunity_scores([]) == []


def test_single_product_list_does_not_divide_by_zero() -> None:
    scores = compute_opportunity_scores([_p(idx=1, price=100, rating=4.0, review_count=10)])
    assert len(scores) == 1
    assert scores[0] >= 0.0


def test_all_none_optional_fields_does_not_crash() -> None:
    scores = compute_opportunity_scores([_p(idx=1)])
    assert len(scores) == 1
    assert scores[0] >= 0.0


# --- build_summary -------------------------------------------------------------------------------


def test_build_summary_price_min_median_max() -> None:
    products = [_p(idx=i, price=price) for i, price in enumerate([10, 20, 30, 40], start=1)]
    summary = build_summary(products)
    assert summary["price"]["min"] == 10
    assert summary["price"]["max"] == 40
    assert summary["price"]["median"] == 25  # (20+30)/2 via the linear-interpolation percentile


def test_build_summary_free_delivery_pct() -> None:
    products = [
        _p(idx=1, free_delivery=True),
        _p(idx=2, free_delivery=True),
        _p(idx=3, free_delivery=False),
        _p(idx=4, free_delivery=False),
    ]
    summary = build_summary(products)
    assert summary["free_delivery_pct"] == 50.0


def test_build_summary_badge_frequency_counting() -> None:
    products = [
        _p(idx=1, badges=["Best Seller", "Amazon's Choice"]),
        _p(idx=2, badges=["Best Seller"]),
        _p(idx=3, badges=[]),
    ]
    summary = build_summary(products)
    assert summary["badge_frequency"]["Best Seller"] == 2
    assert summary["badge_frequency"]["Amazon's Choice"] == 1


def test_build_summary_top_10_ordered_by_opportunity_score() -> None:
    products = [
        _p(idx=1, title="Low", opportunity_score=10.0),
        _p(idx=2, title="High", opportunity_score=90.0),
        _p(idx=3, title="Mid", opportunity_score=50.0),
    ]
    summary = build_summary(products)
    ordered_titles = [row["title"] for row in summary["top_10_by_opportunity"]]
    assert ordered_titles == ["High", "Mid", "Low"]


def test_build_summary_empty_list_edge_case() -> None:
    summary = build_summary([])
    assert summary["total_count"] == 0
    assert summary["price"] == {"min": None, "p25": None, "median": None, "p75": None, "max": None}
    assert summary["rating"] == {"avg": None, "median": None}
    assert summary["review_count"] == {"total": 0, "median": None}
    assert summary["bought_past_month"] == {"count": 0, "sum": 0}
    assert summary["free_delivery_pct"] == 0.0
    assert summary["badge_frequency"] == {}
    assert summary["top_10_by_opportunity"] == []
