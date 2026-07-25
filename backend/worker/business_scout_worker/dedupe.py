"""Authored by: Mohit Singh

Dedupe + upsert — see md/plans/0001-*.md "P5 Dedup". Three keys, in order of confidence:
  - EXACT PRIMARY: (osm_type, osm_id) — a real Postgres UNIQUE index. Overpass discovery
    upserts against this.
  - EXACT SECONDARY (override): lower(email) — also a real UNIQUE index. Tier-1 enrichment can
    discover the same real-world business under a second OSM element (a common node-vs-way
    duplication); when that business's email matches an already-known row, the match wins and
    enrichment is applied to the existing row instead of violating the unique index or
    silently losing data.
  - FUZZY (Phase 4): name+address similarity within a small geo radius — catches the same
    node-vs-way duplication when the two OSM elements DON'T share an email (most don't). Not a
    DB constraint — computed in Python via rapidfuzz, then soft-merged (see
    `merge_fuzzy_duplicate_if_found` / `merged_into_id`).
"""

from __future__ import annotations

import math
from typing import Any, cast
from uuid import UUID

import psycopg
from psycopg.types.json import Jsonb
from psycopg_pool import AsyncConnectionPool
from rapidfuzz import fuzz

from business_scout_worker.discovery.models import DiscoveredBusiness
from business_scout_worker.enrich.models import Tier1Result
from business_scout_worker.parse.hours import parse_opening_hours
from business_scout_worker.parse.phone import normalize_phone

FUZZY_MATCH_RADIUS_METERS = 150
FUZZY_NAME_SIMILARITY_THRESHOLD = 88.0
"""rapidfuzz token_sort_ratio (0-100) — high enough to avoid merging genuinely different
businesses that happen to share a generic name fragment (e.g. two different "City Library"
branches), since the geo radius alone isn't discriminating enough for common name patterns."""
_METERS_PER_DEGREE_LAT = 111_320

FRESHNESS_HOURS = 24
"""A business updated within this window is skipped by a re-crawl's enrichment step — see
`is_enrichment_stale` and md/plans/0001-*.md's "idempotent re-crawl skips recently-updated
rows" requirement. Discovery's identity-field upsert always runs regardless (cheap, no
network calls)."""


async def upsert_discovered(
    pool: AsyncConnectionPool, job_id: UUID, discovered: DiscoveredBusiness
) -> UUID:
    """Insert-or-refresh the identity/address/map fields for a discovered element. Never
    touches contact fields (email/phone/website/enrichment_status) — that's
    `apply_enrichment`'s job, run later in the pipeline. Returns the business id (new or
    existing)."""
    opening_hours = parse_opening_hours(discovered.raw_opening_hours)

    async with pool.connection() as conn:
        cur = await conn.execute(
            """
            INSERT INTO businesses (
                crawl_job_id, name, sub_name, category, tags,
                google_map_name, osm_type, osm_id, latitude, longitude,
                address_line1, area, city, state, country, postal_code, opening_hours
            ) VALUES (
                %(crawl_job_id)s, %(name)s, %(sub_name)s, %(category)s, %(tags)s,
                %(google_map_name)s, %(osm_type)s, %(osm_id)s, %(latitude)s, %(longitude)s,
                %(address_line1)s, %(area)s, %(city)s, %(state)s, %(country)s, %(postal_code)s,
                %(opening_hours)s
            )
            ON CONFLICT (osm_type, osm_id) WHERE osm_id IS NOT NULL DO UPDATE SET
                crawl_job_id = EXCLUDED.crawl_job_id,
                name = EXCLUDED.name,
                sub_name = EXCLUDED.sub_name,
                category = EXCLUDED.category,
                tags = EXCLUDED.tags,
                google_map_name = EXCLUDED.google_map_name,
                latitude = EXCLUDED.latitude,
                longitude = EXCLUDED.longitude,
                address_line1 = EXCLUDED.address_line1,
                area = EXCLUDED.area,
                city = EXCLUDED.city,
                state = EXCLUDED.state,
                country = EXCLUDED.country,
                postal_code = EXCLUDED.postal_code,
                opening_hours = EXCLUDED.opening_hours
            RETURNING id
            """,
            {
                "crawl_job_id": str(job_id),
                "name": discovered.name,
                "sub_name": discovered.sub_name,
                "category": discovered.category,
                "tags": discovered.tags or None,
                "google_map_name": discovered.google_map_name,
                "osm_type": discovered.osm_type,
                "osm_id": discovered.osm_id,
                "latitude": discovered.latitude,
                "longitude": discovered.longitude,
                "address_line1": discovered.address_line1,
                "area": discovered.area,
                "city": discovered.city,
                "state": discovered.state,
                "country": discovered.country,
                "postal_code": discovered.postal_code,
                "opening_hours": Jsonb(opening_hours) if opening_hours is not None else None,
            },
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())
        if row is None:
            raise RuntimeError("upsert_discovered: INSERT ... RETURNING id yielded no row")
        business_id = UUID(str(row["id"]))

    normalized_phone = normalize_phone(discovered.phone, discovered.country)
    if discovered.website_url or normalized_phone or discovered.email:
        await _set_fields_tolerating_email_conflict(
            pool,
            business_id,
            {
                "website_url": discovered.website_url,
                "phone": normalized_phone,
                "email": discovered.email.lower() if discovered.email else None,
            },
        )
    return business_id


async def needs_enrichment(pool: AsyncConnectionPool, business_id: UUID) -> bool:
    """False when the row was already enriched within FRESHNESS_HOURS — the idempotent
    re-crawl skip. A 'failed' row is always retried regardless of age."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            """
            SELECT enrichment_status = 'enriched'
                   AND updated_at > now() - (%(hours)s || ' hours')::interval AS is_fresh
            FROM businesses WHERE id = %(id)s
            """,
            {"hours": FRESHNESS_HOURS, "id": str(business_id)},
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())
    is_fresh = bool(row["is_fresh"]) if row else False
    return not is_fresh


async def mark_enrichment_status(pool: AsyncConnectionPool, business_id: UUID, status: str) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE businesses SET enrichment_status = %s WHERE id = %s",
            (status, str(business_id)),
        )


async def apply_enrichment(
    pool: AsyncConnectionPool,
    business_id: UUID,
    website_url: str | None,
    result: Tier1Result,
    *,
    region: str | None = None,
) -> None:
    """Writes Tier-1 results onto the row and flips enrichment_status='enriched'. The primary
    `email`/`phone` columns get the first extracted value (best-effort "most likely" contact) —
    `phone` additionally goes through `parse.phone.normalize_phone` (E.164) when `region` (the
    business's OSM country) is available. The full `phones` array stays as Tier-1's raw
    candidates, deliberately NOT normalized — req #4 wants ALL phones found on the page, and
    `phonenumbers` would silently drop ambiguous-without-locale numbers that are still real.
    Same reasoning for `emails` (req #4 — ALL emails, not just one)."""
    primary_email = result.emails[0] if result.emails else None
    primary_phone = normalize_phone(result.phones[0], region) if result.phones else None

    fields: dict[str, Any] = {
        "website_url": website_url,
        "website_title": result.website_title,
        "meta_description": result.meta_description,
        "meta_keywords": result.meta_keywords,
        "about_text": result.about_text,
        "contact_url": result.contact_url,
        "email": primary_email,
        "emails": result.emails or None,
        "phone": primary_phone,
        "phones": result.phones or None,
        "whatsapp": result.whatsapp,
        "facebook": result.facebook,
        "instagram": result.instagram,
        "linkedin": result.linkedin,
        "youtube": result.youtube,
        "twitter": result.twitter,
        "logo_url": result.logo_url,
        "hero_image_url": result.hero_image_url,
        "enrichment_status": "enriched",
        # Phase 8 observability — which tier actually supplied this data; drives the
        # tier-hit-ratio system metric (see backend/api/src/db/stats.ts getSystemHealth).
        "enrichment_tier": "tier2" if result.used_tier2 else "tier1",
    }
    await _set_fields_tolerating_email_conflict(pool, business_id, fields)

    if result.image_urls:
        await _replace_business_images(pool, business_id, result.image_urls)


async def mark_enrichment_failed(pool: AsyncConnectionPool, business_id: UUID) -> None:
    await mark_enrichment_status(pool, business_id, "failed")


async def apply_ai_extras(
    pool: AsyncConnectionPool, business_id: UUID, extras: dict[str, Any]
) -> None:
    """Merges `extras` into the row's existing `extras` JSONB (Phase 5) — `||` so re-running one
    dynamic field doesn't wipe values previously written by others. A `None` value is stored as
    JSON `null` (means "the LLM ran and found nothing"), distinct from the key being absent
    entirely (means "no field configured this key")."""
    if not extras:
        return
    async with pool.connection() as conn:
        await conn.execute(
            "UPDATE businesses SET extras = extras || %(extras)s::jsonb WHERE id = %(id)s",
            {"extras": Jsonb(extras), "id": str(business_id)},
        )


async def _set_fields_tolerating_email_conflict(
    pool: AsyncConnectionPool, business_id: UUID, fields: dict[str, Any]
) -> None:
    """UPDATEs `fields` on the row. If `email` collides with a different row's email (the
    secondary dedupe key), retries without setting email — the existing email-holder stays
    canonical for that field rather than the UPDATE failing outright. Every other field still
    lands on `business_id`'s own row (it may have a different osm_id/location worth keeping)."""
    try:
        await _run_update(pool, business_id, fields)
    except psycopg.errors.UniqueViolation as exc:
        if "ux_businesses_email" not in str(exc):
            raise
        retry_fields = {k: v for k, v in fields.items() if k != "email"}
        if retry_fields:
            await _run_update(pool, business_id, retry_fields)


async def _run_update(pool: AsyncConnectionPool, business_id: UUID, fields: dict[str, Any]) -> None:
    set_clause = ", ".join(f"{key} = %({key})s" for key in fields)
    async with pool.connection() as conn:
        await conn.execute(
            f"UPDATE businesses SET {set_clause} WHERE id = %(id)s",  # noqa: S608 - keys are our own fixed dict, never user input
            {**fields, "id": str(business_id)},
        )


async def _replace_business_images(
    pool: AsyncConnectionPool, business_id: UUID, urls: list[str]
) -> None:
    """Idempotent: clears and re-inserts rather than growing unbounded across re-crawls."""
    async with pool.connection() as conn:
        await conn.execute(
            "DELETE FROM business_images WHERE business_id = %s", (str(business_id),)
        )
        for url in urls:
            await conn.execute(
                "INSERT INTO business_images (business_id, kind, url) VALUES (%s, %s, %s)",
                (str(business_id), "website", url),
            )


async def merge_fuzzy_duplicate_if_found(
    pool: AsyncConnectionPool, business_id: UUID, name: str, latitude: float, longitude: float
) -> UUID:
    """Call right after `upsert_discovered`. If an existing, different, not-already-merged
    business within FUZZY_MATCH_RADIUS_METERS has a close-enough name match, merges the two
    (older row wins as canonical — see `_merge`) and returns the survivor's id for the caller
    to use for all further processing (enrichment, counters). Returns `business_id` unchanged
    if no fuzzy duplicate was found — the common case, and cheap (one small geo-bounded
    query)."""
    duplicate_id = await _find_fuzzy_duplicate(pool, business_id, name, latitude, longitude)
    if duplicate_id is None:
        return business_id
    return await _merge(pool, business_id, duplicate_id)


async def _find_fuzzy_duplicate(
    pool: AsyncConnectionPool, business_id: UUID, name: str, latitude: float, longitude: float
) -> UUID | None:
    # A crude but adequate meters->degrees box (not valid near the poles, irrelevant for real
    # businesses) to cheaply pre-filter candidates in SQL before the fuzzy string comparison,
    # which runs in Python since Postgres has no built-in fuzzy-name-match operator here.
    lat_delta = FUZZY_MATCH_RADIUS_METERS / _METERS_PER_DEGREE_LAT
    lng_delta = FUZZY_MATCH_RADIUS_METERS / (
        _METERS_PER_DEGREE_LAT * max(0.1, math.cos(math.radians(latitude)))
    )

    async with pool.connection() as conn:
        cur = await conn.execute(
            """
            SELECT id, name FROM businesses
            WHERE id != %(id)s
              AND merged_into_id IS NULL
              AND latitude BETWEEN %(lat_min)s AND %(lat_max)s
              AND longitude BETWEEN %(lng_min)s AND %(lng_max)s
            """,
            {
                "id": str(business_id),
                "lat_min": latitude - lat_delta,
                "lat_max": latitude + lat_delta,
                "lng_min": longitude - lng_delta,
                "lng_max": longitude + lng_delta,
            },
        )
        candidates = cast("list[dict[str, Any]]", await cur.fetchall())

    best_id: UUID | None = None
    best_score = 0.0
    for row in candidates:
        score = fuzz.token_sort_ratio(name, row["name"])
        if score >= FUZZY_NAME_SIMILARITY_THRESHOLD and score > best_score:
            best_score = score
            best_id = UUID(str(row["id"]))
    return best_id


_MERGE_COALESCE_COLUMNS = (
    "email",
    "emails",
    "phone",
    "phones",
    "website_url",
    "website_title",
    "meta_description",
    "meta_keywords",
    "about_text",
    "contact_url",
    "whatsapp",
    "facebook",
    "instagram",
    "linkedin",
    "youtube",
    "twitter",
    "logo_url",
    "hero_image_url",
    "opening_hours",
    "enrichment_tier",
)


async def _merge(pool: AsyncConnectionPool, id_a: UUID, id_b: UUID) -> UUID:
    """The older row (by created_at) is canonical. Fills any gap the canonical has using the
    duplicate's data, moves over any business_images the canonical doesn't already have, then
    soft-merges the duplicate (`merged_into_id`, never deleted). The duplicate's own
    `email`/`phone` are cleared as part of the same operation — leaving them set on both rows
    after copying to canonical would otherwise collide with the still-live UNIQUE(email) index."""
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT id FROM businesses WHERE id = ANY(%s) ORDER BY created_at ASC",
            ([str(id_a), str(id_b)],),
        )
        rows = cast("list[dict[str, Any]]", await cur.fetchall())
    if len(rows) < 2:
        return id_a  # one of them vanished concurrently (e.g. a racing merge) — nothing to do

    canonical_id = UUID(str(rows[0]["id"]))
    duplicate_id = UUID(str(rows[1]["id"]))

    set_clause = ", ".join(
        f"{c} = COALESCE(canonical.{c}, dup.{c})" for c in _MERGE_COALESCE_COLUMNS
    )
    # Not a plain COALESCE like the rest: both sides can be non-null (e.g. 'queued' and
    # 'enriched') — 'enriched' data winning in should be reflected even if canonical's own
    # crawl hadn't gotten there yet.
    set_clause += """, enrichment_status = CASE
        WHEN canonical.enrichment_status = 'enriched' OR dup.enrichment_status = 'enriched'
            THEN 'enriched' ELSE canonical.enrichment_status END"""
    async with pool.connection() as conn:
        await conn.execute(
            f"""
            UPDATE businesses AS canonical SET {set_clause}
            FROM businesses AS dup
            WHERE canonical.id = %(canonical_id)s AND dup.id = %(duplicate_id)s
            """,  # noqa: S608 - column list is our own fixed tuple, never user input
            {"canonical_id": str(canonical_id), "duplicate_id": str(duplicate_id)},
        )
        await conn.execute(
            """
            INSERT INTO business_images (business_id, kind, url)
            SELECT %(canonical_id)s, kind, url FROM business_images
            WHERE business_id = %(duplicate_id)s
              AND url NOT IN (
                SELECT url FROM business_images WHERE business_id = %(canonical_id)s
              )
            """,
            {"canonical_id": str(canonical_id), "duplicate_id": str(duplicate_id)},
        )
        await conn.execute(
            """
            UPDATE businesses
            SET merged_into_id = %(canonical_id)s, email = NULL, phone = NULL
            WHERE id = %(duplicate_id)s
            """,
            {"canonical_id": str(canonical_id), "duplicate_id": str(duplicate_id)},
        )

    return canonical_id
