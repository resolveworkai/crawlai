"""Authored by: Mohit Singh

Pure unit tests for pipeline.py's orchestration logic — every DB/network call is monkeypatched,
so this runs without a live Postgres or Overpass/website access. Real-DB behavior is covered by
the integration seam test (test_pipeline_integration.py).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from decimal import Decimal
from typing import cast
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from psycopg_pool import AsyncConnectionPool

from business_scout_worker import dedupe, pipeline
from business_scout_worker import jobs as job_queries
from business_scout_worker.discovery.models import DiscoveredBusiness
from business_scout_worker.enrich.models import Tier1Result
from business_scout_worker.models import CrawlJob, CrawlSettings

FakePool = cast("type[AsyncConnectionPool]", object)
"""A dummy stand-in for AsyncConnectionPool — every call that would use it is monkeypatched, so
its only job is to satisfy run_job's type signature and behave as a distinct, comparable value
in assertions (unlike bare `object()`, calling this class gives a real, equal-to-itself instance
each time it's referenced by variable, per test)."""


def _job(**overrides: object) -> CrawlJob:
    defaults: dict[str, object] = dict(
        id=uuid4(),
        created_by=uuid4(),
        business_type="gym",
        location_label="Berlin, DE",
        center_lat=52.52,
        center_lng=13.405,
        radius_km=Decimal("5.00"),
        status="discovering",
        cancel_requested=False,
        pause_requested=False,
        found_count=0,
        crawled_count=0,
        website_crawled_count=0,
        failed_count=0,
        current_business=None,
        error_message=None,
        started_at=datetime.now(UTC),
        finished_at=None,
        created_at=datetime.now(UTC),
        updated_at=datetime.now(UTC),
    )
    defaults.update(overrides)
    return CrawlJob.model_validate(defaults)


def _settings(**overrides: object) -> CrawlSettings:
    defaults: dict[str, object] = dict(
        id=1,
        concurrency=2,
        retry_count=2,
        timeout_ms=15000,
        user_agent="BusinessScoutAI/1.0",
        map_provider="osm",
        discovery_source="osm",
        max_businesses_per_job=200,
        crawl_website=True,
        respect_robots_txt=True,
        follow_sitemaps=True,
        request_delay_ms=0,
        use_ai_extraction=False,
        proxy_url=None,
        updated_at=datetime.now(UTC),
    )
    defaults.update(overrides)
    return CrawlSettings.model_validate(defaults)


def _discovered(name: str, *, website_url: str | None = "https://x.example") -> DiscoveredBusiness:
    return DiscoveredBusiness(
        osm_type="node", osm_id=name, name=name, latitude=1, longitude=1, website_url=website_url
    )


@pytest.fixture
def patched(monkeypatch: pytest.MonkeyPatch) -> dict[str, AsyncMock]:
    """Patches every external call pipeline.py makes; returns the mocks for assertions."""
    mocks: dict[str, AsyncMock] = {
        "get_crawl_settings": AsyncMock(return_value=_settings()),
        "discover": AsyncMock(return_value=[]),
        "enrich_website": AsyncMock(return_value=Tier1Result()),
        "upsert_discovered": AsyncMock(return_value=uuid4()),
        "needs_enrichment": AsyncMock(return_value=True),
        "apply_enrichment": AsyncMock(),
        "mark_enrichment_status": AsyncMock(),
        "mark_enrichment_failed": AsyncMock(),
        "write_log": AsyncMock(),
        "increment_counters": AsyncMock(),
        "set_current_business": AsyncMock(),
        "set_job_status": AsyncMock(),
        "finish_job": AsyncMock(),
        "release_job": AsyncMock(),
        "refresh_job": AsyncMock(return_value=_job()),
    }
    monkeypatch.setattr(pipeline, "get_crawl_settings", mocks["get_crawl_settings"])
    monkeypatch.setattr(pipeline, "discover", mocks["discover"])
    monkeypatch.setattr(pipeline, "enrich_website", mocks["enrich_website"])
    monkeypatch.setattr(dedupe, "upsert_discovered", mocks["upsert_discovered"])
    monkeypatch.setattr(dedupe, "needs_enrichment", mocks["needs_enrichment"])
    monkeypatch.setattr(dedupe, "apply_enrichment", mocks["apply_enrichment"])
    monkeypatch.setattr(dedupe, "mark_enrichment_status", mocks["mark_enrichment_status"])
    monkeypatch.setattr(dedupe, "mark_enrichment_failed", mocks["mark_enrichment_failed"])
    monkeypatch.setattr(job_queries, "write_log", mocks["write_log"])
    monkeypatch.setattr(job_queries, "increment_counters", mocks["increment_counters"])
    monkeypatch.setattr(job_queries, "set_current_business", mocks["set_current_business"])
    monkeypatch.setattr(job_queries, "set_job_status", mocks["set_job_status"])
    monkeypatch.setattr(job_queries, "finish_job", mocks["finish_job"])
    monkeypatch.setattr(job_queries, "release_job", mocks["release_job"])
    monkeypatch.setattr(job_queries, "refresh_job", mocks["refresh_job"])
    return mocks


@pytest.mark.asyncio
async def test_run_job_happy_path_completes(patched: dict[str, AsyncMock]) -> None:
    pool = FakePool()  # never touched directly, only passed through — a fixed sentinel per test
    job = _job()
    patched["discover"].return_value = [_discovered("A"), _discovered("B", website_url=None)]

    await pipeline.run_job(pool, job)

    patched["finish_job"].assert_awaited_once_with(pool, job.id, "completed")
    # A has a website -> enriched via Tier-1; B has none -> marked enriched directly (no site).
    assert patched["enrich_website"].await_count == 1
    patched["mark_enrichment_status"].assert_awaited_once()
    patched["increment_counters"].assert_any_await(pool, job.id, found=2)


@pytest.mark.asyncio
async def test_run_job_cancelled_before_any_business_reaches_cancelled_status(
    patched: dict[str, AsyncMock],
) -> None:
    pool = FakePool()
    job = _job()
    patched["discover"].return_value = [_discovered("A")]
    patched["refresh_job"].return_value = _job(cancel_requested=True)

    await pipeline.run_job(pool, job)

    patched["finish_job"].assert_awaited_once_with(pool, job.id, "cancelled")
    patched["upsert_discovered"].assert_not_awaited()  # never got to process the business


@pytest.mark.asyncio
async def test_run_job_pauses_then_resumes(
    patched: dict[str, AsyncMock], monkeypatch: pytest.MonkeyPatch
) -> None:
    pool = FakePool()
    job = _job()
    patched["discover"].return_value = [_discovered("A")]

    calls = {"n": 0}

    async def refresh_side_effect(_pool: object, _job_id: object) -> CrawlJob:
        calls["n"] += 1
        if calls["n"] == 1:
            return _job(pause_requested=True)
        return _job(pause_requested=False)

    patched["refresh_job"].side_effect = refresh_side_effect
    monkeypatch.setattr(pipeline, "PAUSE_POLL_SECONDS", 0)  # don't actually sleep in tests

    await pipeline.run_job(pool, job)

    patched["set_job_status"].assert_any_await(pool, job.id, "paused")
    patched["set_job_status"].assert_any_await(pool, job.id, "crawling")
    patched["finish_job"].assert_awaited_once_with(pool, job.id, "completed")


@pytest.mark.asyncio
async def test_run_job_enrichment_failure_does_not_abort_the_job(
    patched: dict[str, AsyncMock],
) -> None:
    pool = FakePool()
    job = _job()
    patched["discover"].return_value = [_discovered("A")]
    patched["enrich_website"].side_effect = RuntimeError("site is down")

    await pipeline.run_job(pool, job)

    patched["mark_enrichment_failed"].assert_awaited_once()
    patched["increment_counters"].assert_any_await(pool, job.id, failed=1)
    patched["finish_job"].assert_awaited_once_with(pool, job.id, "completed")


@pytest.mark.asyncio
async def test_run_job_skips_enrichment_for_already_fresh_business(
    patched: dict[str, AsyncMock],
) -> None:
    pool = FakePool()
    job = _job()
    patched["discover"].return_value = [_discovered("A")]
    patched["needs_enrichment"].return_value = False

    await pipeline.run_job(pool, job)

    patched["enrich_website"].assert_not_awaited()
    patched["mark_enrichment_status"].assert_not_awaited()  # has a website, just skipped
    patched["finish_job"].assert_awaited_once_with(pool, job.id, "completed")


@pytest.mark.asyncio
async def test_run_job_reaches_failed_status_on_unexpected_error(
    patched: dict[str, AsyncMock],
) -> None:
    pool = FakePool()
    job = _job()
    patched["discover"].side_effect = RuntimeError("overpass exploded")

    await pipeline.run_job(pool, job)

    await_args = patched["finish_job"].await_args
    assert await_args is not None
    args, _kwargs = await_args
    assert args[0] is pool
    assert args[2] == "failed"


@pytest.mark.asyncio
async def test_run_job_releases_claim_on_shutdown_instead_of_cancelling(
    patched: dict[str, AsyncMock],
) -> None:
    pool = FakePool()
    job = _job()
    patched["discover"].return_value = [_discovered("A")]
    shutdown_event = asyncio.Event()
    shutdown_event.set()

    await pipeline.run_job(pool, job, shutdown_event=shutdown_event)

    patched["release_job"].assert_awaited_once_with(pool, job.id)
    patched["finish_job"].assert_not_awaited()  # neither 'completed' nor 'cancelled'
    patched["upsert_discovered"].assert_not_awaited()  # never started processing the batch
