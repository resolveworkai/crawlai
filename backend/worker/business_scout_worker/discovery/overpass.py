"""Authored by: Mohit Singh

OpenStreetMap / Overpass discovery — free, no API key. See
md/plans/0001-business-scout-ai-crawler.md "P2 Discovery" and the Coverage matrix (req: pin +
configurable radius). `crawl_jobs.business_type` is free text (no enum on the Node side), so
this module resolves it against a curated tag map first, falling back to a regex search over
common category keys for anything unrecognized (flagged: weak coverage for niche categories
like "coaching centre" — no single OSM tag captures that well; see the plan's Phase 3 note).
"""

from __future__ import annotations

import math
from typing import Any

import httpx
from tenacity import retry, retry_if_exception_type, stop_after_attempt, wait_exponential

from business_scout_worker.discovery.models import DiscoveredBusiness

OVERPASS_URL_DEFAULT = "https://overpass-api.de/api/interpreter"
REQUEST_TIMEOUT_SECONDS = 60.0

# key -> None means "key exists, any value" (Overpass `["key"]`); key -> "value" means an exact
# match (Overpass `["key"="value"]`). Curated from OSM's tagging conventions for the business
# types named in the plan (gym/library/coaching) plus a handful of common storefront types.
BUSINESS_TYPE_TAG_MAP: dict[str, list[tuple[str, str | None]]] = {
    "gym": [("leisure", "fitness_centre"), ("sport", "fitness")],
    "fitness": [("leisure", "fitness_centre"), ("sport", "fitness")],
    "fitness centre": [("leisure", "fitness_centre")],
    "fitness center": [("leisure", "fitness_centre")],
    "library": [("amenity", "library")],
    # Coaching/tuition has no dedicated OSM tag — training + educational-institution office is
    # the closest approximation and will under-recall. Documented limitation, not a bug.
    "coaching": [("amenity", "training"), ("office", "educational_institution")],
    "coaching centre": [("amenity", "training"), ("office", "educational_institution")],
    "tuition": [("amenity", "training"), ("office", "educational_institution")],
    "cafe": [("amenity", "cafe")],
    "coffee": [("amenity", "cafe"), ("shop", "coffee")],
    "restaurant": [("amenity", "restaurant")],
    "dental": [("amenity", "dentist")],
    "dentist": [("amenity", "dentist")],
    "retail": [("shop", None)],
    "pharmacy": [("amenity", "pharmacy")],
    "salon": [("shop", "hairdresser"), ("shop", "beauty")],
}

# Free-text fallback: search these keys' *values* (not the whole element) for the term, plus a
# name search — catches things like "yoga studio" or "co-working" that aren't in the curated map.
FALLBACK_SEARCH_KEYS = ("amenity", "shop", "leisure", "office", "craft")

# Overpass has practical response-size/timeout limits on very large `around:` radii — split
# into a grid of smaller sub-circles above this threshold and dedupe results by (type, id).
TILE_THRESHOLD_KM = 25.0
TILE_RADIUS_KM = 15.0
EARTH_RADIUS_KM = 6371.0


def resolve_tags(business_type: str) -> list[tuple[str, str | None]]:
    key = business_type.strip().lower()
    return BUSINESS_TYPE_TAG_MAP.get(key, [])


def _tag_filter(key: str, value: str | None) -> str:
    return f'["{key}"]' if value is None else f'["{key}"="{value}"]'


def _build_query_block(business_type: str, lat: float, lng: float, radius_m: int) -> str:
    tags = resolve_tags(business_type)
    around = f"(around:{radius_m},{lat},{lng})"

    if tags:
        clauses = [f"nwr{_tag_filter(k, v)}{around};" for k, v in tags]
    else:
        term = business_type.strip()
        clauses = [f'nwr["name"~"{term}",i]{around};']
        clauses += [f'nwr["{key}"~"{term}",i]{around};' for key in FALLBACK_SEARCH_KEYS]

    return "\n  ".join(clauses)


def build_overpass_query(business_type: str, lat: float, lng: float, radius_km: float) -> str:
    """Single, non-tiled QL block. Tiling (for large radii) is handled by
    `iter_tile_centers`, which calls this once per tile and merges results."""
    radius_m = max(1, round(radius_km * 1000))
    block = _build_query_block(business_type, lat, lng, radius_m)
    timeout = int(REQUEST_TIMEOUT_SECONDS)
    return f"[out:json][timeout:{timeout}];\n(\n  {block}\n);\nout center tags;"


def iter_tile_centers(lat: float, lng: float, radius_km: float) -> list[tuple[float, float, float]]:
    """Returns [(tile_lat, tile_lng, tile_radius_km), ...] covering the requested area. Below
    TILE_THRESHOLD_KM this is just the single original circle — tiling only kicks in for
    radii Overpass would otherwise choke on (see module docstring)."""
    if radius_km <= TILE_THRESHOLD_KM:
        return [(lat, lng, radius_km)]

    tiles: list[tuple[float, float, float]] = []
    step_km = TILE_RADIUS_KM * 1.4  # slight overlap so no gaps between adjacent tile circles
    n = math.ceil(radius_km / step_km)
    lat_rad = math.radians(lat)

    for i in range(-n, n + 1):
        for j in range(-n, n + 1):
            dy_km = i * step_km
            dx_km = j * step_km
            if math.hypot(dx_km, dy_km) > radius_km + TILE_RADIUS_KM:
                continue
            tile_lat = lat + (dy_km / EARTH_RADIUS_KM) * (180 / math.pi)
            tile_lng = lng + (dx_km / (EARTH_RADIUS_KM * math.cos(lat_rad))) * (180 / math.pi)
            tiles.append((tile_lat, tile_lng, TILE_RADIUS_KM))
    return tiles


def _first(tags: dict[str, str], *keys: str) -> str | None:
    for key in keys:
        value = tags.get(key)
        if value:
            return value
    return None


# Tags surfaced as human-readable "About" chips (req #8 — OSM tags, not Google's exact chips;
# see the plan's coverage matrix). Deliberately curated, not "dump every tag" (most OSM tags are
# noise for an end user).
ABOUT_TAG_LABELS: dict[str, dict[str, str]] = {
    "wheelchair": {"yes": "Wheelchair accessible", "limited": "Limited wheelchair access"},
    "internet_access": {"wlan": "Wi-Fi", "yes": "Internet access"},
    "outdoor_seating": {"yes": "Outdoor seating"},
    "delivery": {"yes": "Delivery available"},
    "takeaway": {"yes": "Takeaway"},
    "air_conditioning": {"yes": "Air conditioned"},
}
ABOUT_TAG_PAYMENT_PREFIX = "payment:"


def _about_tags(tags: dict[str, str]) -> list[str]:
    labels: list[str] = []
    for key, value_map in ABOUT_TAG_LABELS.items():
        label = value_map.get(tags.get(key, ""))
        if label:
            labels.append(label)
    for key, value in tags.items():
        if key.startswith(ABOUT_TAG_PAYMENT_PREFIX) and value == "yes":
            method = key[len(ABOUT_TAG_PAYMENT_PREFIX) :].replace("_", " ").title()
            labels.append(f"Accepts {method}")
    if tags.get("sport"):
        labels.append(tags["sport"].replace("_", " ").title())
    return labels


def _element_to_business(el: dict[str, Any]) -> DiscoveredBusiness | None:
    tags: dict[str, str] = el.get("tags") or {}
    name = tags.get("name")
    if not name:
        return None  # unnamed elements aren't useful leads — skip, don't fabricate a name

    if el["type"] == "node":
        lat, lng = el.get("lat"), el.get("lon")
    else:
        center = el.get("center") or {}
        lat, lng = center.get("lat"), center.get("lon")
    if lat is None or lng is None:
        return None

    website = _first(tags, "website", "contact:website")
    phone = _first(tags, "phone", "contact:phone")
    email = _first(tags, "email", "contact:email")
    category = next(
        (v for k in ("amenity", "leisure", "shop", "office") if (v := tags.get(k))), None
    )

    return DiscoveredBusiness(
        osm_type=el["type"],
        osm_id=str(el["id"]),
        name=name,
        sub_name=_first(tags, "alt_name", "brand", "operator"),
        category=category.replace("_", " ").title() if category else None,
        tags=_about_tags(tags),
        latitude=float(lat),
        longitude=float(lng),
        address_line1=(
            f"{tags['addr:housenumber']} {tags['addr:street']}"
            if tags.get("addr:housenumber") and tags.get("addr:street")
            else tags.get("addr:street")
        ),
        area=tags.get("addr:suburb"),
        city=tags.get("addr:city"),
        state=tags.get("addr:state"),
        country=tags.get("addr:country"),
        postal_code=tags.get("addr:postcode"),
        google_map_name=name,
        website_url=website,
        phone=phone,
        email=email.lower() if email else None,
        raw_opening_hours=tags.get("opening_hours"),
    )


@retry(
    retry=retry_if_exception_type((httpx.TransportError, httpx.HTTPStatusError)),
    stop=stop_after_attempt(3),
    wait=wait_exponential(multiplier=1, min=2, max=20),
    reraise=True,
)
async def _run_query(
    client: httpx.AsyncClient, overpass_url: str, query: str
) -> list[dict[str, Any]]:
    # Overpass's documented interface expects the QL as a form field named "data" (verified
    # live — a raw POST body intermittently 406s/504s; form-encoded is what the real API wants).
    resp = await client.post(overpass_url, data={"data": query}, timeout=REQUEST_TIMEOUT_SECONDS)
    resp.raise_for_status()
    data = resp.json()
    return list(data.get("elements", []))


async def discover(
    business_type: str,
    lat: float,
    lng: float,
    radius_km: float,
    *,
    overpass_url: str = OVERPASS_URL_DEFAULT,
    client: httpx.AsyncClient | None = None,
) -> list[DiscoveredBusiness]:
    """Runs one or more Overpass queries (tiled for large radii) and returns deduped,
    normalized results. Never raises on a single tile failure after retries are exhausted —
    logs are the caller's job (see pipeline.py); a partial result set is still useful."""
    owns_client = client is None
    # A descriptive User-Agent is required — verified live: overpass-api.de's front end
    # returns a bare 406 to requests without one, same reasoning as geocode.ts's Nominatim
    # client and tier1.py's website fetches.
    client = client or httpx.AsyncClient(headers={"User-Agent": "business-scout-ai/0.1"})
    seen: dict[tuple[str, str], DiscoveredBusiness] = {}

    try:
        for tile_lat, tile_lng, tile_radius_km in iter_tile_centers(lat, lng, radius_km):
            query = build_overpass_query(business_type, tile_lat, tile_lng, tile_radius_km)
            try:
                elements = await _run_query(client, overpass_url, query)
            except (httpx.TransportError, httpx.HTTPStatusError):
                continue
            for el in elements:
                biz = _element_to_business(el)
                if biz is None:
                    continue
                seen[(biz.osm_type, biz.osm_id)] = biz
    finally:
        if owns_client:
            await client.aclose()

    return list(seen.values())
