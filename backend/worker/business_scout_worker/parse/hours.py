"""Authored by: Mohit Singh

Parses OSM's `opening_hours` tag syntax into the weekday-keyed JSONB shape `businesses
.opening_hours` expects (req #10). OSM's full opening_hours spec is a real grammar (comments,
public holidays, seasons, "sunrise"/"sunset", exceptions...) — this is deliberately a
**best-effort parser for the common subset** (day ranges/lists + HH:MM-HH:MM time ranges,
comma-separated, semicolon-separated rules, "off"/"closed"). A rule this parser can't confidently
handle is skipped, not guessed at — a business with unparsed hours just keeps `opening_hours=NULL`
rather than storing wrong data. See md/plans/0001-*.md Phase 4.
"""

from __future__ import annotations

import re
from typing import TypedDict

WEEKDAY_KEYS = (
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
)

_DAY_ABBREVS = {
    "Mo": "monday",
    "Tu": "tuesday",
    "We": "wednesday",
    "Th": "thursday",
    "Fr": "friday",
    "Sa": "saturday",
    "Su": "sunday",
}
_DAY_ORDER = list(_DAY_ABBREVS.keys())

_TIME_RANGE_RE = re.compile(r"^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$")
_OFF_VALUES = {"off", "closed"}


class TimeRange(TypedDict):
    open: str
    close: str


OpeningHours = dict[str, list[TimeRange]]


def _expand_day_spec(day_spec: str) -> list[str] | None:
    """ "Mo-Fr" -> [Mo,Tu,We,Th,Fr]; "Mo,We,Fr" -> [Mo,We,Fr]; "Sa-Su" wraps correctly. Returns
    None if any token isn't a recognized 2-letter day abbreviation (unsupported construct)."""
    days: list[str] = []
    for part in day_spec.split(","):
        part = part.strip()
        if "-" in part:
            start, end = part.split("-", 1)
            if start not in _DAY_ABBREVS or end not in _DAY_ABBREVS:
                return None
            start_i, end_i = _DAY_ORDER.index(start), _DAY_ORDER.index(end)
            if end_i >= start_i:
                days.extend(_DAY_ORDER[start_i : end_i + 1])
            else:  # wraps, e.g. Sa-Su is fine, but a genuine wrap like Fr-Mo
                days.extend(_DAY_ORDER[start_i:] + _DAY_ORDER[: end_i + 1])
        else:
            if part not in _DAY_ABBREVS:
                return None
            days.append(part)
    return days


def _parse_time_ranges(time_spec: str) -> list[TimeRange] | None:
    if time_spec.strip().lower() in _OFF_VALUES:
        return []
    ranges: list[TimeRange] = []
    for part in time_spec.split(","):
        match = _TIME_RANGE_RE.match(part.strip())
        if match is None:
            return None
        ranges.append({"open": match.group(1), "close": match.group(2)})
    return ranges


def parse_opening_hours(raw: str | None) -> OpeningHours | None:
    """Returns a dict keyed by every weekday (empty list = closed that day) if the whole raw
    string parsed cleanly, else None (never a partial/best-guess result — see module docstring).
    """
    if not raw or not raw.strip():
        return None

    result: OpeningHours = {key: [] for key in WEEKDAY_KEYS}
    seen_any = False

    for rule in raw.split(";"):
        rule = rule.strip()
        if not rule:
            continue
        tokens = rule.split(None, 1)
        if len(tokens) != 2:
            return None
        day_spec, time_spec = tokens

        day_abbrevs = _expand_day_spec(day_spec)
        if day_abbrevs is None:
            return None
        time_ranges = _parse_time_ranges(time_spec)
        if time_ranges is None:
            return None

        for abbrev in day_abbrevs:
            result[_DAY_ABBREVS[abbrev]] = time_ranges
        seen_any = True

    return result if seen_any else None
