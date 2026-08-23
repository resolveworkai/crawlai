"""Authored by: Mohit Singh"""

import logging
import sys
from typing import cast

import structlog

from business_scout_worker.settings import Settings


def configure_logging(settings: Settings) -> None:
    """JSON structured logs, one config call at process start. Every call site binds
    job_id/business_id where relevant via structlog's contextvars, never plain string logs."""
    # Force UTF-8 on stdout/stderr regardless of the launching environment's own codepage
    # (2026-08-23 — a real bug: on Windows, without PYTHONIOENCODING=utf-8 set by the LAUNCHER
    # explicitly, sys.stdout defaults to the console's codepage, which can't encode Arabic/etc
    # location text — e.g. a real property job's own "أم نهد 4/مدينة هند 4" location crashed the
    # entire watch cycle the moment it tried to log "property job claimed", which orphan-recovery
    # then reported as "Interrupted by a runner restart" — a confusing, misleading error for what
    # was really an encoding crash. `errors="replace"` is a second safety net: even if reconfigure
    # itself can't fully represent some character, a log line must never be able to crash the
    # process — a lossy log beats a dead one.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    level = getattr(logging, settings.log_level.upper())
    logging.basicConfig(format="%(message)s", stream=sys.stdout, level=level)

    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            structlog.processors.add_log_level,
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.processors.StackInfoRenderer(),
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ],
        wrapper_class=structlog.make_filtering_bound_logger(level),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


def get_logger(name: str) -> structlog.typing.FilteringBoundLogger:
    return cast(structlog.typing.FilteringBoundLogger, structlog.get_logger(name))
