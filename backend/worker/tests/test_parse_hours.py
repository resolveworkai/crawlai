"""Authored by: Mohit Singh"""

from __future__ import annotations

from business_scout_worker.parse.hours import parse_opening_hours


def test_parse_simple_weekday_range() -> None:
    result = parse_opening_hours("Mo-Fr 08:00-18:00")
    assert result is not None
    assert result["monday"] == [{"open": "08:00", "close": "18:00"}]
    assert result["friday"] == [{"open": "08:00", "close": "18:00"}]
    assert result["saturday"] == []
    assert result["sunday"] == []


def test_parse_multiple_rules_separated_by_semicolon() -> None:
    result = parse_opening_hours("Mo-Fr 08:00-18:00; Sa 09:00-14:00")
    assert result is not None
    assert result["saturday"] == [{"open": "09:00", "close": "14:00"}]
    assert result["sunday"] == []


def test_parse_comma_separated_day_list() -> None:
    result = parse_opening_hours("Mo,We,Fr 10:00-16:00")
    assert result is not None
    assert result["monday"] == [{"open": "10:00", "close": "16:00"}]
    assert result["wednesday"] == [{"open": "10:00", "close": "16:00"}]
    assert result["friday"] == [{"open": "10:00", "close": "16:00"}]
    assert result["tuesday"] == []


def test_parse_multiple_time_ranges_same_day() -> None:
    result = parse_opening_hours("Mo 08:00-12:00,13:00-18:00")
    assert result is not None
    assert result["monday"] == [
        {"open": "08:00", "close": "12:00"},
        {"open": "13:00", "close": "18:00"},
    ]


def test_parse_off_marks_day_closed() -> None:
    result = parse_opening_hours("Mo-Su 09:00-17:00; Su off")
    assert result is not None
    assert result["sunday"] == []
    assert result["saturday"] == [{"open": "09:00", "close": "17:00"}]


def test_parse_wrapping_day_range() -> None:
    result = parse_opening_hours("Sa-Su 10:00-14:00")
    assert result is not None
    assert result["saturday"] == [{"open": "10:00", "close": "14:00"}]
    assert result["sunday"] == [{"open": "10:00", "close": "14:00"}]
    assert result["monday"] == []


def test_parse_returns_none_for_empty_or_missing() -> None:
    assert parse_opening_hours(None) is None
    assert parse_opening_hours("") is None
    assert parse_opening_hours("   ") is None


def test_parse_returns_none_for_unsupported_syntax() -> None:
    # PH (public holidays) and free-text comments aren't in the supported subset — must not
    # guess at a wrong result, per the module's "never partial/best-guess" contract.
    assert parse_opening_hours("Mo-Fr 08:00-18:00; PH off") is None
    assert parse_opening_hours("sunrise-sunset") is None
    assert parse_opening_hours("24/7") is None
