"""Authored by: Mohit Singh"""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock

from business_scout_worker import metrics


class _FakePool:
    def __init__(self, conn: Any) -> None:
        self._conn = conn

    @asynccontextmanager
    async def connection(self) -> AsyncIterator[Any]:
        yield self._conn


async def test_increment_metric_upserts_with_default_by_one() -> None:
    conn = AsyncMock()
    pool = _FakePool(conn)

    await metrics.increment_metric(pool, "llm_calls_total")  # type: ignore[arg-type]

    conn.execute.assert_awaited_once()
    sql, params = conn.execute.await_args.args
    assert "INSERT INTO system_metrics" in sql
    assert "ON CONFLICT" in sql
    assert params == {"key": "llm_calls_total", "by": 1}


async def test_increment_metric_accepts_a_custom_amount() -> None:
    conn = AsyncMock()
    pool = _FakePool(conn)

    await metrics.increment_metric(pool, "google_places_calls_total", by=2)  # type: ignore[arg-type]

    _sql, params = conn.execute.await_args.args
    assert params == {"key": "google_places_calls_total", "by": 2}
