"""Authored by: Mohit Singh

Exact dedupe + upsert — see md/plans/0001-*.md "P5 Dedup" (the exact half; the fuzzy
name+address rapidfuzz pass is Phase 4, not here). Two dedupe keys, both real Postgres UNIQUE
indexes (see db/migrations/*businesses-and-images.sql):
  - PRIMARY: (osm_type, osm_id) — Overpass discovery upserts against this.
  - SECONDARY (override): lower(email) — Tier-1 enrichment can discover the same real-world
    business under a second OSM element (a common node-vs-way duplication); when that
    business's email matches an already-known row, the match wins and enrichment is applied
    to the existing row instead of violating the unique index or silently losing data.
"""

from __future__ import annotations

from typing import Any, cast
from uuid import UUID

import psycopg
from psycopg_pool import AsyncConnectionPool

from business_scout_worker.discovery.models import DiscoveredBusiness
from business_scout_worker.enrich.models import Tier1Result

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
    async with pool.connection() as conn:
        cur = await conn.execute(
            """
            INSERT INTO businesses (
                crawl_job_id, name, sub_name, category, tags,
                google_map_name, osm_type, osm_id, latitude, longitude,
                address_line1, area, city, state, country, postal_code
            ) VALUES (
                %(crawl_job_id)s, %(name)s, %(sub_name)s, %(category)s, %(tags)s,
                %(google_map_name)s, %(osm_type)s, %(osm_id)s, %(latitude)s, %(longitude)s,
                %(address_line1)s, %(area)s, %(city)s, %(state)s, %(country)s, %(postal_code)s
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
                postal_code = EXCLUDED.postal_code
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
            },
        )
        row = cast("dict[str, Any] | None", await cur.fetchone())
        if row is None:
            raise RuntimeError("upsert_discovered: INSERT ... RETURNING id yielded no row")
        business_id = UUID(str(row["id"]))

    if discovered.website_url or discovered.phone or discovered.email:
        await _set_fields_tolerating_email_conflict(
            pool,
            business_id,
            {
                "website_url": discovered.website_url,
                "phone": discovered.phone,
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
    pool: AsyncConnectionPool, business_id: UUID, website_url: str | None, result: Tier1Result
) -> None:
    """Writes Tier-1 results onto the row and flips enrichment_status='enriched'. The primary
    `email`/`phone` columns get the first extracted value (best-effort "most likely" contact);
    the full sets land in `emails`/`phones` arrays (req #4 — ALL emails/phones, not just one)."""
    primary_email = result.emails[0] if result.emails else None
    primary_phone = result.phones[0] if result.phones else None

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
    }
    await _set_fields_tolerating_email_conflict(pool, business_id, fields)

    if result.image_urls:
        await _replace_business_images(pool, business_id, result.image_urls)


async def mark_enrichment_failed(pool: AsyncConnectionPool, business_id: UUID) -> None:
    await mark_enrichment_status(pool, business_id, "failed")


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
