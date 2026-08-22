"""Authored by: Mohit Singh

Distress-deal scoring — the property-module analogue of ecom/analysis.py's opportunity_score, but
built around what actually signals a good BUY (acting as the buyer, per the brief), not review
volume/rating. Computed as a final pass AFTER every listing in the batch is parsed (the value
component is relative to the batch's own price/sqft distribution, so it can't be computed
per-listing in isolation) — same "final pass after all rows parsed" shape ecom/pipeline.py uses.

Four components, each 0-1, combined with configurable weights (property_jobs.score_weights;
DEFAULT_WEIGHTS below when absent):
  value      (default 0.50) — price-per-sqft PERCENTILE RANK within the batch, cheapest-first.
             Percentile rank (not min/max normalization) so one absurdly-priced outlier listing
             can't compress everyone else's score toward the middle.
  keywords   (default 0.20) — distress-sale language found in the title/description
             (parse_property.DISTRESS_KEYWORDS — "motivated seller", "urgent", "below market", …).
             Scaled by how many distinct phrases matched, capped at 1.0.
  freshness  (default 0.15) — days-on-market as a motivated-seller proxy (older listing = more
             room to negotiate). Neutral (0.5) when the platform doesn't expose it at all (dubizzle
             doesn't; propertyfinder does) rather than penalizing a whole platform for a field gap.
  verified   (default 0.15) — the platform's own "Verified" listing badge (lower fraud/bait
             risk) — a real signal, but the smallest weight since it's a trust check, not value.
"""

from __future__ import annotations

from business_scout_worker.property.models import ParsedListing
from business_scout_worker.property.parse_property import find_distress_keywords

DEFAULT_WEIGHTS: dict[str, float] = {
    "value": 0.50,
    "keywords": 0.20,
    "freshness": 0.15,
    "verified": 0.15,
}

_FRESHNESS_CEILING_DAYS = 60.0
"""A listing stale 60+ days is treated as maximally "motivated seller" — beyond this, more days
doesn't further raise the score (a market-dead listing isn't necessarily a better deal, just an
older one)."""


def _clamp01(x: float) -> float:
    return max(0.0, min(1.0, x))


def compute_distress_scores(
    listings: list[ParsedListing], weights: dict[str, float] | None = None
) -> list[float]:
    """Returns one score per listing, same order as `listings` in, 0-100 scale. Pure function
    (no I/O) so it's directly unit-testable without a DB/browser."""
    w = {**DEFAULT_WEIGHTS, **(weights or {})}

    pps_values = [
        (i, (listing.price / listing.area_sqft))
        for i, listing in enumerate(listings)
        if listing.price is not None and listing.area_sqft is not None and listing.area_sqft > 0
    ]
    # Percentile rank, cheapest (lowest price/sqft) -> value_component near 1.0. A listing missing
    # price or area entirely can't be value-ranked at all — neutral 0.5, not penalized to 0 (a
    # missing field isn't evidence of a bad deal, just an unknown one).
    value_component = {i: 0.5 for i in range(len(listings))}
    if len(pps_values) >= 2:
        ranked = sorted(pps_values, key=lambda t: t[1])
        n = len(ranked)
        for rank, (i, _pps) in enumerate(ranked):
            value_component[i] = _clamp01(1.0 - rank / (n - 1))
    elif len(pps_values) == 1:
        value_component[pps_values[0][0]] = 0.5  # nothing to rank against

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
        )
        scores.append(round(score, 1))
    return scores
