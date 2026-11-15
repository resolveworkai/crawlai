"""Authored by: Mohit Singh

Row/DTO models for the "Product Research (OCR)" e-commerce flow — a SEPARATE pipeline from the
Google Maps Crawl-OCR module (business_scout_worker/ocr/). EcomJob mirrors the ecom_jobs table
(see db/migrations/1785000000000_ecom-crawl.sql); CapturedProduct is the per-product handoff from
capture (Stage A) to OCR-fallback + parsing (Stage B); ParsedProduct is Stage B's output, upserted
into ecom_products. Nothing here imports from or is imported by the ocr/ package's models.
"""

from __future__ import annotations

from datetime import datetime
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

Platform = Literal["noon", "amazon", "amazon_in", "aliexpress"]
SortMode = Literal["rating_desc", "price_asc", "price_desc", "relevance"]
EcomJobStatus = Literal[
    "queued", "capturing", "ocr", "parsing", "detail", "ready", "failed", "blocked"
]
EcomEndReason = Literal[
    "end_of_results", "max_pages", "max_products", "stagnation", "blocked", "error"
]
ExtractionSource = Literal["dom", "dom+ocr", "ocr"]


class EcomJob(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_by: UUID | None
    platform: Platform
    query: str
    sort_mode: SortMode
    max_pages: int
    max_products: int
    detail_scrape_top_n: int
    score_weights: dict[str, float] | None
    status: EcomJobStatus
    end_reason: EcomEndReason | None
    total_count: int
    captured_count: int
    ocr_done_count: int
    detail_done_count: int
    current_product: str | None
    error_message: str | None
    storage_dir: str | None
    retry_count: int
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class DomProductFields(BaseModel):
    """Structured fields read straight from a platform's search-result card DOM at capture time —
    authoritative, exact, no OCR. Adapters populate whatever their card markup exposes; anything
    left None falls back to the OCR pass in Stage B (see ecom/parse_product.py)."""

    title: str | None = None
    product_url: str | None = None
    image_url: str | None = None
    price: float | None = None
    list_price: float | None = None
    currency: str | None = None
    discount_pct: float | None = None
    rating: float | None = None
    review_count: int | None = None
    bought_past_month: int | None = None
    bought_past_month_raw: str | None = None
    free_delivery: bool = False
    delivery_date: str | None = None
    category: str | None = None
    badges: list[str] = []
    rank_in_category: int | None = None
    sponsored: bool = False


class CapturedProduct(BaseModel):
    """One product captured off a search-results page. `title`/`product_url`/`image_url` +
    everything the adapter's `extract_card` populates in `dom` come straight from the DOM
    (authoritative); `images` are the relative screenshot paths under the job dir that Stage B
    OCRs as a fallback for whatever the DOM didn't expose plus the visual audit trail."""

    idx: int
    page_num: int = 1
    title: str
    product_url: str | None = None
    image_url: str | None = None
    images: list[str] = []
    dom: DomProductFields = DomProductFields()
    product_key: str | None = None


class EcomManifest(BaseModel):
    job_id: str
    platform: Platform
    query: str
    started_at: str
    end_reason: EcomEndReason
    items: list[CapturedProduct] = []


class DomDetailFields(BaseModel):
    """Phase 2b — optional detail-page deep-scrape fields, populated only when the job's
    `detail_scrape_top_n > 0` and this product was captured for a top-N product. Never fabricated;
    absence means the detail page wasn't scraped or the adapter couldn't find the field."""

    description: str | None = None
    about_bullets: list[str] = []
    breadcrumb_category: str | None = None
    seller_name: str | None = None


class ParsedProduct(BaseModel):
    """Stage B/C output for one product — what gets upserted into ecom_products."""

    idx: int
    page_num: int = 1
    title: str
    product_url: str | None = None
    image_url: str | None = None
    price: float | None = None
    list_price: float | None = None
    currency: str = "AED"
    discount_pct: float | None = None
    rating: float | None = None
    review_count: int | None = None
    bought_past_month: int | None = None
    bought_past_month_raw: str | None = None
    free_delivery: bool = False
    delivery_date: str | None = None
    category: str | None = None
    badges: list[str] = []
    rank_in_category: int | None = None
    sponsored: bool = False
    opportunity_score: float | None = None
    extraction_source: ExtractionSource = "dom"
    ocr_confidence: float | None = None
    needs_review: bool = False
    raw_text: str | None = None
    source_images: list[str] = []
    description: str | None = None
    about_bullets: list[str] = []
    breadcrumb_category: str | None = None
    seller_name: str | None = None
    detail_scraped: bool = False
