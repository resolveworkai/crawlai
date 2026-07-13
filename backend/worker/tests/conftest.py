# Authored by: Mohit Singh
"""Sets the minimal env config the worker requires to boot, so pure-unit tests (mocked DB)
never need a real .env file. Integration tests (test_integration.py, `-m integration`) need
this to be a genuinely reachable Postgres — port 5436 matches docker-compose.yml's current
host mapping (see .claude/skills/skills_devops.md "Host port collisions")."""

import asyncio
import os
import sys
from collections.abc import AsyncGenerator

import pytest_asyncio
from psycopg_pool import AsyncConnectionPool

os.environ.setdefault("DATABASE_URL", "postgresql://postgres:1234@localhost:5436/master_db_crawler")
os.environ["ENVIRONMENT"] = "test"
os.environ["LOG_LEVEL"] = "error"

# Same Windows-only fix as main.py — psycopg3's async mode needs SelectorEventLoop, not the
# default ProactorEventLoop. Must be set before pytest-asyncio creates its first event loop.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


@pytest_asyncio.fixture
async def pool() -> AsyncGenerator[AsyncConnectionPool, None]:
    """Shared real-Postgres pool fixture for every `-m integration` test module. Fails fast
    with a clear message if pointed at an unreachable/unmigrated DB."""
    from business_scout_worker.db import connection, create_pool
    from business_scout_worker.settings import load_settings

    settings = load_settings()
    p = create_pool(settings)
    await p.open()
    async with connection(p) as conn:
        await conn.execute("SELECT 1 FROM users LIMIT 0")
    yield p
    await p.close()
