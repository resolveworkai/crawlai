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


def load_settings() -> Settings:
    return Settings()
