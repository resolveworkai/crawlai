"""Authored by: Mohit Singh

Typed query functions the worker actually needs in Phase 1 (schema/model integration proof +
CRUD smoke tests). The write-heavy discovery/enrichment/dedupe queries (job claim loop,
businesses upsert, crawl_logs streaming) land in Phase 3 — see
md/plans/0001-business-scout-ai-crawler.md.
"""

from __future__ import annotations

from typing import Any, cast
from uuid import UUID

from psycopg_pool import AsyncConnectionPool

from business_scout_worker.db import connection
from business_scout_worker.models import Business, CrawlSettings, DynamicField, User


async def get_crawl_settings(pool: AsyncConnectionPool) -> CrawlSettings:
    """The global singleton row (id=1) — guaranteed to exist by its seed migration."""
    async with connection(pool) as conn:
        cur = await conn.execute("SELECT * FROM crawl_settings WHERE id = 1")
        row = await cur.fetchone()
    if row is None:
        raise RuntimeError("crawl_settings singleton row missing — did migrations run?")
    return CrawlSettings.model_validate(row)


async def find_user_by_email(pool: AsyncConnectionPool, email: str) -> User | None:
    async with connection(pool) as conn:
        cur = await conn.execute("SELECT * FROM users WHERE email = %s", (email,))
        row = await cur.fetchone()
    return User.model_validate(row) if row is not None else None


async def list_enabled_dynamic_fields(pool: AsyncConnectionPool) -> list[DynamicField]:
    async with connection(pool) as conn:
        cur = await conn.execute(
            "SELECT * FROM dynamic_fields WHERE enabled = true ORDER BY created_at ASC"
        )
        rows = await cur.fetchall()
    return [DynamicField.model_validate(row) for row in rows]


async def find_business_by_id(pool: AsyncConnectionPool, business_id: UUID) -> Business | None:
    async with connection(pool) as conn:
        cur = await conn.execute("SELECT * FROM businesses WHERE id = %s", (business_id,))
        row = await cur.fetchone()
    return Business.model_validate(row) if row is not None else None


async def count_businesses(pool: AsyncConnectionPool) -> int:
    async with connection(pool) as conn:
        cur = await conn.execute("SELECT count(*) AS n FROM businesses")
        row = cast("dict[str, Any] | None", await cur.fetchone())
    return int(row["n"]) if row is not None else 0
