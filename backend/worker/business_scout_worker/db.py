"""Authored by: Mohit Singh"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from business_scout_worker.settings import Settings


def create_pool(settings: Settings) -> AsyncConnectionPool:
    """Schema is owned entirely by db/migrations (node-pg-migrate, run from backend/api).
    This pool is read/write access to that schema — it never issues DDL.

    row_factory=dict_row so query results are column-name-keyed dicts, which the pydantic
    models in models.py consume directly via model_validate()."""
    return AsyncConnectionPool(
        conninfo=settings.database_url,
        open=False,
        min_size=settings.db_pool_min,
        max_size=settings.db_pool_max,
        kwargs={"row_factory": dict_row},
    )


@asynccontextmanager
async def connection(pool: AsyncConnectionPool) -> AsyncIterator[AsyncConnection]:
    async with pool.connection() as conn:
        yield conn


async def ping_database(pool: AsyncConnectionPool) -> bool:
    try:
        async with connection(pool) as conn:
            await conn.execute("SELECT 1")
        return True
    except Exception:
        return False
