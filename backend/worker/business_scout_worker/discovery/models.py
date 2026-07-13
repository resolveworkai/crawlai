"""Authored by: Mohit Singh

Not a DB row model (see models.py's docstring) — this is the normalized shape discovery
produces before persistence.py upserts it into `businesses`. Deliberately narrower than the
`businesses` table: only the columns Overpass can actually populate. Enrichment (Tier-1/2) and
Phase 4's opening_hours/phone/address parsing extend the row after this.
"""

from __future__ import annotations

from pydantic import BaseModel


class DiscoveredBusiness(BaseModel):
    osm_type: str  # "node" | "way" | "relation"
    osm_id: str
    name: str
    sub_name: str | None = None
    category: str | None = None
    tags: list[str] = []

    latitude: float
    longitude: float

    address_line1: str | None = None
    area: str | None = None
    city: str | None = None
    state: str | None = None
    country: str | None = None
    postal_code: str | None = None
    google_map_name: str | None = None

    website_url: str | None = None
    phone: str | None = None
    email: str | None = None

    raw_opening_hours: str | None = None
    """Raw OSM `opening_hours` syntax — structured weekday parsing is Phase 4, not this."""
