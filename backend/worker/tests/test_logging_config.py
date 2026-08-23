"""Authored by: Mohit Singh

Regression test for a real bug (2026-08-23): on Windows, without PYTHONIOENCODING=utf-8 set by
whoever launches the process, sys.stdout defaults to the console's codepage — which can't encode
Arabic (or any non-Latin-1) text. A real property job's own location string ("أم نهد 4/مدينة هند
4") crashed the entire host-runner watch cycle the moment it tried to log "property job claimed",
which orphan-recovery then reported as the misleading "Interrupted by a runner restart". This
proves configure_logging() makes logging non-ASCII text safe regardless of the stream's original
encoding, without needing a real Windows console or PYTHONIOENCODING set in the test environment.
"""

from __future__ import annotations

import io
import sys

import pytest

from business_scout_worker.logging_config import configure_logging, get_logger
from business_scout_worker.settings import load_settings


def test_configure_logging_makes_non_ascii_logging_safe(monkeypatch: pytest.MonkeyPatch) -> None:
    # A stream whose encoding can't represent Arabic — reproduces the real Windows cp1252 console
    # failure mode without needing an actual Windows console.
    narrow_stream = io.TextIOWrapper(io.BytesIO(), encoding="cp1252", errors="strict")
    monkeypatch.setattr(sys, "stdout", narrow_stream)

    configure_logging(load_settings())
    logger = get_logger("test")
    # Must not raise — this is exactly the "أم نهد 4/مدينة هند 4" location string that crashed
    # the real watch cycle before this fix.
    logger.info("property job claimed", location="أم نهد 4/مدينة هند 4")
