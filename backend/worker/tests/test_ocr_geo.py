"""Authored by: Mohit Singh

Unit tests for the radius-bounded search logic in capture.py: exact lat/lng extraction from a
real Maps place href, haversine distance, and the radius filter that decides whether a business
is captured at all. No Playwright/browser involved — these are pure functions over strings/floats.
"""

from __future__ import annotations

from business_scout_worker.ocr.capture import (
    DEFAULT_CELL_RADIUS_KM,
    MAX_GRID_CELLS,
    _dedupe_by_name_phone,
    _haversine_km,
    _outside_radius,
    _parse_latlng,
    _place_id_from_href,
    _zoom_for_radius_km,
    generate_grid_cells,
)
from business_scout_worker.ocr.models import CapturedItem, DomFields

# A real captured href (Fitness First Always GYM, Haldwani) — see the live diagnostic in session
# history. Coordinates: 29.2128606, 79.5239669.
REAL_HREF = (
    "https://www.google.com/maps/place/Fitness+First+Always+GYM/"
    "data=!4m7!3m6!1s0x39a084ce840b0317:0x8e9591575791594f!8m2!3d29.2128606!4d79.5239669"
    "!16s%2Fg%2F11f50vx810!19sChIJFwMLhM6EoDkRT1mRV1eRlY4?authuser=0&hl=en&rclk=1"
)


def test_parse_latlng_from_real_href() -> None:
    latlng = _parse_latlng(REAL_HREF)
    assert latlng is not None
    lat, lng = latlng
    assert lat == 29.2128606
    assert lng == 79.5239669


def test_parse_latlng_returns_none_without_coords() -> None:
    assert _parse_latlng("https://www.google.com/maps/place/No+Coords+Here") is None


def test_haversine_zero_distance_for_same_point() -> None:
    assert _haversine_km(29.21, 79.52, 29.21, 79.52) == 0.0


def test_haversine_known_distance() -> None:
    # Delhi (28.6139, 77.2090) to Mumbai (19.0760, 72.8777) is ~1150-1160 km great-circle.
    d = _haversine_km(28.6139, 77.2090, 19.0760, 72.8777)
    assert 1140 <= d <= 1170


def test_outside_radius_true_when_beyond_km() -> None:
    # Center at the href's own point, but with a radius small enough that a point ~1.15km away
    # (roughly 0.0104 deg lat) falls outside.
    center_lat, center_lng = 29.2128606, 79.5239669
    far_lat = center_lat + 0.0104  # ~1.15km north
    href = REAL_HREF.replace("!3d29.2128606!4d79.5239669", f"!3d{far_lat}!4d{center_lng}")
    outside, lat, lng, distance = _outside_radius(href, center_lat, center_lng, 0.5)
    assert outside is True
    assert lat == far_lat
    assert lng == center_lng
    assert distance is not None and distance > 0.5


def test_outside_radius_false_when_within_km() -> None:
    center_lat, center_lng = 29.2128606, 79.5239669
    outside, lat, lng, distance = _outside_radius(REAL_HREF, center_lat, center_lng, 5.0)
    assert outside is False
    assert lat == center_lat
    assert lng == center_lng
    assert distance == 0.0


def test_outside_radius_never_filters_without_center_or_radius() -> None:
    # No center/radius requested at all -> always passes, but lat/lng still returned (worth
    # persisting even when the job wasn't radius-bounded).
    outside, lat, lng, distance = _outside_radius(REAL_HREF, None, None, None)
    assert outside is False
    assert lat == 29.2128606
    assert lng == 79.5239669
    assert distance is None


def test_outside_radius_handles_href_with_no_coords() -> None:
    outside, lat, lng, distance = _outside_radius(
        "https://www.google.com/maps/place/X", 29.0, 79.0, 5.0
    )
    assert outside is False  # nothing to check against -> never excluded
    assert lat is None
    assert lng is None
    assert distance is None


def test_zoom_for_radius_within_valid_range() -> None:
    for radius in (0.5, 1, 5, 20, 50, 100):
        zoom = _zoom_for_radius_km(radius, 29.21)
        assert 3 <= zoom <= 20
    # A smaller radius should never produce a lower (more zoomed-out) zoom than a larger one.
    assert _zoom_for_radius_km(1, 29.21) >= _zoom_for_radius_km(50, 29.21)


def test_place_id_extracted_from_real_href() -> None:
    assert _place_id_from_href(REAL_HREF) == "0x39a084ce840b0317:0x8e9591575791594f"


def test_place_id_none_when_absent() -> None:
    assert _place_id_from_href("https://www.google.com/maps/place/X") is None


def test_grid_single_cell_when_radius_fits_one_cell() -> None:
    cells = generate_grid_cells(29.21, 79.52, 1.5, cell_radius_km=2.0)
    assert cells == [(29.21, 79.52, 1.5)]


def test_grid_tiles_when_radius_exceeds_one_cell() -> None:
    cells = generate_grid_cells(29.21, 79.52, 10.0, cell_radius_km=2.0)
    assert len(cells) > 1
    # Center cell is always included first.
    assert cells[0] == (29.21, 79.52, 2.0)
    # Every generated cell's center must be within the requested radius plus a half-cell margin
    # (the ring math can slightly overshoot at the boundary — see generate_grid_cells docstring).
    for lat, lng, r in cells:
        assert r == 2.0
        assert _haversine_km(29.21, 79.52, lat, lng) <= 10.0 + 2.0 * 0.5 + 0.01


def test_grid_widens_cells_to_stay_under_max_cell_count_for_huge_radius() -> None:
    # A radius this large at the default 2km cell would naively produce thousands of cells —
    # generate_grid_cells must widen the cell radius until the count fits MAX_GRID_CELLS.
    cells = generate_grid_cells(29.21, 79.52, 300.0, cell_radius_km=DEFAULT_CELL_RADIUS_KM)
    assert len(cells) <= MAX_GRID_CELLS
    # Widening only happens for huge radii — the returned cell radius must have actually grown
    # past the requested default to make that fit.
    assert cells[0][2] > DEFAULT_CELL_RADIUS_KM


def test_grid_covers_full_requested_radius() -> None:
    # There must be at least one cell whose center sits reasonably close to the true edge of the
    # requested radius — otherwise the grid stopped tiling before reaching the boundary.
    radius_km = 8.0
    cells = generate_grid_cells(29.21, 79.52, radius_km, cell_radius_km=DEFAULT_CELL_RADIUS_KM)
    max_dist = max(_haversine_km(29.21, 79.52, lat, lng) for lat, lng, _ in cells)
    assert max_dist >= radius_km - DEFAULT_CELL_RADIUS_KM


def _item(name: str, phone: str | None, lat: float | None, lng: float | None) -> CapturedItem:
    return CapturedItem(index=1, name=name, dom=DomFields(phone=phone), lat=lat, lng=lng)


def test_dedupe_keeps_distinct_businesses() -> None:
    items = [
        _item("Gold's Gym", "+971500000001", 29.21, 79.52),
        _item("Fitness First", "+971500000002", 29.22, 79.53),
    ]
    assert len(_dedupe_by_name_phone(items)) == 2


def test_dedupe_removes_exact_phone_match() -> None:
    items = [
        _item("Gold's Gym Al Nahda", "+971500000001", 29.21, 79.52),
        _item("Gold's Gym", "+971500000001", 29.9, 80.1),  # far away, same phone -> still a dup
    ]
    deduped = _dedupe_by_name_phone(items)
    assert len(deduped) == 1
    assert deduped[0].name == "Gold's Gym Al Nahda"  # first one wins


def test_dedupe_removes_close_fuzzy_name_match_near_each_other() -> None:
    items = [
        _item("Gold's Gym - Al Nahda Branch", None, 29.2100, 79.5200),
        _item("Golds Gym Al Nahda Branch", None, 29.2101, 79.5201),  # ~15m away, near-identical
    ]
    assert len(_dedupe_by_name_phone(items)) == 1


def test_dedupe_keeps_same_chain_name_in_different_locations() -> None:
    # Two branches of the same chain, far apart, no phone captured for either -> must NOT merge.
    items = [
        _item("GymNation", None, 29.21, 79.52),
        _item("GymNation", None, 25.20, 55.27),  # a different city entirely
    ]
    assert len(_dedupe_by_name_phone(items)) == 2
