"""Authored by: Mohit Singh

Distress-deal scoring — the property-module analogue of ecom/analysis.py's opportunity_score, but
built around what actually signals a good BUY (acting as the buyer, per the brief), not review
volume/rating. Computed as a final pass AFTER every listing in the batch is parsed (the value and
yield components are relative to the batch's own distribution, so they can't be computed
per-listing in isolation) — same "final pass after all rows parsed" shape ecom/pipeline.py uses.

Note on "is there an existing Python library for this" (2026-08-23, investigated per a direct ask):
no. Multi-parameter real-estate deal scoring with a genuine confidence figure isn't something
scikit-learn/statsmodels/etc. gives you off the shelf — those are general ML toolkits, and a
*supervised* deal-quality model needs labeled ground truth ("this listing really was underpriced by
X%") that doesn't exist anywhere in this pipeline (or, realistically, publicly for the UAE market at
this granularity). What DOES generalize from that world and IS used here: percentile-rank
normalization instead of min/max (already the value_component's approach — resistant to a single
outlier compressing everyone else), and a genuine per-listing confidence score (below) that reflects
how much of the final number is backed by real data vs. neutral fallbacks, rather than presenting
every score as equally certain. That's the honest, buildable version of "confidence" here — a data-
completeness measure, not a statistical prediction interval (there's no model to have one).

FIVE components, each 0-1, combined with configurable weights (property_jobs.score_weights;
DEFAULT_WEIGHTS below when absent):
  value      (default 0.40) — price-per-sqft PERCENTILE RANK within the batch, cheapest-first.
             Percentile rank (not min/max normalization) so one absurdly-priced outlier listing
             can't compress everyone else's score toward the middle.
  keywords   (default 0.20) — distress-sale language found in the title/description
             (parse_property.DISTRESS_KEYWORDS — "motivated seller", "urgent", "below market", …).
             Scaled by how many distinct phrases matched, capped at 1.0.
  freshness  (default 0.10) — days-on-market as a motivated-seller proxy (older listing = more
             room to negotiate). Neutral (0.5) when the platform doesn't expose it at all (dubizzle
             doesn't; propertyfinder does) rather than penalizing a whole platform for a field gap.
  verified   (default 0.10) — the platform's own "Verified" listing badge (lower fraud/bait
             risk) — a real signal, but a small weight since it's a trust check, not value.
  yield      (default 0.20, NEW 2026-08-23) — rental yield (average_rent / price) PERCENTILE RANK
             among whichever listings in the batch have both fields — a higher yield means a
             better return if bought as an investment, not just a lower sticker price. average_rent
             only exists for detail-scraped listings (pipeline.py's Stage D, top-N by the FIRST
             scoring pass — before any yield data exists, so it can't circularly influence its own
             selection). pipeline.py re-runs this whole function once more AFTER Stage D so the
             final displayed score/ranking rewards real yield for the listings it was measured on;
             listings without average_rent get the neutral 0.5, same convention as every other
             component's missing-data fallback.

`compute_distress_scores` returns the 0-100 score. `compute_distress_confidence`, a sibling pure
function over the SAME inputs/weights, returns a parallel 0-100 "how much of this score is backed
by real data, not a neutral fallback" figure — weighted by the same per-component weights, so a
missing HIGH-weight field (e.g. no price/area — most of `value`) drags confidence down more than a
missing LOW-weight one. A listing with every field present scores 100 regardless of how good or bad
the deal itself is; a listing scored almost entirely off neutral fallbacks scores low, flagging it
as "we don't actually know much about this one" even if its distress_score happens to be middling.
"""

from __future__ import annotations

from collections.abc import Callable

from business_scout_worker.property.models import ParsedListing
from business_scout_worker.property.parse_property import find_distress_keywords

DEFAULT_WEIGHTS: dict[str, float] = {
    "value": 0.40,
    "keywords": 0.20,
    "freshness": 0.10,
    "verified": 0.10,
    "yield": 0.20,
}

_FRESHNESS_CEILING_DAYS = 60.0
"""A listing stale 60+ days is treated as maximally "motivated seller" — beyond this, more days
doesn't further raise the score (a market-dead listing isn't necessarily a better deal, just an
older one)."""


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def _percentile_rank_component(
    listings: list[ParsedListing],
    value_fn: Callable[[ParsedListing], float | None],
    *,
    higher_is_better: bool,
) -> dict[int, float]:
    """Shared percentile-rank machinery for `value` (cheaper-per-sqft is better -> rank descending)
    and `yield` (higher rent-to-price is better -> rank ascending) — same "rank relative to the
    batch's own distribution, neutral 0.5 when there's nothing to rank against" shape for both, so
    they can't silently drift apart in behavior. `value_fn` returns None for a listing that can't
    be ranked at all (a missing input field)."""
    rankable = [
        (i, v) for i, listing in enumerate(listings) if (v := value_fn(listing)) is not None
    ]
    component = {i: 0.5 for i in range(len(listings))}
    if len(rankable) >= 2:
        ranked = sorted(rankable, key=lambda t: t[1], reverse=higher_is_better)
        n = len(ranked)
        for rank, (i, _v) in enumerate(ranked):
            component[i] = _clamp01(1.0 - rank / (n - 1))
    # len == 1 or 0 -> nothing to rank against, stays neutral 0.5 for every listing (including the
    # one real value, if any) — matches the pre-existing value_component behavior exactly.
    return component


def _price_per_sqft(listing: ParsedListing) -> float | None:
    if listing.price is None or listing.area_sqft is None or listing.area_sqft <= 0:
        return None
    return listing.price / listing.area_sqft


def _rental_yield(listing: ParsedListing) -> float | None:
    if listing.average_rent is None or listing.price is None or listing.price <= 0:
        return None
    return listing.average_rent / listing.price


def _components(
    listings: list[ParsedListing],
) -> tuple[dict[int, float], dict[int, float]]:
    """The two batch-relative components, computed once and shared by both compute_* functions
    below so they can never disagree on what "rankable" means for a given listing."""
    value_component = _percentile_rank_component(listings, _price_per_sqft, higher_is_better=False)
    yield_component = _percentile_rank_component(listings, _rental_yield, higher_is_better=True)
    return value_component, yield_component


def compute_distress_scores(
    listings: list[ParsedListing], weights: dict[str, float] | None = None
) -> list[float]:
    """Returns one score per listing, same order as `listings` in, 0-100 scale. Pure function
    (no I/O) so it's directly unit-testable without a DB/browser."""
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    value_component, yield_component = _components(listings)

    scores: list[float] = []
    for i, listing in enumerate(listings):
        keyword_count = len(listing.distress_keywords) or len(
            find_distress_keywords(f"{listing.title} {listing.description or ''}")
        )
        keyword_component = _clamp01(keyword_count / 2.0)

        # Neutral 0.5 when this listing (or the whole platform) doesn't expose days-on-market —
        # a missing field isn't evidence either way, so it must not drag the score down.
        freshness_component = (
            _clamp01(listing.listed_days_ago / _FRESHNESS_CEILING_DAYS)
            if listing.listed_days_ago is not None
            else 0.5
        )

        verified_component = 1.0 if listing.verified else 0.0

        score = 100.0 * (
            w["value"] * value_component[i]
            + w["keywords"] * keyword_component
            + w["freshness"] * freshness_component
            + w["verified"] * verified_component
            + w["yield"] * yield_component[i]
        )
        scores.append(round(score, 1))
    return scores


def compute_distress_confidence(
    listings: list[ParsedListing], weights: dict[str, float] | None = None
) -> list[float]:
    """Returns one confidence figure per listing (0-100, same order as `listings` in) — the
    fraction of `compute_distress_scores`'s weight that came from REAL data for this listing rather
    than a neutral 0.5 fallback. Divides by the weights' own sum (not a hardcoded 1.0) so it stays
    correct even against an unnormalized/partial weights override (e.g. a test isolating one
    component)."""
    w = {**DEFAULT_WEIGHTS, **(weights or {})}
    weight_total = sum(w.values())
    value_component, yield_component = _components(listings)
    # Percentile-rank components are only "real" for a listing when the batch actually had >=2
    # rankable entries AND this listing was one of them — mirrors _percentile_rank_component's own
    # neutral-fallback condition exactly (checked directly here rather than re-deriving it, so the
    # two functions can never drift apart on what counts as "real").
    value_rankable = {i for i, v in enumerate(listings) if _price_per_sqft(v) is not None}
    yield_rankable = {i for i, v in enumerate(listings) if _rental_yield(v) is not None}
    value_is_real = len(value_rankable) >= 2
    yield_is_real = len(yield_rankable) >= 2

    confidences: list[float] = []
    for i, listing in enumerate(listings):
        has_value = value_is_real and i in value_rankable
        has_freshness = listing.listed_days_ago is not None
        has_yield = yield_is_real and i in yield_rankable
        # keywords and verified are always "real" — a 0-keyword-match or unverified listing is a
        # real, known fact, never a missing one.
        if weight_total <= 0:
            confidences.append(0.0)
            continue
        confidence = (
            100.0
            * (
                w["value"] * (1.0 if has_value else 0.0)
                + w["keywords"] * 1.0
                + w["freshness"] * (1.0 if has_freshness else 0.0)
                + w["verified"] * 1.0
                + w["yield"] * (1.0 if has_yield else 0.0)
            )
            / weight_total
        )
        confidences.append(round(_clamp01(confidence / 100.0) * 100.0, 1))
    return confidences
