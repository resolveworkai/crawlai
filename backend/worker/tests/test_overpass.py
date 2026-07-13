"""Authored by: Mohit Singh"""

from __future__ import annotations

import json

import httpx
import pytest

from business_scout_worker.discovery.overpass import (
    build_overpass_query,
    discover,
    iter_tile_centers,
    resolve_tags,
)


def test_resolve_tags_known_type() -> None:
    assert resolve_tags("gym") == [("leisure", "fitness_centre"), ("sport", "fitness")]
    assert resolve_tags("Library") == [("amenity", "library")]


def test_resolve_tags_unknown_type_returns_empty() -> None:
    assert resolve_tags("yoga studio") == []


def test_build_query_known_type_uses_tag_filters() -> None:
    query = build_overpass_query("library", 52.52, 13.405, 5)
    assert 'nwr["amenity"="library"](around:5000,52.52,13.405);' in query
    assert "out center tags;" in query


def test_build_query_unknown_type_falls_back_to_name_search() -> None:
    query = build_overpass_query("yoga studio", 52.52, 13.405, 5)
    assert 'nwr["name"~"yoga studio",i](around:5000,52.52,13.405);' in query
    assert 'nwr["amenity"~"yoga studio",i]' in query


def test_build_query_radius_km_converts_to_meters() -> None:
    query = build_overpass_query("gym", 0, 0, 2.5)
    assert "around:2500" in query


def test_iter_tile_centers_small_radius_is_single_tile() -> None:
    tiles = iter_tile_centers(52.52, 13.405, 5)
    assert tiles == [(52.52, 13.405, 5)]


def test_iter_tile_centers_large_radius_produces_multiple_tiles() -> None:
    tiles = iter_tile_centers(52.52, 13.405, 60)
    assert len(tiles) > 1
    # every tile must be within radius + one tile-radius of the original center
    for lat, lng, _radius in tiles:
        assert abs(lat - 52.52) < 2
        assert abs(lng - 13.405) < 4


def _element(
    *,
    type_: str = "node",
    id_: int = 1,
    tags: dict[str, str],
    lat: float = 52.52,
    lon: float = 13.405,
) -> dict[str, object]:
    el: dict[str, object] = {"type": type_, "id": id_, "tags": tags}
    if type_ == "node":
        el["lat"] = lat
        el["lon"] = lon
    else:
        el["center"] = {"lat": lat, "lon": lon}
    return el


@pytest.mark.asyncio
async def test_discover_parses_elements_into_normalized_businesses() -> None:
    elements = [
        _element(
            id_=101,
            tags={
                "name": "FitZone Berlin",
                "leisure": "fitness_centre",
                "website": "https://fitzone.example",
                "phone": "+49 30 1234567",
                "email": "Info@FitZone.Example",
                "addr:housenumber": "12",
                "addr:street": "Hauptstrasse",
                "addr:city": "Berlin",
                "wheelchair": "yes",
                "payment:cash": "yes",
            },
        ),
        _element(id_=102, tags={}),  # no name -> should be skipped
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"elements": elements})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    results = await discover("gym", 52.52, 13.405, 5, client=client)
    await client.aclose()

    assert len(results) == 1
    biz = results[0]
    assert biz.name == "FitZone Berlin"
    assert biz.osm_type == "node"
    assert biz.osm_id == "101"
    assert biz.website_url == "https://fitzone.example"
    assert biz.email == "info@fitzone.example"  # lowercased
    assert biz.address_line1 == "12 Hauptstrasse"
    assert biz.city == "Berlin"
    assert "Wheelchair accessible" in biz.tags
    assert "Accepts Cash" in biz.tags


@pytest.mark.asyncio
async def test_discover_deduplicates_across_tiled_queries() -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        el = _element(id_=1, tags={"name": "Same Business", "amenity": "library"})
        return httpx.Response(200, json={"elements": [el]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    results = await discover("library", 52.52, 13.405, 60, client=client)  # forces tiling
    await client.aclose()

    assert call_count > 1  # confirms tiling actually issued multiple requests
    assert len(results) == 1  # but the duplicate element was deduped


@pytest.mark.asyncio
async def test_discover_survives_a_failed_tile() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("boom", request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    results = await discover("gym", 52.52, 13.405, 5, client=client)
    await client.aclose()

    assert results == []


def test_json_roundtrip_of_discovered_business() -> None:
    # Sanity check the pydantic model itself serializes cleanly (used by pipeline.py logging).
    from business_scout_worker.discovery.models import DiscoveredBusiness

    biz = DiscoveredBusiness(osm_type="node", osm_id="1", name="X", latitude=1.0, longitude=2.0)
    assert json.loads(biz.model_dump_json())["name"] == "X"
