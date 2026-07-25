"""Authored by: Mohit Singh

Crawl politeness — robots.txt honoring, per-domain rate limiting, and retry caps, all driven
by `crawl_settings` (`respect_robots_txt`, `request_delay_ms`, `retry_count`). See
md/plans/0001-*.md Phase 4. Module-level state (robots cache, last-request-per-domain) is
process-lifetime, shared across every `enrich_website` call in this worker daemon — that's
deliberate: robots.txt rarely changes within a crawl's lifetime, and rate limiting is only
meaningful if it's tracked across calls, not reset per-request.
"""

from __future__ import annotations

import asyncio
import time
import urllib.robotparser
from urllib.parse import urlparse

import httpx

ROBOTS_FETCH_TIMEOUT_SECONDS = 5.0

_robots_cache: dict[str, urllib.robotparser.RobotFileParser] = {}
_last_request_at: dict[str, float] = {}
_domain_locks: dict[str, asyncio.Lock] = {}


def _domain_of(url: str) -> str:
    return urlparse(url).netloc.lower()


async def is_allowed_by_robots(
    client: httpx.AsyncClient, url: str, user_agent: str, *, enabled: bool = True
) -> bool:
    """Fail-open: if robots.txt can't be fetched at all (404, timeout, unreachable domain),
    the path is treated as allowed — a missing/broken robots.txt is not a disallow signal, and
    a crawler that fails-closed on every fetch error would silently skip huge swaths of the
    web for no real reason. `enabled=False` (crawl_settings.respect_robots_txt) skips the
    check entirely."""
    if not enabled:
        return True

    domain = _domain_of(url)
    parser = _robots_cache.get(domain)
    if parser is None:
        parser = urllib.robotparser.RobotFileParser()
        robots_url = f"{urlparse(url).scheme}://{domain}/robots.txt"
        try:
            resp = await client.get(
                robots_url,
                timeout=ROBOTS_FETCH_TIMEOUT_SECONDS,
                headers={"User-Agent": user_agent},
            )
            if resp.status_code < 400:
                parser.parse(resp.text.splitlines())
            else:
                parser.parse([])  # no robots.txt -> everything allowed
        except httpx.HTTPError:
            parser.parse([])  # unreachable -> fail open, see docstring
        _robots_cache[domain] = parser

    return parser.can_fetch(user_agent, url)


async def wait_for_rate_limit(url: str, delay_ms: int) -> None:
    """Enforces a minimum gap between consecutive requests to the SAME domain — never a global
    delay (unrelated domains fetch concurrently without waiting on each other). A per-domain
    `asyncio.Lock` prevents two concurrent requests to the same domain (e.g. homepage + a
    contact page fetched back-to-back in the same enrichment) from both reading a stale
    "last request time" and skipping the wait."""
    if delay_ms <= 0:
        return
    domain = _domain_of(url)
    lock = _domain_locks.setdefault(domain, asyncio.Lock())
    async with lock:
        last = _last_request_at.get(domain)
        now = time.monotonic()
        if last is not None:
            elapsed_ms = (now - last) * 1000
            remaining_ms = delay_ms - elapsed_ms
            if remaining_ms > 0:
                await asyncio.sleep(remaining_ms / 1000)
        _last_request_at[domain] = time.monotonic()


async def get_with_retries(
    client: httpx.AsyncClient, url: str, *, timeout_s: float, retry_count: int
) -> httpx.Response:
    """`retry_count` extra attempts after the first (so retry_count=0 means exactly one try,
    matching `crawl_settings.retry_count`'s meaning elsewhere in this codebase — see
    discovery/overpass.py). No backoff sleep between attempts beyond the rate limiter's own
    per-domain spacing — a full exponential-backoff retry policy is Overpass-only territory
    (a single shared API endpoint); a business website getting hit 2-3x by our own retries in
    quick succession is a normal, expected crawl pattern, not something to apologize for."""
    attempts = retry_count + 1
    for attempt in range(attempts):
        try:
            return await client.get(url, timeout=timeout_s, follow_redirects=True)
        except httpx.HTTPError:
            if attempt == attempts - 1:
                raise
    raise RuntimeError("get_with_retries: unreachable — loop always returns or raises")
