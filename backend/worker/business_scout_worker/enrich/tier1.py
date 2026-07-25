"""Authored by: Mohit Singh

Tier-1 enrichment — plain HTTP fetch + parse (no headless browser; that's Tier-2, Phase 4,
escalated only when a page looks JS-shelled). Fetches the homepage, discovers contact/about/team
pages from actual nav links (never blind-guesses `/contact`), and extracts emails/phones/socials/
images from all of them combined. See md/plans/0001-*.md "P3 Enrichment" and
.claude/skills/skills_security.md's PII-handling note.
"""

from __future__ import annotations

import re
from urllib.parse import urljoin, urlparse

import httpx
from selectolax.parser import HTMLParser

from business_scout_worker.enrich import policy, tier2
from business_scout_worker.enrich.models import Tier1Result

MAX_RESPONSE_BYTES = 3_000_000  # guard against being fed a huge/malicious response body
MAX_CONTACT_PAGES = 3
MAX_REDIRECTS = 5

# Junk matches that look like emails/text but aren't real contact addresses — tracking pixels,
# placeholder/example domains, retina asset filenames, etc. See skills_security.md.
EMAIL_DENYLIST_DOMAINS = {"sentry.io", "wixpress.com", "example.com", "example.org", "w3.org"}
EMAIL_DENYLIST_PATTERNS = (
    re.compile(r"noreply@", re.I),
    re.compile(r"@2x\.(png|jpg|jpeg|webp)$", re.I),
)

EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}")
# Digit groups joined by a MANDATORY space/dash/parens separator — deliberately excludes bare
# contiguous digit runs (timestamps, ids) and anything containing a "." (decimals, dates,
# version numbers, SVG path coordinates). Verified against a real crawl: the previous looser
# regex (scanning raw HTML, allowing "." as a separator) matched SVG `d=""` path fragments,
# CSS pixel values and DD.MM.YYYY dates as "phones". Real validation/normalization is Phase 4
# (the `phonenumbers` library) — this is a precision-over-recall heuristic for Tier-1 only.
PHONE_RE = re.compile(r"(?<!\w)(\+\d{1,3}[\s\-]?)?\(?\d{2,8}\)?(?:[\s\-]\d{2,8}){1,5}(?!\w)")
YEAR_RANGE_RE = re.compile(r"^(19|20)\d{2}[\s\-](19|20)\d{2}$")
NOISE_TAG_SELECTOR = "script, style, svg, noscript"

CONTACT_LINK_KEYWORDS = ("contact", "about", "team", "impressum", "kontakt", "über-uns", "reach-us")

SOCIAL_DOMAIN_MAP: dict[str, str] = {
    "facebook.com": "facebook",
    "instagram.com": "instagram",
    "linkedin.com": "linkedin",
    "youtube.com": "youtube",
    "youtu.be": "youtube",
    "twitter.com": "twitter",
    "x.com": "twitter",
    "wa.me": "whatsapp",
}


def _is_denylisted_email(email: str) -> bool:
    domain = email.split("@")[-1].lower()
    if domain in EMAIL_DENYLIST_DOMAINS:
        return True
    return any(p.search(email) for p in EMAIL_DENYLIST_PATTERNS)


def _strip_noise_and_get_text(tree: HTMLParser) -> str:
    """Removes script/style/svg/noscript nodes (in place) before reading text — otherwise JS
    variable values, CSS numeric literals and SVG path coordinates leak into `.text()` and
    produce phone/email false positives. See PHONE_RE's comment for the real crawl that
    surfaced this."""
    for node in tree.css(NOISE_TAG_SELECTOR):
        node.decompose()
    return tree.body.text(separator=" ") if tree.body else tree.text(separator=" ")


def _extract_emails(text: str, tree: HTMLParser) -> set[str]:
    found: set[str] = set()
    for a in tree.css("a[href^='mailto:']"):
        href = a.attributes.get("href") or ""
        addr = href.removeprefix("mailto:").split("?")[0].strip()
        if addr:
            found.add(addr)
    found.update(EMAIL_RE.findall(text))
    return {e.lower() for e in found if not _is_denylisted_email(e)}


def _extract_phones(text: str, tree: HTMLParser) -> set[str]:
    found: set[str] = set()
    for a in tree.css("a[href^='tel:']"):
        href = a.attributes.get("href") or ""
        num = href.removeprefix("tel:").strip()
        if num:
            found.add(num)
    for match in PHONE_RE.finditer(text):
        cleaned = match.group(0).strip()
        digit_count = sum(c.isdigit() for c in cleaned)
        if not (8 <= digit_count <= 15):
            continue
        if YEAR_RANGE_RE.match(cleaned):
            continue
        found.add(cleaned)
    return found


def _extract_socials(tree: HTMLParser, base_url: str) -> dict[str, str]:
    socials: dict[str, str] = {}
    for a in tree.css("a[href]"):
        href = a.attributes.get("href") or ""
        if not href:
            continue
        absolute = urljoin(base_url, href)
        host = urlparse(absolute).netloc.lower().removeprefix("www.")
        platform = SOCIAL_DOMAIN_MAP.get(host)
        if platform and platform not in socials:
            socials[platform] = absolute
    return socials


def _extract_images(tree: HTMLParser, base_url: str) -> tuple[str | None, str | None, list[str]]:
    logo_url: str | None = None
    hero_url: str | None = None
    others: list[str] = []

    og_image = tree.css_first("meta[property='og:image']")
    if og_image and og_image.attributes.get("content"):
        hero_url = urljoin(base_url, og_image.attributes["content"])

    for img in tree.css("img[src]"):
        src = img.attributes.get("src") or ""
        if not src or src.startswith("data:"):
            continue
        absolute = urljoin(base_url, src)
        alt = (img.attributes.get("alt") or "").lower()
        cls = (img.attributes.get("class") or "").lower()
        if logo_url is None and ("logo" in alt or "logo" in cls):
            logo_url = absolute
            continue
        if absolute != hero_url and absolute not in others:
            others.append(absolute)
        if len(others) >= 10:
            break

    return logo_url, hero_url, others


def _find_contact_links(tree: HTMLParser, base_url: str) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()
    nav_scopes = tree.css("nav a[href], header a[href], footer a[href]") or tree.css("a[href]")
    for a in nav_scopes:
        href = a.attributes.get("href") or ""
        text = (a.text() or "").lower()
        if not href or href.startswith(("mailto:", "tel:", "#", "javascript:")):
            continue
        haystack = f"{href.lower()} {text}"
        if any(keyword in haystack for keyword in CONTACT_LINK_KEYWORDS):
            absolute = urljoin(base_url, href)
            if urlparse(absolute).netloc == urlparse(base_url).netloc and absolute not in seen:
                seen.add(absolute)
                links.append(absolute)
        if len(links) >= MAX_CONTACT_PAGES:
            break
    return links


async def _fetch(
    client: httpx.AsyncClient,
    url: str,
    timeout_s: float,
    *,
    user_agent: str,
    respect_robots_txt: bool,
    request_delay_ms: int,
    retry_count: int,
) -> str | None:
    if not await policy.is_allowed_by_robots(client, url, user_agent, enabled=respect_robots_txt):
        return None
    await policy.wait_for_rate_limit(url, request_delay_ms)
    try:
        resp = await policy.get_with_retries(
            client, url, timeout_s=timeout_s, retry_count=retry_count
        )
    except httpx.HTTPError:
        return None
    if resp.status_code >= 400:
        return None
    content_type = resp.headers.get("content-type", "")
    if "html" not in content_type and content_type != "":
        return None
    if len(resp.content) > MAX_RESPONSE_BYTES:
        return None
    return resp.text


async def enrich_website(
    website_url: str,
    *,
    user_agent: str = "BusinessScoutAI/1.0",
    timeout_ms: int = 15000,
    client: httpx.AsyncClient | None = None,
    use_tier2: bool = True,
    respect_robots_txt: bool = True,
    request_delay_ms: int = 0,
    retry_count: int = 0,
    proxy_url: str | None = None,
) -> Tier1Result:
    """Best-effort — never raises. A site that's down/unreachable/non-HTML yields an
    empty-but-valid Tier1Result rather than blocking the pipeline.

    `use_tier2=False` is for tests — it disables the real-browser escalation so a mocked
    fixture that happens to look JS-shelled never tries to launch Chromium. All of
    `respect_robots_txt`/`request_delay_ms`/`retry_count`/`proxy_url` mirror the matching
    `crawl_settings` columns 1:1 — see `enrich/policy.py`."""
    owns_client = client is None
    client = client or httpx.AsyncClient(
        headers={"User-Agent": user_agent}, max_redirects=MAX_REDIRECTS, proxy=proxy_url
    )
    timeout_s = timeout_ms / 1000

    try:
        home_html = await _fetch(
            client,
            website_url,
            timeout_s,
            user_agent=user_agent,
            respect_robots_txt=respect_robots_txt,
            request_delay_ms=request_delay_ms,
            retry_count=retry_count,
        )
        if home_html is None:
            return Tier1Result()

        used_tier2 = False
        if use_tier2 and tier2.looks_js_shelled(home_html):
            rendered = await tier2.render_html(website_url, timeout_ms=timeout_ms)
            if rendered is not None:
                home_html = rendered
                used_tier2 = True

        home_tree = HTMLParser(home_html)
        home_text = _strip_noise_and_get_text(home_tree)
        emails = _extract_emails(home_text, home_tree)
        phones = _extract_phones(home_text, home_tree)
        socials = _extract_socials(home_tree, website_url)
        logo_url, hero_url, images = _extract_images(home_tree, website_url)

        title_node = home_tree.css_first("title")
        title = title_node.text().strip() if title_node and title_node.text() else None
        desc_node = home_tree.css_first("meta[name='description']")
        description = desc_node.attributes.get("content") if desc_node else None
        keywords_node = home_tree.css_first("meta[name='keywords']")
        keywords = keywords_node.attributes.get("content") if keywords_node else None

        contact_links = _find_contact_links(home_tree, website_url)
        contact_url = contact_links[0] if contact_links else None
        combined_text_parts = [home_text]

        for link in contact_links:
            page_html = await _fetch(
                client,
                link,
                timeout_s,
                user_agent=user_agent,
                respect_robots_txt=respect_robots_txt,
                request_delay_ms=request_delay_ms,
                retry_count=retry_count,
            )
            if page_html is None:
                continue
            page_tree = HTMLParser(page_html)
            page_text = _strip_noise_and_get_text(page_tree)
            combined_text_parts.append(page_text)
            emails |= _extract_emails(page_text, page_tree)
            phones |= _extract_phones(page_text, page_tree)
            for platform, url in _extract_socials(page_tree, link).items():
                socials.setdefault(platform, url)
            _, _, more_images = _extract_images(page_tree, link)
            for img in more_images:
                if img not in images and len(images) < 10:
                    images.append(img)

        return Tier1Result(
            website_title=title,
            meta_description=description,
            meta_keywords=keywords,
            about_text=description,
            contact_url=contact_url,
            emails=sorted(emails),
            phones=sorted(phones),
            facebook=socials.get("facebook"),
            instagram=socials.get("instagram"),
            linkedin=socials.get("linkedin"),
            youtube=socials.get("youtube"),
            twitter=socials.get("twitter"),
            whatsapp=socials.get("whatsapp"),
            logo_url=logo_url,
            hero_image_url=hero_url,
            image_urls=images,
            page_text=" ".join(combined_text_parts),
            used_tier2=used_tier2,
        )
    finally:
        if owns_client:
            await client.aclose()
