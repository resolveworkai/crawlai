"""Authored by: Mohit Singh

Unit test for the segment overlap-merge (ocr_engine.merge_segments) with Tesseract mocked — the
deterministic stitching logic (drop the ~20% overlap between consecutive segments) is what could
silently double lines, so it's tested directly rather than only through a live OCR run.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from business_scout_worker.ocr import ocr_engine
from business_scout_worker.ocr.ocr_engine import OcrLine


def test_merge_drops_overlapping_leading_lines(monkeypatch: pytest.MonkeyPatch) -> None:
    # Segment 1 ends with lines that segment 2 repeats at its top (the deliberate overlap).
    seg1 = [OcrLine("Name Gym", 95), OcrLine("4.9 (140)", 92), OcrLine("Gym", 90)]
    seg2 = [OcrLine("Gym", 90), OcrLine("Onyx Tower, Dubai", 88), OcrLine("+971 58 531 5770", 91)]

    def fake_ocr_segment(path: str, langs: str, tesseract_cmd: str | None = None) -> list[OcrLine]:
        return seg1 if path.endswith("p1.png") else seg2

    monkeypatch.setattr(ocr_engine, "ocr_segment", fake_ocr_segment)

    result = ocr_engine.merge_segments(["raw/1_p1.png", "raw/1_p2.png"], Path("/tmp/job"), "eng")
    texts = [line.text for line in result.lines]

    # "Gym" appeared at the end of seg1 and start of seg2 — it must appear exactly once.
    assert texts.count("Gym") == 1
    assert texts == ["Name Gym", "4.9 (140)", "Gym", "Onyx Tower, Dubai", "+971 58 531 5770"]
    assert "Onyx Tower, Dubai" in result.raw_text


def test_merge_single_segment_passthrough(monkeypatch: pytest.MonkeyPatch) -> None:
    seg = [OcrLine("Solo Place", 90), OcrLine("5.0 (3)", 88)]
    monkeypatch.setattr(ocr_engine, "ocr_segment", lambda *_a, **_kw: seg)
    result = ocr_engine.merge_segments(["raw/1_p1.png"], Path("/tmp/job"), "eng")
    assert [line.text for line in result.lines] == ["Solo Place", "5.0 (3)"]


def test_merge_empty_yields_zero_confidence() -> None:
    result = ocr_engine.merge_segments([], Path("/tmp/job"), "eng")
    assert result.lines == []
    assert result.mean_confidence == 0.0
