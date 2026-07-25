"""Authored by: Mohit Singh"""

from __future__ import annotations

import time

import httpx
import pytest

from business_scout_worker.enrich import policy

pytestmark = pytest.mark.asyncio


async def test_is_allowed_by_robots_respects_disallow() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="User-agent: *\nDisallow: /private/\n")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    policy._robots_cache.clear()

    allowed_public = await policy.is_allowed_by_robots(
        client, "https://robots-a.example/about", "BusinessScoutAI/1.0"
    )
    allowed_private = await policy.is_allowed_by_robots(
        client, "https://robots-a.example/private/secret", "BusinessScoutAI/1.0"
    )
    await client.aclose()

    assert allowed_public is True
    assert allowed_private is False


async def test_is_allowed_by_robots_fails_open_when_robots_txt_missing() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(404)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    policy._robots_cache.clear()

    allowed = await policy.is_allowed_by_robots(
        client, "https://robots-b.example/anything", "BusinessScoutAI/1.0"
    )
    await client.aclose()

    assert allowed is True


async def test_is_allowed_by_robots_fails_open_on_network_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    policy._robots_cache.clear()

    allowed = await policy.is_allowed_by_robots(
        client, "https://robots-c.example/anything", "BusinessScoutAI/1.0"
    )
    await client.aclose()

    assert allowed is True


async def test_is_allowed_by_robots_skipped_when_disabled() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="User-agent: *\nDisallow: /\n")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    policy._robots_cache.clear()

    allowed = await policy.is_allowed_by_robots(
        client, "https://robots-d.example/anything", "BusinessScoutAI/1.0", enabled=False
    )
    await client.aclose()

    assert allowed is True


async def test_wait_for_rate_limit_delays_second_request_to_same_domain() -> None:
    policy._last_request_at.clear()
    policy._domain_locks.clear()
    domain_url = "https://rate-a.example/"

    start = time.monotonic()
    await policy.wait_for_rate_limit(domain_url, 200)  # first call — no wait
    await policy.wait_for_rate_limit(domain_url, 200)  # second call — must wait ~200ms
    elapsed = time.monotonic() - start

    assert elapsed >= 0.18  # allow a little scheduling slack


async def test_wait_for_rate_limit_does_not_delay_different_domains() -> None:
    policy._last_request_at.clear()
    policy._domain_locks.clear()

    start = time.monotonic()
    await policy.wait_for_rate_limit("https://rate-b.example/", 500)
    await policy.wait_for_rate_limit("https://rate-c.example/", 500)
    elapsed = time.monotonic() - start

    assert elapsed < 0.1  # unrelated domains never wait on each other


async def test_wait_for_rate_limit_noop_when_delay_zero() -> None:
    policy._last_request_at.clear()
    policy._domain_locks.clear()
    url = "https://rate-d.example/"

    start = time.monotonic()
    await policy.wait_for_rate_limit(url, 0)
    await policy.wait_for_rate_limit(url, 0)
    elapsed = time.monotonic() - start

    assert elapsed < 0.05


async def test_get_with_retries_succeeds_on_first_try() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, text="ok")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    resp = await policy.get_with_retries(
        client, "https://retry-a.example/", timeout_s=5, retry_count=2
    )
    await client.aclose()

    assert resp.status_code == 200
    assert calls["n"] == 1


async def test_get_with_retries_retries_up_to_retry_count_then_raises() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        raise httpx.ConnectError("refused", request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(httpx.ConnectError):
        await policy.get_with_retries(
            client, "https://retry-b.example/", timeout_s=5, retry_count=2
        )
    await client.aclose()

    assert calls["n"] == 3  # 1 initial attempt + 2 retries


async def test_get_with_retries_succeeds_after_transient_failures() -> None:
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] < 3:
            raise httpx.ConnectError("refused", request=request)
        return httpx.Response(200, text="ok")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    resp = await policy.get_with_retries(
        client, "https://retry-c.example/", timeout_s=5, retry_count=5
    )
    await client.aclose()

    assert resp.status_code == 200
    assert calls["n"] == 3
