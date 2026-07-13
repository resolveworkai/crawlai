# Authored by: Mohit Singh
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Any
from unittest.mock import AsyncMock

from business_scout_worker.db import ping_database


class _FakePool:
    """Mimics psycopg_pool.AsyncConnectionPool's `.connection()` async context manager
    without needing a live Postgres — pool wiring (LISTEN/claim) is exercised for real in
    Phase 1+ integration tests against a real (compose) Postgres."""

    def __init__(self, conn: Any) -> None:
        self._conn = conn

    @asynccontextmanager
    async def connection(self) -> AsyncIterator[Any]:
        yield self._conn


async def test_ping_database_returns_true_when_query_succeeds() -> None:
    conn = AsyncMock()
    pool = _FakePool(conn)

    assert await ping_database(pool) is True  # type: ignore[arg-type]
    conn.execute.assert_awaited_once_with("SELECT 1")


async def test_ping_database_returns_false_when_query_raises() -> None:
    conn = AsyncMock()
    conn.execute.side_effect = ConnectionError("db unreachable")
    pool = _FakePool(conn)

    assert await ping_database(pool) is False  # type: ignore[arg-type]
