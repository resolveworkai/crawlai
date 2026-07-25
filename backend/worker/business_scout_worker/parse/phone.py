"""Authored by: Mohit Singh

Real phone validation/normalization — the piece Tier-1's regex heuristic (enrich/tier1.py)
deliberately does NOT do (it only decides "does this look phone-shaped", not "is this a real,
dialable number"). See md/plans/0001-*.md Phase 4: "phonenumbers.parse(num, region) where region
comes from the OSM country tag — omitting it silently drops valid national-format numbers."
"""

from __future__ import annotations

import phonenumbers


def normalize_phones(candidates: list[str], region: str | None) -> list[str]:
    """Parses each candidate with `region` as the fallback country for numbers that aren't
    already in `+<countrycode>` international form (most local-format numbers found on a
    business's own site aren't). Invalid/unparseable candidates are dropped silently — this is
    a precision step, not a "salvage everything" step. Returns deduped E.164-formatted numbers,
    order-preserving."""
    seen: dict[str, None] = {}
    for candidate in candidates:
        try:
            parsed = phonenumbers.parse(candidate, region)
        except phonenumbers.NumberParseException:
            continue
        if not phonenumbers.is_valid_number(parsed):
            continue
        formatted = phonenumbers.format_number(parsed, phonenumbers.PhoneNumberFormat.E164)
        seen.setdefault(formatted, None)
    return list(seen.keys())


def normalize_phone(candidate: str | None, region: str | None) -> str | None:
    """Single-value convenience wrapper for `businesses.phone` (the "best guess primary")."""
    if candidate is None:
        return None
    normalized = normalize_phones([candidate], region)
    return normalized[0] if normalized else None
