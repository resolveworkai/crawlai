"""Authored by: Mohit Singh

Row models mirroring db/migrations/*.sql exactly. This is the Python-side half of the shared
schema contract — backend/api's TS types (src/types/db.ts) mirror the same tables
independently in Node. Neither runtime imports the other's types; the database schema is the
only shared contract (see .claude/skills/skills_db.md).
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

AppRole = Literal["admin", "operator", "viewer"]

JobStatus = Literal[
    "pending", "discovering", "crawling", "paused", "completed", "failed", "cancelled"
]

LogLevel = Literal["info", "warn", "error", "debug"]

EnrichmentStatus = Literal["queued", "crawling", "enriched", "failed"]

DynamicFieldType = Literal["text", "number", "boolean", "list", "url"]

ExportFormat = Literal["xlsx", "csv", "json"]


class _Row(BaseModel):
    """Base for every row model — built from psycopg's dict_row output (see db.py)."""

    model_config = ConfigDict(from_attributes=True)


class User(_Row):
    id: UUID
    email: str
    password_hash: str
    full_name: str | None
    created_at: datetime
    updated_at: datetime


class UserRoleRow(_Row):
    id: UUID
    user_id: UUID
    role: AppRole
    created_at: datetime


class CrawlJob(_Row):
    id: UUID
    created_by: UUID
    business_type: str
    location_label: str | None
    center_lat: float
    center_lng: float
    radius_km: Decimal
    status: JobStatus
    cancel_requested: bool
    pause_requested: bool
    found_count: int
    crawled_count: int
    website_crawled_count: int
    failed_count: int
    current_business: str | None
    error_message: str | None
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime
    updated_at: datetime


class CrawlLog(_Row):
    id: int
    job_id: UUID
    level: LogLevel
    message: str
    ts: datetime


class Business(_Row):
    id: UUID
    created_by: UUID | None
    crawl_job_id: UUID | None

    name: str
    sub_name: str | None
    category: str | None
    tags: list[str] | None
    description: str | None

    google_map_name: str | None
    google_map_url: str | None
    osm_type: str | None
    osm_id: str | None
    latitude: float | None
    longitude: float | None

    website_url: str | None
    website_title: str | None
    meta_description: str | None
    meta_keywords: str | None
    about_text: str | None
    contact_url: str | None

    email: str | None
    emails: list[str] | None
    phone: str | None
    phones: list[str] | None
    whatsapp: str | None

    facebook: str | None
    instagram: str | None
    linkedin: str | None
    youtube: str | None
    twitter: str | None

    address_line1: str | None
    address_line2: str | None
    area: str | None
    city: str | None
    state: str | None
    country: str | None
    postal_code: str | None

    google_rating: Decimal | None
    review_count: int | None
    review_url: str | None
    business_status: str | None
    opening_date: date | None
    claimed: bool | None
    price_level: str | None
    google_enriched_at: datetime | None

    opening_hours: dict[str, Any] | None

    logo_url: str | None
    cover_image_url: str | None
    hero_image_url: str | None

    ai_summary: str | None
    services: list[str] | None
    products: list[str] | None
    amenities: list[str] | None
    keywords: list[str] | None
    languages: list[str] | None
    target_audience: str | None
    industry: str | None

    owner_name: str | None
    manager_name: str | None
    reception_number: str | None
    support_email: str | None
    sales_email: str | None
    general_email: str | None
    ssl_enabled: bool | None
    cms: str | None
    hosting_provider: str | None
    google_analytics: bool | None
    facebook_pixel: bool | None

    enrichment_status: EnrichmentStatus
    # Phase 8 observability — which tier actually supplied the contact data. See
    # dedupe.py's apply_enrichment and db/migrations/*system-metrics-and-tier.sql.
    enrichment_tier: Literal["tier1", "tier2"] | None
    extras: dict[str, Any]

    # Fuzzy secondary dedup (Phase 4) — non-null means this row was soft-merged into another,
    # better-known duplicate; see dedupe.py and db/migrations/*fuzzy-dedup-merge.sql.
    merged_into_id: UUID | None

    created_at: datetime
    updated_at: datetime


class BusinessImage(_Row):
    id: UUID
    business_id: UUID
    kind: str
    url: str
    created_at: datetime


class DynamicField(_Row):
    id: UUID
    created_by: UUID | None
    key: str
    label: str
    prompt: str
    field_type: DynamicFieldType
    enabled: bool
    created_at: datetime
    updated_at: datetime


class CrawlSettings(_Row):
    """Global singleton row (id is always 1) — see db/migrations crawl-settings.sql."""

    id: Literal[1]
    concurrency: int
    retry_count: int
    timeout_ms: int
    user_agent: str
    map_provider: str
    discovery_source: str
    max_businesses_per_job: int
    crawl_website: bool
    respect_robots_txt: bool
    follow_sitemaps: bool
    request_delay_ms: int
    use_ai_extraction: bool
    proxy_url: str | None
    updated_at: datetime


class ExportRecord(_Row):
    id: UUID
    created_by: UUID | None
    format: ExportFormat
    filename: str
    row_count: int
    size_bytes: int
    filter_snapshot: dict[str, Any]
    storage_path: str
    created_at: datetime
    expires_at: datetime | None
