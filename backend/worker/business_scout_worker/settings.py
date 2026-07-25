"""Authored by: Mohit Singh"""

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


def load_settings() -> Settings:
    return Settings()
