"""Authored by: Mohit Singh

Tier-2 enrichment — headless Chromium fallback, used ONLY when Tier-1's plain-HTTP fetch looks
JS-shelled (a near-empty body typical of a client-side-rendered SPA). See
md/plans/0001-*.md "P3 Enrichment cascade" — Tier-1 stays the default path; this module's only
job is producing a *better HTML source* for the same tier1.py extraction functions to parse, not
a separate extraction pipeline (DRY — one set of email/phone/social/image parsers, period).

One reused browser instance for the whole daemon process (launched lazily, closed once at
shutdown) — never one browser per page. Every page load blocks image/font/media/stylesheet
requests, since only the DOM/text content is needed.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from selectolax.parser import HTMLParser

if TYPE_CHECKING:
    from playwright.async_api import Browser, Route

BLOCKED_RESOURCE_TYPES = frozenset({"image", "font", "media", "stylesheet"})
JS_SHELL_MIN_TEXT_LENGTH = 200
JS_SHELL_ROOT_SELECTORS = ("#root", "#app", "#__next", "#___gatsby")
JS_SHELL_ROOT_MIN_TEXT_LENGTH = 20

_browser: Browser | None = None
_playwright_ctx: object | None = None


def looks_js_shelled(html: str) -> bool:
    """True when the fetched page reads like an empty SPA shell rather than real content —
    the signal to escalate to a real browser. A tiny overall body text is one signal; a
    near-empty *designated* SPA root div (`#root`/`#app`/...) is a stronger one, since some
    frameworks ship real boilerplate text elsewhere on an otherwise-empty page."""
    tree = HTMLParser(html)
    for node in tree.css("script, style, svg, noscript"):
        node.decompose()

    for selector in JS_SHELL_ROOT_SELECTORS:
        root = tree.css_first(selector)
        if root is not None:
            root_text = (root.text(separator=" ") or "").strip()
            if len(root_text) < JS_SHELL_ROOT_MIN_TEXT_LENGTH:
                return True

    body_text = (tree.body.text(separator=" ") if tree.body else tree.text(separator=" ")).strip()
    return len(body_text) < JS_SHELL_MIN_TEXT_LENGTH


async def _get_browser() -> Browser:
    global _browser, _playwright_ctx
    if _browser is None:
        from playwright.async_api import async_playwright

        _playwright_ctx = await async_playwright().start()
        _browser = await _playwright_ctx.chromium.launch(headless=True)
    return _browser


async def close_browser() -> None:
    """Call once at worker shutdown (main.py) — never per-request."""
    global _browser, _playwright_ctx
    if _browser is not None:
        await _browser.close()
        _browser = None
    if _playwright_ctx is not None:
        await _playwright_ctx.stop()  # type: ignore[attr-defined]
        _playwright_ctx = None


async def _block_heavy_resources(route: Route) -> None:
    if route.request.resource_type in BLOCKED_RESOURCE_TYPES:
        await route.abort()
    else:
        await route.continue_()


async def render_html(url: str, *, timeout_ms: int = 20000) -> str | None:
    """Best-effort — never raises. Returns None on any failure so the caller falls back to
    whatever Tier-1 already has rather than losing the business entirely over a Tier-2 hiccup."""
    try:
        browser = await _get_browser()
        context = await browser.new_context(java_script_enabled=True)
        try:
            page = await context.new_page()
            await page.route("**/*", _block_heavy_resources)
            await page.goto(url, timeout=timeout_ms, wait_until="networkidle")
            return await page.content()
        finally:
            await context.close()
    except Exception:  # noqa: BLE001 - a Tier-2 failure must never abort enrichment
        return None
