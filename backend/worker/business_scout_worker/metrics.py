"""Authored by: Mohit Singh

Phase 8 observability — increments the shared `system_metrics` counters table (schema owned by
Node's node-pg-migrate; this runtime only ever plain-SQL writes to it, same pattern as
`businesses`/`crawl_logs`). See `backend/api/src/db/systemMetrics.ts` (Node's mirror) and
md/plans/0001-*.md "Phase 8".
"""

from __future__ import annotations

from psycopg_pool import AsyncConnectionPool


async def increment_metric(pool: AsyncConnectionPool, key: str, by: int = 1) -> None:
    async with pool.connection() as conn:
        await conn.execute(
            """
            INSERT INTO system_metrics (metric_key, count)
            VALUES (%(key)s, %(by)s)
            ON CONFLICT (metric_key) DO UPDATE
                SET count = system_metrics.count + EXCLUDED.count, updated_at = now()
            """,
            {"key": key, "by": by},
        )
