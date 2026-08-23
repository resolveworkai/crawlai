"""Authored by: Mohit Singh

Unit tests for property/analysis.py — the pure, no-I/O distress-deal scoring. Unlike
ecom/analysis.py (dict-duck-typed), this module takes real `ParsedListing` pydantic models, so
these tests build listings via a small `_l()` helper factory instead of plain dicts.

Every test that isolates a single component (e.g. `weights={"value": 1.0, ...: 0}`) explicitly
zeroes "yield" too — DEFAULT_WEIGHTS now has 5 keys, and merging a partial override that omits
"yield" would silently pull in its 0.20 default weight, breaking these tests' exact-value
assertions (neither listing here has average_rent, so yield_component is 0.5 for both — a real,
non-zero contribution unless explicitly zeroed).
"""

from __future__ import annotations

from business_scout_worker.property.analysis import (
    compute_distress_confidence,
    compute_distress_scores,
)
from business_scout_worker.property.models import ParsedListing


def _l(**kwargs: object) -> ParsedListing:
    base: dict[str, object] = {"idx": 1, "title": "A property"}
    base.update(kwargs)
    return ParsedListing.model_validate(base)


_ISOLATE_VALUE = {"value": 1.0, "keywords": 0, "freshness": 0, "verified": 0, "yield": 0}
_ISOLATE_KEYWORDS = {"value": 0, "keywords": 1.0, "freshness": 0, "verified": 0, "yield": 0}
_ISOLATE_FRESHNESS = {"value": 0, "keywords": 0, "freshness": 1.0, "verified": 0, "yield": 0}
_ISOLATE_VERIFIED = {"value": 0, "keywords": 0, "freshness": 0, "verified": 1.0, "yield": 0}
_ISOLATE_YIELD = {"value": 0, "keywords": 0, "freshness": 0, "verified": 0, "yield": 1.0}


# --- value_component (price/sqft percentile rank) ------------------------------------------------


def test_cheapest_price_per_sqft_scores_higher_on_value_alone() -> None:
    cheap = _l(idx=1, price=500_000, area_sqft=1000)  # 500/sqft
    expensive = _l(idx=2, price=2_000_000, area_sqft=1000)  # 2000/sqft
    scores = compute_distress_scores([cheap, expensive], weights=_ISOLATE_VALUE)
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
    scores = compute_distress_scores([no_price_no_area, has_both], weights=_ISOLATE_VALUE)
    assert scores[0] == 50.0  # neutral 0.5 * 100 -> missing fields
    assert scores[1] == 50.0  # neutral 0.5 * 100 -> only 1 rankable listing, nothing to compare to


def test_zero_area_sqft_excluded_from_ranking_treated_as_missing() -> None:
    zero_area = _l(idx=1, price=500_000, area_sqft=0)
    real = _l(idx=2, price=500_000, area_sqft=1000)
    scores = compute_distress_scores([zero_area, real], weights=_ISOLATE_VALUE)
    assert scores[0] == 50.0  # excluded from ranking -> neutral
    assert scores[1] == 50.0  # only 1 rankable listing -> also neutral (nothing to rank against)


# --- keywords_component ---------------------------------------------------------------------------


def test_distress_keywords_in_title_raise_score() -> None:
    plain = _l(idx=1, title="Spacious apartment in JVC")
    motivated = _l(idx=2, title="Motivated seller, urgent sale in JVC")
    scores = compute_distress_scores([plain, motivated], weights=_ISOLATE_KEYWORDS)
    assert scores[1] > scores[0]


def test_two_or_more_keyword_matches_caps_at_full_component() -> None:
    two_keywords = _l(idx=1, title="Motivated seller", description="Urgent sale, must sell")
    scores = compute_distress_scores([two_keywords], weights=_ISOLATE_KEYWORDS)
    assert scores[0] == 100.0  # capped at 1.0 component


def test_precomputed_distress_keywords_used_over_rescanning_title() -> None:
    # If distress_keywords is already populated (e.g. from Stage B), its length wins over a fresh
    # title/description scan — avoids double-counting or re-deriving what capture already found.
    listing = _l(
        idx=1,
        title="Nothing special here",
        distress_keywords=["urgent", "must sell"],
    )
    scores = compute_distress_scores([listing], weights=_ISOLATE_KEYWORDS)
    assert scores[0] == 100.0


# --- freshness_component --------------------------------------------------------------------------


def test_older_listing_scores_higher_on_freshness_alone() -> None:
    fresh = _l(idx=1, listed_days_ago=1)
    stale = _l(idx=2, listed_days_ago=60)
    scores = compute_distress_scores([fresh, stale], weights=_ISOLATE_FRESHNESS)
    assert scores[1] > scores[0]


def test_freshness_beyond_ceiling_days_clamped_not_unbounded() -> None:
    at_ceiling = _l(idx=1, listed_days_ago=60)
    way_past_ceiling = _l(idx=2, listed_days_ago=500)
    scores = compute_distress_scores([at_ceiling, way_past_ceiling], weights=_ISOLATE_FRESHNESS)
    assert scores[0] == scores[1] == 100.0


def test_missing_listed_days_ago_gets_neutral_freshness_not_zero() -> None:
    unknown = _l(idx=1, listed_days_ago=None)
    scores = compute_distress_scores([unknown], weights=_ISOLATE_FRESHNESS)
    assert scores[0] == 50.0  # neutral 0.5, never penalized to 0


# --- verified_component ---------------------------------------------------------------------------


def test_verified_listing_scores_higher_on_verified_alone() -> None:
    verified = _l(idx=1, verified=True)
    unverified = _l(idx=2, verified=False)
    scores = compute_distress_scores([verified, unverified], weights=_ISOLATE_VERIFIED)
    assert scores[0] == 100.0
    assert scores[1] == 0.0


# --- yield_component (rental-yield percentile rank, 2026-08-23) ----------------------------------


def test_higher_rental_yield_scores_higher_on_yield_alone() -> None:
    # Same price, but one rents for much more relative to its price -> better investment return.
    high_yield = _l(idx=1, price=1_000_000, average_rent=100_000)  # 10% yield
    low_yield = _l(idx=2, price=1_000_000, average_rent=40_000)  # 4% yield
    scores = compute_distress_scores([high_yield, low_yield], weights=_ISOLATE_YIELD)
    assert scores[0] > scores[1]


def test_missing_average_rent_gets_neutral_yield_not_zero() -> None:
    no_rent_data = _l(idx=1, price=1_000_000, average_rent=None)
    has_rent_data = _l(idx=2, price=1_000_000, average_rent=80_000)
    scores = compute_distress_scores([no_rent_data, has_rent_data], weights=_ISOLATE_YIELD)
    assert scores[0] == 50.0  # only 1 rankable listing -> neutral for both
    assert scores[1] == 50.0


def test_yield_ignores_listing_with_zero_or_missing_price() -> None:
    zero_price = _l(idx=1, price=0, average_rent=50_000)
    real = _l(idx=2, price=1_000_000, average_rent=80_000)
    scores = compute_distress_scores([zero_price, real], weights=_ISOLATE_YIELD)
    assert scores[0] == 50.0  # excluded from ranking -> neutral
    assert scores[1] == 50.0  # only 1 rankable listing -> also neutral


def test_yield_ranks_relative_to_batch_not_an_absolute_threshold() -> None:
    # Three listings so there's a genuine percentile spread (not just a 1-vs-1 flip).
    listings = [
        _l(idx=1, price=1_000_000, average_rent=100_000),  # 10% -> best
        _l(idx=2, price=1_000_000, average_rent=70_000),  # 7% -> middle
        _l(idx=3, price=1_000_000, average_rent=40_000),  # 4% -> worst
    ]
    scores = compute_distress_scores(listings, weights=_ISOLATE_YIELD)
    assert scores[0] > scores[1] > scores[2]


# --- custom weights + defaults ----------------------------------------------------------------


def test_custom_weights_change_ranking_vs_defaults() -> None:
    # Cheap-but-unverified vs. expensive-but-verified — flips depending on which factor is weighted.
    cheap_unverified = _l(idx=1, price=400_000, area_sqft=1000, verified=False)
    expensive_verified = _l(idx=2, price=1_500_000, area_sqft=1000, verified=True)

    value_only = compute_distress_scores(
        [cheap_unverified, expensive_verified], weights=_ISOLATE_VALUE
    )
    assert value_only[0] > value_only[1]

    verified_only = compute_distress_scores(
        [cheap_unverified, expensive_verified], weights=_ISOLATE_VERIFIED
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
    # Override only "verified" — value/keywords/freshness/yield should still use DEFAULT_WEIGHTS.
    overridden = compute_distress_scores([listing], weights={"verified": 0.0})
    baseline = compute_distress_scores([listing], weights={})
    # verified no longer contributes -> overridden score should be lower or equal (verified helps).
    assert overridden[0] <= baseline[0]


def test_scores_are_0_to_100_scale_and_rounded_to_one_decimal() -> None:
    listing = _l(idx=1, price=500_000, area_sqft=1000, listed_days_ago=30, verified=True)
    scores = compute_distress_scores([listing])
    assert 0.0 <= scores[0] <= 100.0
    assert scores[0] == round(scores[0], 1)


def test_default_weights_sum_to_one() -> None:
    # Not asserted by any individual score test, but worth pinning explicitly — if this drifts,
    # every score's 0-100 scale guarantee silently drifts with it.
    from business_scout_worker.property.analysis import DEFAULT_WEIGHTS

    assert round(sum(DEFAULT_WEIGHTS.values()), 6) == 1.0


# --- compute_distress_confidence (2026-08-23) -----------------------------------------------------


def test_fully_populated_listing_gets_full_confidence_in_a_rankable_batch() -> None:
    complete_a = _l(
        idx=1, price=500_000, area_sqft=1000, average_rent=40_000, listed_days_ago=10, verified=True
    )
    complete_b = _l(
        idx=2,
        price=900_000,
        area_sqft=1200,
        average_rent=60_000,
        listed_days_ago=20,
        verified=False,
    )
    confidences = compute_distress_confidence([complete_a, complete_b])
    assert confidences[0] == 100.0
    assert confidences[1] == 100.0


def test_missing_fields_lower_confidence_but_never_below_zero() -> None:
    sparse = _l(idx=1, price=None, area_sqft=None, average_rent=None, listed_days_ago=None)
    confidences = compute_distress_confidence([sparse])
    assert 0.0 <= confidences[0] < 100.0
    # keywords + verified are always "real" (0.20 + 0.10 of DEFAULT_WEIGHTS) even with everything
    # else missing, so confidence is never pinned all the way to 0.
    assert confidences[0] > 0.0


def test_single_ungrankable_listing_gets_lower_confidence_than_a_rankable_pair() -> None:
    # A listing alone in the batch has real price/area/rent, but nothing to rank against — value
    # and yield are neutral-fallback, not "real", so confidence should reflect that.
    alone = compute_distress_confidence(
        [
            _l(
                idx=1,
                price=500_000,
                area_sqft=1000,
                average_rent=40_000,
                listed_days_ago=10,
                verified=True,
            )
        ]
    )
    paired = compute_distress_confidence(
        [
            _l(
                idx=1,
                price=500_000,
                area_sqft=1000,
                average_rent=40_000,
                listed_days_ago=10,
                verified=True,
            ),
            _l(idx=2, price=900_000, area_sqft=1200, average_rent=60_000, listed_days_ago=20),
        ]
    )
    assert alone[0] < paired[0]


def test_missing_high_weight_field_drags_confidence_down_more_than_a_low_weight_one() -> None:
    # value (0.40) is the highest-weighted component; verified (0.10) is one of the lowest. Losing
    # the high-weight one should hurt confidence more than losing the low-weight one.
    missing_value_inputs = _l(
        idx=1, price=None, area_sqft=None, average_rent=40_000, listed_days_ago=10, verified=True
    )
    baseline = _l(
        idx=1, price=500_000, area_sqft=1000, average_rent=40_000, listed_days_ago=10, verified=True
    )
    peer = _l(idx=2, price=900_000, area_sqft=1200, average_rent=60_000, listed_days_ago=20)

    confidence_missing_value = compute_distress_confidence([missing_value_inputs, peer])[0]
    confidence_baseline = compute_distress_confidence([baseline, peer])[0]
    assert confidence_missing_value < confidence_baseline


def test_confidence_scale_and_rounding_match_scores() -> None:
    listing = _l(idx=1, price=500_000, area_sqft=1000, listed_days_ago=30, verified=True)
    confidences = compute_distress_confidence([listing])
    assert 0.0 <= confidences[0] <= 100.0
    assert confidences[0] == round(confidences[0], 1)


def test_confidence_empty_list_returns_empty() -> None:
    assert compute_distress_confidence([]) == []
