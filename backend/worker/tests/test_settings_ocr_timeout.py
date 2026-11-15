"""Authored by: Mohit Singh

The OCR per-business ceiling was a hard-coded 30s that discarded ~80% of businesses on a loaded
machine (each needs ~40-45s). It is now a setting with a 90s default, overridable from the env.
"""

from __future__ import annotations

import pytest

from business_scout_worker.settings import Settings


def test_default_ceiling_is_roomy_enough_for_a_slow_machine() -> None:
    # 40-45s of real work per business was measured under load; 30s abandoned most of them.
    assert Settings(database_url="postgresql://x/y").ocr_business_timeout_s == 90.0


def test_ceiling_can_be_overridden_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OCR_BUSINESS_TIMEOUT_S", "150")
    assert Settings(database_url="postgresql://x/y").ocr_business_timeout_s == 150.0


def test_a_zero_or_negative_ceiling_is_rejected() -> None:
    with pytest.raises(ValueError):
        Settings(database_url="postgresql://x/y", ocr_business_timeout_s=0)
