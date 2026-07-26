"""Authored by: Mohit Singh

Unit tests for the resumable-retry logic in capture.py: seeding `items`/`seen` from a prior
attempt's captured items (so the walk skips them instead of re-navigating), and the incremental
manifest checkpoint writer. No Playwright/browser involved — pure functions + a temp file.
"""

from __future__ import annotations

import json
from pathlib import Path

from business_scout_worker.ocr.capture import _seed_from_resume, _write_manifest_checkpoint
from business_scout_worker.ocr.models import CapturedItem, DomFields

REAL_HREF = (
    "https://www.google.com/maps/place/Fitness+First+Always+GYM/"
    "data=!4m7!3m6!1s0x39a084ce840b0317:0x8e9591575791594f!8m2!3d29.2128606!4d79.5239669"
)


def _item(index: int, name: str, href: str | None = REAL_HREF) -> CapturedItem:
    return CapturedItem(index=index, name=name, maps_url=href, images=[], dom=DomFields())


def test_seed_from_resume_returns_empty_for_no_prior_items() -> None:
    items, seen = _seed_from_resume(None)
    assert items == []
    assert seen == {}


def test_seed_from_resume_preserves_prior_items_and_keys_seen_by_place_id() -> None:
    prior = [_item(1, "Fitness First Always GYM")]
    items, seen = _seed_from_resume(prior)
    assert items == prior
    # Keyed by the place id extracted from the href, exactly like the live walk loop's `seen`
    # dict — so a resumed walk recognizes this business the same way a fresh one would.
    assert "0x39a084ce840b0317:0x8e9591575791594f" in seen
    assert seen["0x39a084ce840b0317:0x8e9591575791594f"] == "Fitness First Always GYM"


def test_seed_from_resume_falls_back_to_href_then_name_without_a_place_id() -> None:
    items, seen = _seed_from_resume([_item(1, "No Place Id Biz", href="https://maps/x")])
    assert "https://maps/x" in seen
    items2, seen2 = _seed_from_resume([_item(1, "No Href At All", href=None)])
    assert "No Href At All" in seen2
    assert items2[0].maps_url is None


def test_write_manifest_checkpoint_is_readable_and_reflects_items(tmp_path: Path) -> None:
    items = [_item(1, "A"), _item(2, "B", href="https://maps/b")]
    _write_manifest_checkpoint(tmp_path, "job-1", "gym", "Dubai", "2026-01-01T00:00:00Z", items)
    written = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    assert written["job_id"] == "job-1"
    assert len(written["items"]) == 2
    assert written["items"][0]["name"] == "A"
    assert written["items"][1]["name"] == "B"


def test_write_manifest_checkpoint_overwrites_on_each_call(tmp_path: Path) -> None:
    _write_manifest_checkpoint(tmp_path, "job-1", "gym", "Dubai", "t", [_item(1, "A")])
    _write_manifest_checkpoint(
        tmp_path, "job-1", "gym", "Dubai", "t", [_item(1, "A"), _item(2, "B")]
    )
    written = json.loads((tmp_path / "manifest.json").read_text("utf-8"))
    assert len(written["items"]) == 2
