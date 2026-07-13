"""Authored by: Mohit Singh

CI-gated live smoke tests — real Overpass API + real websites, no mocking. Excluded from the
default test run (see pyproject.toml's addopts) since it depends on external services being up
and can be slow/flaky by nature; run explicitly with `pytest -m live`. Assertions are
deliberately loose (structure/non-crash, not exact content) since real-world data changes.
"""

from __future__ import annotations

import pytest

from business_scout_worker.discovery.overpass import discover
from business_scout_worker.enrich.tier1 import enrich_website

pytestmark = pytest.mark.live


@pytest.mark.asyncio
async def test_discover_real_libraries_in_central_berlin() -> None:
    # Central Berlin, amenity=library, generous radius — real OSM data, expected non-empty.
    results = await discover("library", 52.5170, 13.3888, 5)

    assert len(results) > 0
    first = results[0]
    assert first.name != ""
    assert -90 <= first.latitude <= 90
    assert -180 <= first.longitude <= 180
    assert first.osm_type in ("node", "way", "relation")


@pytest.mark.asyncio
async def test_enrich_real_website_mozilla() -> None:
    # Wikipedia was tried first and rejects non-browser clients outright regardless of
    # User-Agent (verified live: 403 even with a descriptive UA) — not representative of the
    # small-business sites this crawler actually targets, so it's not used as a smoke target.
    result = await enrich_website("https://www.mozilla.org")

    assert result.website_title is not None
    assert len(result.website_title) > 0


@pytest.mark.asyncio
async def test_enrich_real_website_iana() -> None:
    # IANA's example.com/iana.org are the RFC 2606-reserved domains explicitly meant for this
    # kind of illustrative use — stable, no rate limiting concerns.
    result = await enrich_website("https://www.iana.org")

    assert result.website_title is not None
    assert len(result.website_title) > 0
