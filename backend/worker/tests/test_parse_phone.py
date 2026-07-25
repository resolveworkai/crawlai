"""Authored by: Mohit Singh"""

from __future__ import annotations

from business_scout_worker.parse.phone import normalize_phone, normalize_phones


def test_normalize_phones_formats_to_e164() -> None:
    result = normalize_phones(["+49 30 1234567"], None)
    assert result == ["+49301234567"]


def test_normalize_phones_uses_region_for_local_format() -> None:
    # A German national-format number has no chance of parsing correctly without the region.
    result = normalize_phones(["030 1234567"], "DE")
    assert result == ["+49301234567"]


def test_normalize_phones_drops_unparseable_garbage() -> None:
    result = normalize_phones(["not a phone", "12", "+1"], "DE")
    assert result == []


def test_normalize_phones_dedupes_equivalent_formats() -> None:
    result = normalize_phones(["+49 30 1234567", "+493012345 67", "0049301234567"], None)
    assert result == ["+49301234567"]


def test_normalize_phones_without_region_still_handles_international_form() -> None:
    result = normalize_phones(["+1 415 555 0132"], None)
    assert result == ["+14155550132"]


def test_normalize_phone_single_value_wrapper() -> None:
    assert normalize_phone("+49 30 1234567", None) == "+49301234567"
    assert normalize_phone(None, None) is None
    assert normalize_phone("garbage", "DE") is None
