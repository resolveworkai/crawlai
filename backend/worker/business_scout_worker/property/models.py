"""Authored by: Mohit Singh

Row/DTO models for the Property Research flow — a THIRD parallel job type, SEPARATE from both the
Google Maps Crawl-OCR module (ocr/) and the e-commerce Product Research module (ecom/). PropertyJob
mirrors property_jobs (see db/migrations/1785300000000_property-crawl.sql); CapturedListing is the
per-listing handoff from capture (Stage A) to OCR-fallback + parsing (Stage B); ParsedListing is
Stage B/C's output, upserted into property_listings. Nothing here imports from or is imported by
ocr/ or ecom/'s models.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

Platform = Literal["dubizzle", "propertyfinder"]
PropertyType = Literal["apartment", "villa", "townhouse", "penthouse", "studio"]
Purpose = Literal["buy", "rent"]
# "ready" (completed/resale) vs "offplan" (pre-construction) vs "any" (no filter). Confirmed live
# 2026-08-22 on dubizzle: a card's `[data-testid="offplan-badge"]` presence is the real, reliable
# signal — no server-side URL param confirmed for this, so it's enforced client-side at capture
# time (see capture.py), same pattern as the bathroom floor.
PropertyStatus = Literal["ready", "offplan", "any"]
# The SOURCE SITE's own sort order, applied BEFORE capture (2026-08-24) — distinct from the
# frontend's post-capture SortKey, which only re-orders what's already been scraped. Empirically
# confirmed live against both real sites (not guessed) — see adapters/dubizzle.py and
# adapters/propertyfinder.py's own _SORT_PARAM maps for the real query-param values this maps to
# on each platform. "Rating"/"review" sort was explicitly asked for but doesn't exist as a concept
# on either site (no listing has a rating) — "newest" and "price" are the two dimensions BOTH
# platforms genuinely support server-side, so those are what's offered; "default" is each
# platform's own out-of-the-box ordering (dubizzle: "Popular"; propertyfinder: "Featured").
PropertySortOrder = Literal["default", "newest", "price_low_high", "price_high_low"]
PropertyJobStatus = Literal[
    "queued", "capturing", "parsing", "detail", "scoring", "ready", "failed", "blocked"
]
PropertyEndReason = Literal[
    "end_of_results", "max_pages", "max_listings", "stagnation", "blocked", "error"
]
ExtractionSource = Literal["dom", "dom+ocr", "ocr"]
ListingRefreshStatus = Literal["queued", "running", "done", "failed"]


class PropertyJob(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_by: UUID | None
    platform: Platform
    location: str
    bedrooms: int | None
    bathrooms: int | None
    property_type: PropertyType
    purpose: Purpose
    property_status: PropertyStatus = "ready"
    sort_order: PropertySortOrder = "default"
    max_pages: int
    max_listings: int
    detail_scrape_top_n: int
    whatsapp_message_template: str | None
    score_weights: dict[str, float] | None
    status: PropertyJobStatus
    end_reason: PropertyEndReason | None
    total_count: int
    captured_count: int
    detail_done_count: int
    current_listing: str | None
    error_message: str | None
    storage_dir: str | None
    retry_count: int
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class ListingRefresh(BaseModel):
    """Mirrors property_listing_refreshes (see
    db/migrations/1785700000000_property-listing-refreshes.sql) — an on-demand, single-URL
    re-check queued by the UI's per-row refresh button, processed by the same host runner as
    property_jobs but through a separate, much cheaper claim/finish path (see
    property/refresh.py)."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    listing_id: UUID
    listing_url: str
    platform: Platform
    status: ListingRefreshStatus
    old_price: float | None
    new_price: float | None
    error_message: str | None
    requested_at: datetime
    completed_at: datetime | None


class DomListingFields(BaseModel):
    """Structured fields read straight from a platform's search-result card DOM at capture time —
    authoritative, exact, no OCR. Adapters populate whatever their card markup exposes; anything
    left None falls back to the OCR pass in Stage B (see property/parse_property.py)."""

    title: str | None = None
    listing_url: str | None = None
    image_url: str | None = None
    price: float | None = None
    currency: str | None = None
    area_sqft: float | None = None
    bedrooms: int | None = None
    bathrooms: int | None = None
    property_type: str | None = None
    location_text: str | None = None
    community: str | None = None
    listed_days_ago: int | None = None
    verified: bool = False
    badges: list[str] = []
    # Confirmed live 2026-08-22 (dubizzle): a card's own `[data-testid="offplan-badge"]` presence.
    is_offplan: bool = False


class CapturedListing(BaseModel):
    """One listing captured off a search-results page. `title`/`listing_url`/`image_url` +
    everything the adapter's `extract_card` populates in `dom` come straight from the DOM
    (authoritative); `images` are the relative screenshot paths under the job dir that Stage B
    OCRs as a fallback for whatever the DOM didn't expose plus the visual audit trail."""

    idx: int
    page_num: int = 1
    title: str
    listing_url: str | None = None
    image_url: str | None = None
    images: list[str] = []
    dom: DomListingFields = DomListingFields()
    listing_key: str | None = None


class PropertyManifest(BaseModel):
    job_id: str
    platform: Platform
    location: str
    started_at: str
    end_reason: PropertyEndReason
    items: list[CapturedListing] = []


class DomDetailFields(BaseModel):
    """Detail-page deep-scrape fields, populated only for the job's `detail_scrape_top_n` highest-
    scoring listings. Never fabricated — absence means the detail page wasn't scraped or the
    adapter couldn't find the field (e.g. no phone revealed without an extra click the adapter
    doesn't perform)."""

    description: str | None = None
    agent_name: str | None = None
    phone_number: str | None = None
    image_urls: list[str] = []
    # Confirmed live 2026-08-22 (dubizzle): the detail page's own "Property Age" (e.g. "15 Years")
    # and "Average Rent" (e.g. "AED 87,751 Yearly") fields, read via stable data-testid selectors.
    # Detail-page-only, same scope as phone_number above — never populated for a non-detail-scraped
    # listing, and never guessed/estimated when the site doesn't show it (e.g. a brand-new/off-plan
    # listing may have no "Property Age" at all — stays None, not fabricated as 0).
    age_years: int | None = None
    average_rent: float | None = None
    # Confirmed live 2026-08-22 (dubizzle): the detail page's own `[data-testid="posted-on"]` field
    # (e.g. "Posted on: 4th June 2026") — stored as the raw text after the "Posted on:" label
    # rather than attempting a fragile string->date parse that could silently produce a wrong date.
    listed_date: str | None = None
    # Confirmed live 2026-08-22 (both platforms): the detail page's OWN price element — dubizzle's
    # `[data-testid="listing-price"]` (confirmed the FIRST DOM match is the listing's own price, a
    # duplicate-testid "similar properties" carousel further down the page always sorts after it)
    # and propertyfinder's `[data-testid="property-price"]` (confirmed unique on the page). Used by
    # the on-demand single-listing refresh flow (property/jobs.py's claim_pending_listing_refresh)
    # to re-check a saved listing's CURRENT price without re-running a whole search job.
    price: float | None = None


class ParsedListing(BaseModel):
    """Stage B/C output for one listing — what gets upserted into property_listings."""

    idx: int
    page_num: int = 1
    title: str
    listing_url: str | None = None
    image_urls: list[str] = []
    price: float | None = None
    currency: str = "AED"
    area_sqft: float | None = None
    price_per_sqft: float | None = None
    bedrooms: int | None = None
    bathrooms: int | None = None
    property_type: str | None = None
    location_text: str | None = None
    community: str | None = None
    listed_days_ago: int | None = None
    verified: bool = False
    badges: list[str] = []
    is_offplan: bool = False
    distress_keywords: list[str] = []
    agent_name: str | None = None
    phone_number: str | None = None
    whatsapp_link: str | None = None
    description: str | None = None
    # Detail-page-only (see DomDetailFields) — populated only for detail_scrape_top_n listings.
    age_years: int | None = None
    average_rent: float | None = None
    listed_date: str | None = None
    distress_score: float | None = None
    # How much of distress_score is backed by real data vs. a neutral fallback (analysis.py's
    # compute_distress_confidence) — 2026-08-23. Set alongside distress_score at every scoring
    # pass (Stage C, and again post-detail-scrape); never fabricated for a listing that hasn't
    # been scored yet.
    distress_confidence: float | None = None
    extraction_source: ExtractionSource = "dom"
    ocr_confidence: float | None = None
    needs_review: bool = False
    raw_text: str | None = None
    source_images: list[str] = []
    detail_scraped: bool = False
