"""Authored by: Mohit Singh"""

from __future__ import annotations

import sys
from unittest.mock import AsyncMock

import httpx
import pytest

from business_scout_worker.enrich import tier1, tier2

SPA_SHELL_HTML = """
<html>
<head><title>MyApp</title></head>
<body>
  <div id="root"></div>
  <script src="/bundle.js"></script>
</body>
</html>
"""

REAL_CONTENT_HTML = """
<html>
<head><title>FitZone Berlin</title></head>
<body>
  <p>FitZone is a full-service gym in central Berlin offering strength training, group
  classes, and personal coaching. Visit us at 12 Hauptstrasse or call ahead to book a tour.
  Our friendly staff are available every day of the week to help you get started.</p>
</body>
</html>
"""


def test_looks_js_shelled_detects_empty_spa_root() -> None:
    assert tier2.looks_js_shelled(SPA_SHELL_HTML) is True


def test_looks_js_shelled_false_for_real_content() -> None:
    assert tier2.looks_js_shelled(REAL_CONTENT_HTML) is False


def test_looks_js_shelled_ignores_script_and_style_bulk() -> None:
    # A big <script>/<style> payload must not count as "real content" just because it's long.
    html = f"""
    <html><body>
      <div id="app"></div>
      <script>{"var x = 1;" * 500}</script>
      <style>{".a{color:red}" * 500}</style>
    </body></html>
    """
    assert tier2.looks_js_shelled(html) is True


@pytest.mark.asyncio
async def test_enrich_website_escalates_to_tier2_on_js_shell(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=SPA_SHELL_HTML, headers={"content-type": "text/html"})

    render_mock = AsyncMock(return_value=REAL_CONTENT_HTML)
    monkeypatch.setattr(tier2, "render_html", render_mock)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await tier1.enrich_website("https://spa.example/", client=client, use_tier2=True)
    await client.aclose()

    render_mock.assert_awaited_once()
    assert result.website_title == "FitZone Berlin"  # came from the Tier-2-rendered HTML
    assert result.used_tier2 is True  # Phase 8's tier-hit-ratio metric relies on this flag


@pytest.mark.asyncio
async def test_enrich_website_skips_tier2_when_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=SPA_SHELL_HTML, headers={"content-type": "text/html"})

    render_mock = AsyncMock(return_value=REAL_CONTENT_HTML)
    monkeypatch.setattr(tier2, "render_html", render_mock)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await tier1.enrich_website("https://spa.example/", client=client, use_tier2=False)
    await client.aclose()

    render_mock.assert_not_awaited()
    assert result.website_title == "MyApp"  # stuck with the Tier-1 (shell) HTML
    assert result.used_tier2 is False


@pytest.mark.asyncio
async def test_enrich_website_keeps_tier1_html_if_tier2_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=SPA_SHELL_HTML, headers={"content-type": "text/html"})

    render_mock = AsyncMock(return_value=None)  # Tier-2 failed
    monkeypatch.setattr(tier2, "render_html", render_mock)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await tier1.enrich_website("https://spa.example/", client=client, use_tier2=True)
    await client.aclose()

    render_mock.assert_awaited_once()
    assert result.website_title == "MyApp"  # fell back to what Tier-1 already had
    assert result.used_tier2 is False  # a failed render must not count as a tier2 "hit"


@pytest.mark.skipif(
    sys.platform == "win32",
    reason=(
        "Playwright's subprocess-launched Chromium requires ProactorEventLoop on Windows, "
        "which directly conflicts with psycopg3's requirement for SelectorEventLoop (set "
        "process-wide in conftest.py for the DB-touching tests) — the two cannot coexist in "
        "one asyncio loop policy. Real, structural, Windows-only; irrelevant in the Linux "
        "Docker container this daemon actually deploys to. See skills_backend_python.md."
    ),
)
@pytest.mark.asyncio
async def test_render_html_real_browser_launches_and_renders() -> None:
    """A real (local, not network) Chromium launch — proves the browser + resource-blocking
    setup actually works, without depending on any external site being reachable."""
    try:
        html = await tier2.render_html("data:text/html,<html><body><h1>Hi</h1></body></html>")
    finally:
        await tier2.close_browser()

    assert html is not None
    assert "Hi" in html
