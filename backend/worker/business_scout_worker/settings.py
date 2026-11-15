"""Authored by: Mohit Singh"""

import os
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Parsed once, at process start. Missing/invalid required vars => the process exits with
    a clear message via pydantic-settings' validation error, never a half-booted daemon.

    Extend this as later phases add real consumers (Overpass/Nominatim URLs in Phase 3,
    LLM_* in Phase 5) rather than validating vars nothing reads yet.
    """

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    environment: Literal["development", "test", "production"] = "development"
    log_level: Literal["debug", "info", "warning", "error", "critical"] = "info"
    database_url: str = Field(..., min_length=1)
    poll_interval_seconds: float = Field(default=5.0, gt=0)

    # Phase 8 performance pass — psycopg_pool's AsyncConnectionPool defaults to min_size=4 and
    # max_size=None (meaning "same as min_size", i.e. capped at 4 unless set explicitly). A
    # batch of `crawl_settings.concurrency` (up to 32, see Settings screen) businesses processed
    # concurrently each do several sequential DB writes — 4 connections would serialize most of
    # that work behind pool contention. Sized to comfortably cover the max configurable
    # concurrency plus headroom for the LISTEN connection and concurrent job-control queries.
    db_pool_min: int = Field(default=4, gt=0)
    db_pool_max: int = Field(default=40, gt=0)

    # Phase 5 — Tier-3 AI extraction (optional, provider-agnostic; see llm.py). Absence of
    # llm_base_url means AI extraction is unreachable even if crawl_settings.use_ai_extraction
    # is on — the pipeline treats that as "not configured", not an error.
    llm_base_url: str | None = None
    """OpenAI-compatible base URL, e.g. Gemini's `https://generativelanguage.googleapis.com/v1beta/openai`,
    OpenAI's `https://api.openai.com/v1`, or a local Ollama's `http://ollama:11434/v1`."""
    llm_api_key: str | None = None
    llm_model: str = "gemini-2.5-flash"
    llm_timeout_s: float = Field(default=30.0, gt=0)
    llm_max_tokens: int = Field(default=500, gt=0)

    # Crawl-OCR module (ocr/) — Google Maps screenshot capture + OCR. Shares OCR_CAPTURES_DIR
    # with the Node API (Node reads/purges, this worker writes). Headless in the container (no
    # display); flip OCR_CRAWL_HEADLESS=false for local, attended dev where seeing the browser
    # helps. device_scale=2 is the OCR-readability lever (2x DPI at 100% zoom) — never lower it.
    ocr_captures_dir: str = "./storage/ocr_captures"
    ocr_crawl_headless: bool = True
    ocr_device_scale: int = Field(default=2, ge=1, le=4)
    ocr_nav_timeout_ms: int = Field(default=45000, gt=0)
    ocr_business_timeout_s: float = Field(default=90.0, gt=0)
    """Hard ceiling for ONE business (navigate -> panel -> DOM extract -> screenshots); a business
    that exceeds it is abandoned and the walk moves on. Was a hard-coded 30s, which assumed a ~10s
    place navigation — measured 2026-11-15 on a loaded 4-CPU machine, the stages take ~11-16s (goto)
    + ~7-9s (panel) + ~19-22s (2 screenshots) = ~40-45s, so ~80% of businesses (18 of 22) were
    thrown away at 30s while the job showed "capturing". 90s lets a slow-but-working business
    finish; a genuinely stuck one now costs up to 90s instead of 30s.
    Override with OCR_BUSINESS_TIMEOUT_S."""
    tesseract_cmd: str | None = None
    """Absolute path to the tesseract binary. None => rely on PATH (correct in the Docker image
    where apt puts it on PATH; local Windows dev sets this to the UB-Mannheim install path)."""
    ocr_concurrency: int = Field(
        default_factory=lambda: max(1, min(8, (os.cpu_count() or 4) - 1)), ge=1, le=16
    )
    """How many businesses' Stage B (Tesseract OCR) run concurrently. Distinct from the main
    crawler's crawl_settings.concurrency (job-level, DB-configurable) — this is per-image OCR
    parallelism within the ONE active OCR job (single-flight by design). Each Tesseract call
    stays single-threaded internally (OMP_THREAD_LIMIT=1 in ocr_engine.py — multi-threading a
    single image was measured 5.5x SLOWER), so running several calls concurrently is what
    actually uses multiple CPU cores. Capture (Stage A, one Chromium page) already finished
    before Stage B starts, so this doesn't compete with browser navigation for the CPU.
    Defaults to (container core count - 1), capped at 8, rather than a flat 3 (2026-09-12 —
    a flat default left multi-core hosts under-using Stage B while a real job sat mostly idle
    between OCR calls); override via OCR_CONCURRENCY if a specific host needs a different value.
    Keep at or below the container's core count minus 1 — oversubscribing degrades every call
    equally rather than speeding the batch up."""

    # Product Research module (ecom/) — noon/amazon search-results capture + OCR fallback +
    # opportunity scoring. A SEPARATE module from Crawl-OCR (ocr/) above: own storage dir, own
    # pg_notify channel ('ecom_crawl_jobs'), own tables. Reuses tesseract_cmd/ocr_concurrency
    # as-is (Stage B's OCR call shape is identical) rather than duplicating those two fields.
    ecom_captures_dir: str = "./storage/ecom_captures"
    ecom_headless: bool = True
    ecom_nav_timeout_ms: int = Field(default=45000, gt=0)
    ecom_device_scale: int = Field(default=2, ge=1, le=4)
    """OCR-readability lever for the ecom card/detail screenshots — same rationale as
    ocr_device_scale (never lower it)."""
    ecom_cdp_url: str | None = None
    """When set (e.g. 'http://localhost:9222'), the ecom capture engine ATTACHES to an already-
    running Chrome over the DevTools protocol instead of launching its own headless Chromium.
    Required for REQUIRES_CDP platforms (noon.com — its edge blocks every automated-launch
    transport; only the operator's real Chrome gets through). Left None in the containerized
    daemon (which handles only non-CDP platforms); set on the host runner (run_noon_host.py)."""

    # Property Research module (property/) — dubizzle.com/propertyfinder.ae listing capture +
    # OCR fallback + distress-deal scoring. A THIRD SEPARATE module, own storage dir, own tables.
    # Reuses tesseract_cmd/ocr_concurrency as-is. UNLIKE ecom (which has a headless-capable
    # platform, amazon, and a container daemon that LISTENs on a pg_notify channel), EVERY
    # property platform requires CDP (both dubizzle and propertyfinder block plain headless
    # Chromium — confirmed 2026-08-22), so there is no property_headless flag AND no pg_notify
    # channel at all — only the host runner (run_property_host.py) ever processes these jobs, on
    # a plain poll loop (PROPERTY_HOST_POLL_SECONDS), with property_cdp_url always set. If a
    # future property platform turns out to be headless-capable, that's when a pg_notify channel
    # + a container-daemon claim branch would actually make sense — don't add one before that.
    property_captures_dir: str = "./storage/property_captures"
    property_nav_timeout_ms: int = Field(default=45000, gt=0)
    property_device_scale: int = Field(default=2, ge=1, le=4)
    property_cdp_url: str | None = None

    # Host-runner reliability (2026-08-23, chrome_health.py) — both property and noon/aliexpress
    # host runners attach to the SAME physical operator Chrome window on the same CDP port (by
    # design), so Chrome dying takes down every CDP-required platform at once, silently, until a
    # human notices a job failed and manually re-runs the .bat file. These settings let each host
    # runner self-heal (best-effort auto-relaunch) and report a heartbeat the API/UI can surface.
    chrome_exe_path: str | None = None
    """Override for chrome.exe's location. None => auto-detect the two standard Program Files
    paths (matches scripts/start-*-host.bat's own fallback logic)."""
    chrome_user_data_dir: str | None = None
    """Override for the debug-Chrome profile dir. None => %TEMP%\\noon-cdp-chrome (matches every
    scripts/start-*-host.bat exactly, so an auto-restart attaches to the SAME profile rather than
    creating a second, conflicting one)."""
    chrome_auto_restart: bool = True
    """Best-effort self-heal — set false to only detect/report the outage, never attempt to
    relaunch Chrome (e.g. if the operator wants to control that manually)."""


def load_settings() -> Settings:
    return Settings()
