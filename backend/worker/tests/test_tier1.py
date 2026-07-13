"""Authored by: Mohit Singh"""

from __future__ import annotations

import httpx
import pytest

from business_scout_worker.enrich.tier1 import enrich_website

HOME_HTML = """
<html>
<head>
  <title>FitZone Berlin</title>
  <meta name="description" content="A great gym in Berlin.">
  <meta property="og:image" content="/images/hero.jpg">
  <style>.hero{width:0.494593px;margin:0-2-.6666667-3-2-3}</style>
</head>
<body>
  <nav>
    <a href="/">Home</a>
    <a href="/contact-us">Contact</a>
  </nav>
  <svg><path d="M10 12 35 35 0-2-.6666667-3-2-3"></path></svg>
  <script>var buildTimestamp = 1783498100; var range = "1998-2026";</script>
  <img src="/logo.png" alt="FitZone logo" class="site-logo">
  <img src="/images/gym-floor.jpg" alt="Gym floor">
  <a href="mailto:hello@fitzone.example">Email us</a>
  <a href="tel:+493012345678">Call us</a>
  <a href="https://www.facebook.com/fitzonebln">Facebook</a>
  <p>Or reach noreply@fitzone.example (do not use) or sentry.io tracking pixel.</p>
  <p>Founded 06.07.2015. Open 1998-2026. Call reception on 228847810 or +49 30 1234567.</p>
</body>
</html>
"""

CONTACT_HTML = """
<html>
<body>
  <p>Second phone: +49 30 9998877</p>
  <a href="mailto:support@fitzone.example">Support</a>
  <a href="https://instagram.com/fitzonebln">Instagram</a>
  <img src="/images/reception.jpg" alt="Reception desk">
</body>
</html>
"""


def _handler(request: httpx.Request) -> httpx.Response:
    path = request.url.path
    if path in ("/", ""):
        return httpx.Response(200, text=HOME_HTML, headers={"content-type": "text/html"})
    if path == "/contact-us":
        return httpx.Response(200, text=CONTACT_HTML, headers={"content-type": "text/html"})
    return httpx.Response(404)


@pytest.mark.asyncio
async def test_enrich_website_extracts_everything() -> None:
    client = httpx.AsyncClient(
        transport=httpx.MockTransport(_handler), base_url="https://fitzone.example"
    )
    result = await enrich_website("https://fitzone.example/", client=client)
    await client.aclose()

    assert result.website_title == "FitZone Berlin"
    assert result.meta_description == "A great gym in Berlin."
    assert result.contact_url == "https://fitzone.example/contact-us"

    assert "hello@fitzone.example" in result.emails
    assert "support@fitzone.example" in result.emails
    # denylisted junk must never appear
    assert "noreply@fitzone.example" not in result.emails
    assert not any("sentry.io" in e for e in result.emails)

    assert "+493012345678" in result.phones
    assert any("9998877" in p for p in result.phones)
    assert any("1234567" in p for p in result.phones)

    # Regression: a real crawl (business-scout-postgres, 2026-07-13) surfaced these exact
    # garbage shapes as "phones" when phones were regex-matched over raw HTML instead of
    # visible text — SVG path coordinates, CSS decimals, a <script> timestamp, a year range,
    # and a bare unformatted digit run. None of these are real phone numbers.
    for junk in ("0.494593", "0-2-.6666667-3-2-3", "1783498100", "1998-2026", "228847810"):
        assert junk not in result.phones, f"{junk!r} leaked into phones as a false positive"

    assert result.facebook == "https://www.facebook.com/fitzonebln"
    assert result.instagram == "https://instagram.com/fitzonebln"

    assert result.logo_url == "https://fitzone.example/logo.png"
    assert result.hero_image_url == "https://fitzone.example/images/hero.jpg"
    assert "https://fitzone.example/images/gym-floor.jpg" in result.image_urls
    assert "https://fitzone.example/images/reception.jpg" in result.image_urls


@pytest.mark.asyncio
async def test_enrich_website_handles_unreachable_site_gracefully() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await enrich_website("https://dead-site.example/", client=client)
    await client.aclose()

    assert result.emails == []
    assert result.phones == []
    assert result.website_title is None


@pytest.mark.asyncio
async def test_enrich_website_ignores_non_html_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, content=b"%PDF-1.4 not html", headers={"content-type": "application/pdf"}
        )

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await enrich_website("https://example.test/", client=client)
    await client.aclose()

    assert result.website_title is None
    assert result.emails == []


@pytest.mark.asyncio
async def test_enrich_website_ignores_oversized_response() -> None:
    huge_html = "<html><body>" + ("x" * 4_000_000) + "</body></html>"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text=huge_html, headers={"content-type": "text/html"})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    result = await enrich_website("https://huge-site.example/", client=client)
    await client.aclose()

    assert result.website_title is None
