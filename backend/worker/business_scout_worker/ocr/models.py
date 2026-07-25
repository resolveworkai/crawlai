"""Authored by: Mohit Singh

Row/DTO models for the Crawl-OCR flow. OcrJob mirrors the ocr_jobs table (see
db/migrations/*ocr-crawl.sql); CapturedItem is the per-business handoff from Stage A (capture)
to Stage B (OCR); ParsedBusiness is Stage B's output, upserted into ocr_businesses.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict

OcrJobStatus = Literal["queued", "capturing", "ocr", "parsing", "ready", "failed", "blocked"]
OcrEndReason = Literal["end_of_list", "max_results", "stagnation", "blocked", "error"]


class OcrJob(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    created_by: UUID | None
    query: str
    location: str
    center_lat: float | None
    center_lng: float | None
    radius_km: float | None
    max_results: int
    expand_hours: bool
    langs: str
    status: OcrJobStatus
    end_reason: OcrEndReason | None
    total_count: int
    captured_count: int
    ocr_done_count: int
    error_message: str | None
    current_business: str | None
    storage_dir: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None


class DomFields(BaseModel):
    """Structured fields read straight from the Maps DOM at capture time — authoritative, exact,
    no OCR. Stage B prefers these over the OCR-parsed equivalents (esp. phone: OCR misreads
    digits, the DOM does not). Rating/reviews/category come from the panel's aria-labels too."""

    phone: str | None = None
    website: str | None = None
    address: str | None = None
    plus_code: str | None = None
    rating: float | None = None
    review_count: int | None = None
    category: str | None = None
    image_url: str | None = None


class CapturedItem(BaseModel):
    """One business captured by Stage A. `name`/`maps_url` + `dom` come from the DOM
    (authoritative); `images` are the relative segment PNG paths under the job dir that Stage B
    OCRs for the visual audit trail and as a fallback for anything the DOM didn't expose."""

    index: int
    name: str
    maps_url: str | None = None
    images: list[str] = []
    dom: DomFields = DomFields()
    # Parsed exactly from the place href's !3d{lat}!4d{lng} segment — Google's own coordinates
    # for this business, not an estimate. distance_km is haversine from the job's center point
    # (only set when the job was created with one); businesses beyond radius_km are never
    # captured at all (filtered in the walk loop), so every item that reaches Stage B is in-range.
    lat: float | None = None
    lng: float | None = None
    distance_km: float | None = None


class CaptureManifest(BaseModel):
    job_id: str
    query: str
    location: str
    started_at: str
    end_reason: OcrEndReason
    items: list[CapturedItem] = []


class ParsedField(BaseModel):
    value: Any = None
    confidence: float = 0.0
    source_line: str | None = None


class ParsedBusiness(BaseModel):
    """Stage B output for one business — what gets written to ocr_businesses."""

    idx: int
    name: str
    maps_url: str | None = None
    rating: float | None = None
    review_count: int | None = None
    category: str | None = None
    address: str | None = None
    phone: str | None = None
    website: str | None = None
    plus_code: str | None = None
    hours_summary: str | None = None
    hours_weekly: dict[str, str] | None = None
    email: str | None = None
    image_url: str | None = None
    lat: float | None = None
    lng: float | None = None
    distance_km: float | None = None
    ocr_confidence: float = 0.0
    needs_review: bool = False
    raw_text: str = ""
    source_images: list[str] = []
