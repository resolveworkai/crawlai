"""Authored by: Mohit Singh"""

import logging
import sys
from typing import cast

import structlog

from business_scout_worker.settings import Settings


def configure_logging(settings: Settings) -> None:
    """JSON structured logs, one config call at process start. Every call site binds
    job_id/business_id where relevant via structlog's contextvars, never plain string logs."""
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
