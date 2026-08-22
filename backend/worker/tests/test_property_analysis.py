"""Authored by: Mohit Singh

Unit tests for property/analysis.py — the pure, no-I/O distress-deal scoring. Unlike
ecom/analysis.py (dict-duck-typed), this module takes real `ParsedListing` pydantic models, so
these tests build listings via a small `_l()` helper factory instead of plain dicts.
"""

from __future__ import annotations

from business_scout_worker.property.analysis import compute_distress_scores
from business_scout_worker.property.models import ParsedListing


def _l(**kwargs: object) -> ParsedListing:
    base: dict[str, object] = {"idx": 1, "title": "A property"}
    base.update(kwargs)
    return ParsedListing.model_validate(base)


# --- value_component (price/sqft percentile rank) ------------------------------------------------


def test_cheapest_price_per_sqft_scores_higher_on_value_alone() -> None:
    cheap = _l(idx=1, price=500_000, area_sqft=1000)  # 500/sqft
    expensive = _l(idx=2, price=2_000_000, area_sqft=1000)  # 2000/sqft
    scores = compute_distress_scores(
        [cheap, expensive], weights={"value": 1.0, "keywords": 0, "freshness": 0, "verified": 0}
    )
    assert scores[0] > scores[1]


def test_scores_are_deterministic() -> None:
    listings = [
        _l(idx=1, price=500_000, area_sqft=1000, listed_days_ago=10),
        _l(idx=2, price=900_000, area_sqft=1200, verified=True),
    ]
    first = compute_distress_scores(listings)
    second = compute_distress_scores(listings)
    assert first == second


def test_single_listing_gets_neutral_value_component_no_divide_by_zero() -> None:
    scores = compute_distress_scores([_l(idx=1, price=500_000, area_sqft=1000)])
    assert len(scores) == 1
    assert scores[0] >= 0.0


def test_empty_list_returns_empty_scores() -> None:
    assert compute_distress_scores([]) == []


def test_missing_price_or_area_gets_neutral_value_component_not_penalized() -> None:
    # Neither field present at all — must not crash, and must not be pinned to 0. With only ONE
    # rankable listing overall there's nothing to rank against, so both get the neutral 0.5.
    no_price_no_area = _l(idx=1, price=None, area_sqft=None)
    has_both = _l(idx=2, price=500_000, area_sqft=1000)
    scores = compute_distress_scores(
        [no_price_no_area, has_both],
        weights={"value": 1.0, "keywords": 0, "freshness": 0, "verified": 0},
    )
    assert scores[0] == 50.0  # neutral 0.5 * 100 -> missing fields
    assert scores[1] == 50.0  # neutral 0.5 * 100 -> only 1 rankable listing, nothing to compare to


def test_zero_area_sqft_excluded_from_ranking_treated_as_missing() -> None:
    zero_area = _l(idx=1, price=500_000, area_sqft=0)
    real = _l(idx=2, price=500_000, area_sqft=1000)
    scores = compute_distress_scores(
        [zero_area, real], weights={"value": 1.0, "keywords": 0, "freshness": 0, "verified": 0}
    )
    assert scores[0] == 50.0  # excluded from pps_values -> neutral
    assert scores[1] == 50.0  # only 1 rankable listing -> also neutral (nothing to rank against)


# --- keywords_component ---------------------------------------------------------------------------


def test_distress_keywords_in_title_raise_score() -> None:
    plain = _l(idx=1, title="Spacious apartment in JVC")
    motivated = _l(idx=2, title="Motivated seller, urgent sale in JVC")
    scores = compute_distress_scores(
        [plain, motivated], weights={"value": 0, "keywords": 1.0, "freshness": 0, "verified": 0}
    )
    assert scores[1] > scores[0]


def test_two_or_more_keyword_matches_caps_at_full_component() -> None:
    two_keywords = _l(idx=1, title="Motivated seller", description="Urgent sale, must sell")
    scores = compute_distress_scores(
        [two_keywords], weights={"value": 0, "keywords": 1.0, "freshness": 0, "verified": 0}
    )
    assert scores[0] == 100.0  # capped at 1.0 component


def test_precomputed_distress_keywords_used_over_rescanning_title() -> None:
    # If distress_keywords is already populated (e.g. from Stage B), its length wins over a fresh
    # title/description scan — avoids double-counting or re-deriving what capture already found.
    listing = _l(
        idx=1,
        title="Nothing special here",
        distress_keywords=["urgent", "must sell"],
    )
    scores = compute_distress_scores(
        [listing], weights={"value": 0, "keywords": 1.0, "freshness": 0, "verified": 0}
    )
    assert scores[0] == 100.0


# --- freshness_component --------------------------------------------------------------------------


def test_older_listing_scores_higher_on_freshness_alone() -> None:
    fresh = _l(idx=1, listed_days_ago=1)
    stale = _l(idx=2, listed_days_ago=60)
    scores = compute_distress_scores(
        [fresh, stale], weights={"value": 0, "keywords": 0, "freshness": 1.0, "verified": 0}
    )
    assert scores[1] > scores[0]


def test_freshness_beyond_ceiling_days_clamped_not_unbounded() -> None:
    at_ceiling = _l(idx=1, listed_days_ago=60)
    way_past_ceiling = _l(idx=2, listed_days_ago=500)
    scores = compute_distress_scores(
        [at_ceiling, way_past_ceiling],
        weights={"value": 0, "keywords": 0, "freshness": 1.0, "verified": 0},
    )
    assert scores[0] == scores[1] == 100.0


def test_missing_listed_days_ago_gets_neutral_freshness_not_zero() -> None:
    unknown = _l(idx=1, listed_days_ago=None)
    scores = compute_distress_scores(
        [unknown], weights={"value": 0, "keywords": 0, "freshness": 1.0, "verified": 0}
    )
    assert scores[0] == 50.0  # neutral 0.5, never penalized to 0


# --- verified_component ---------------------------------------------------------------------------


def test_verified_listing_scores_higher_on_verified_alone() -> None:
    verified = _l(idx=1, verified=True)
    unverified = _l(idx=2, verified=False)
    scores = compute_distress_scores(
        [verified, unverified], weights={"value": 0, "keywords": 0, "freshness": 0, "verified": 1.0}
    )
    assert scores[0] == 100.0
    assert scores[1] == 0.0


# --- custom weights + defaults ----------------------------------------------------------------


def test_custom_weights_change_ranking_vs_defaults() -> None:
    # Cheap-but-unverified vs. expensive-but-verified — flips depending on which factor is weighted.
    cheap_unverified = _l(idx=1, price=400_000, area_sqft=1000, verified=False)
    expensive_verified = _l(idx=2, price=1_500_000, area_sqft=1000, verified=True)

    value_only = compute_distress_scores(
        [cheap_unverified, expensive_verified],
        weights={"value": 1.0, "keywords": 0, "freshness": 0, "verified": 0},
    )
    assert value_only[0] > value_only[1]

    verified_only = compute_distress_scores(
        [cheap_unverified, expensive_verified],
        weights={"value": 0, "keywords": 0, "freshness": 0, "verified": 1.0},
    )
    assert verified_only[1] > verified_only[0]


def test_default_weights_used_when_none_given() -> None:
    listings = [
        _l(idx=1, price=500_000, area_sqft=1000),
        _l(idx=2, price=1_000_000, area_sqft=1000),
    ]
    with_none = compute_distress_scores(listings, weights=None)
    with_defaults = compute_distress_scores(listings, weights={})
    assert with_none == with_defaults


def test_partial_weight_override_merges_with_defaults() -> None:
    listing = _l(idx=1, verified=True)
    # Override only "verified" — value/keywords/freshness should still use DEFAULT_WEIGHTS.
    overridden = compute_distress_scores([listing], weights={"verified": 0.0})
    baseline = compute_distress_scores([listing], weights={})
    # verified no longer contributes -> overridden score should be lower or equal (verified helps).
    assert overridden[0] <= baseline[0]


def test_scores_are_0_to_100_scale_and_rounded_to_one_decimal() -> None:
    listing = _l(idx=1, price=500_000, area_sqft=1000, listed_days_ago=30, verified=True)
    scores = compute_distress_scores([listing])
    assert 0.0 <= scores[0] <= 100.0
    assert scores[0] == round(scores[0], 1)
