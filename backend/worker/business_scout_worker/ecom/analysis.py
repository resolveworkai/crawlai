"""Authored by: Mohit Singh

Pure, no-I/O opportunity-scoring + summary math for the e-commerce Product Research pipeline.
Deliberately kept free of DB/Playwright imports so it's trivially unit-testable and so the exact
same algorithm can be ported/mirrored by the Node API service (see the migration's comment on
`REVENUE_UNION_SQL`-style single-source-of-truth math — this file is that source for scoring).
"""

from __future__ import annotations

import math
from collections import Counter
from typing import Any

DEFAULT_WEIGHTS: dict[str, float] = {
    "reviews": 0.35,
    "rating": 0.25,
    "demand": 0.25,
    "value": 0.15,
}


def _get(product: Any, field: str) -> Any:
    """Accepts a ParsedProduct instance, a plain dict, or any mapping-like object — duck-typed so
    this module has zero dependency on the pydantic model shape."""
    if isinstance(product, dict):
        return product.get(field)
    return getattr(product, field, None)


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def compute_opportunity_scores(
    products: list[Any], weights: dict[str, float] | None = None
) -> list[float]:
    """Returns one score (0-100) per product, in the same order as `products`. Sponsored rows are
    excluded from computing the batch's max_reviews/max_bought/median_price (those denominators
    should reflect organic competition, not paid placements) but are still scored themselves using
    those same denominators — a sponsored product's own opportunity is still worth showing.

    reviews_n = log10(reviews+1) / log10(max_reviews+1)
    rating_n  = clamp((rating-3)/2, 0, 1)
    demand_n  = log10(bought+1) / log10(max_bought+1)   (0 if bought is None)
    value_n   = 1 - clamp(|price-median_price| / median_price, 0, 1)  (1.0 if price missing or
                median_price is 0 — "no penalty" rather than a division error)
    score = 100 * sum(weight_i * component_i)
    """
    if not products:
        return []

    w = weights or DEFAULT_WEIGHTS

    organic = [p for p in products if not _get(p, "sponsored")] or list(products)
    review_counts = [c for p in organic if (c := _get(p, "review_count")) is not None]
    bought_counts = [c for p in organic if (c := _get(p, "bought_past_month")) is not None]
    prices = [pr for p in organic if (pr := _get(p, "price")) is not None]

    max_reviews = max(review_counts) if review_counts else 0
    max_bought = max(bought_counts) if bought_counts else 0
    median_price = _median(prices) if prices else 0.0

    log_max_reviews = math.log10(max_reviews + 1) or 1.0
    log_max_bought = math.log10(max_bought + 1) or 1.0

    scores: list[float] = []
    for product in products:
        reviews = _get(product, "review_count") or 0
        rating = _get(product, "rating")
        bought = _get(product, "bought_past_month")
        price = _get(product, "price")

        reviews_n = math.log10(reviews + 1) / log_max_reviews if log_max_reviews else 0.0
        rating_n = _clamp(((rating - 3) / 2), 0.0, 1.0) if rating is not None else 0.0
        if bought is not None and log_max_bought:
            demand_n = math.log10(bought + 1) / log_max_bought
        else:
            demand_n = 0.0
        if price is None or median_price == 0:
            value_n = 1.0
        else:
            value_n = 1.0 - _clamp(abs(price - median_price) / median_price, 0.0, 1.0)

        score = 100.0 * (
            w.get("reviews", 0.0) * reviews_n
            + w.get("rating", 0.0) * rating_n
            + w.get("demand", 0.0) * demand_n
            + w.get("value", 0.0) * value_n
        )
        scores.append(round(score, 2))

    return scores


def _median(values: list[float]) -> float:
    s = sorted(values)
    n = len(s)
    mid = n // 2
    if n % 2 == 1:
        return s[mid]
    return (s[mid - 1] + s[mid]) / 2.0


def _percentile(sorted_values: list[float], pct: float) -> float | None:
    if not sorted_values:
        return None
    if len(sorted_values) == 1:
        return sorted_values[0]
    k = (len(sorted_values) - 1) * pct
    f, c = math.floor(k), math.ceil(k)
    if f == c:
        return sorted_values[int(k)]
    return sorted_values[f] + (sorted_values[c] - sorted_values[f]) * (k - f)


def build_summary(products: list[Any]) -> dict[str, Any]:
    """Plain-JSON-serializable summary for the analysis endpoint: price distribution, rating
    stats, review-count stats, delivery/badge frequency, and the top-10 products by
    opportunity_score. Callers pass products that already carry `opportunity_score` (computed via
    `compute_opportunity_scores` in the pipeline before upsert); this function never recomputes
    scores itself — it only aggregates."""
    prices = sorted(pr for p in products if (pr := _get(p, "price")) is not None)
    ratings = [r for p in products if (r := _get(p, "rating")) is not None]
    review_counts = [c for p in products if (c := _get(p, "review_count")) is not None]
    bought_counts = [c for p in products if (c := _get(p, "bought_past_month")) is not None]
    free_delivery_count = sum(1 for p in products if _get(p, "free_delivery"))

    badge_counter: Counter[str] = Counter()
    for p in products:
        for b in _get(p, "badges") or []:
            badge_counter[b] += 1

    total = len(products)

    price_summary = {
        "min": prices[0] if prices else None,
        "p25": _percentile(prices, 0.25),
        "median": _percentile(prices, 0.5),
        "p75": _percentile(prices, 0.75),
        "max": prices[-1] if prices else None,
    }

    top_10 = sorted(
        (
            {
                "idx": _get(p, "idx"),
                "title": _get(p, "title"),
                "score": _get(p, "opportunity_score") or 0.0,
            }
            for p in products
        ),
        key=lambda r: r["score"],
        reverse=True,
    )[:10]

    return {
        "total_count": total,
        "price": price_summary,
        "rating": {
            "avg": (sum(ratings) / len(ratings)) if ratings else None,
            "median": _percentile(sorted(ratings), 0.5) if ratings else None,
        },
        "review_count": {
            "total": sum(review_counts) if review_counts else 0,
            "median": _percentile(sorted(review_counts), 0.5) if review_counts else None,
        },
        "bought_past_month": {
            "count": len(bought_counts),
            "sum": sum(bought_counts) if bought_counts else 0,
        },
        "free_delivery_pct": (free_delivery_count / total * 100.0) if total else 0.0,
        "badge_frequency": dict(badge_counter.most_common(20)),
        "top_10_by_opportunity": top_10,
    }
