"""Authored by: Mohit Singh

Stage A — capture engine. Drives a real Chromium (persistent context) to google.com/maps,
walks the results feed item by item, opens each business's detail panel, and screenshots it in
overlapping high-DPI segments (deviceScaleFactor 2 — the OCR-readability lever, never zoom out).
Keeps scrolling to lazy-load more until "You've reached the end of the list.", a cap, stagnation,
or a block. Writes manifest.json. See the OCR add-on spec §4 (A1-A8) and selectors.py.

Every result field the panel shows is captured as an image here; NO parsing happens in Stage A —
name + maps_url (from the DOM aria-label/href) are the only structured data captured, and they
anchor each row. OCR (Stage B) does the rest.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Awaitable, Callable
from pathlib import Path
from urllib.parse import quote

from playwright.async_api import (
    BrowserContext,
    ElementHandle,
    Page,
    ViewportSize,
    async_playwright,
)

from business_scout_worker.logging_config import get_logger
from business_scout_worker.ocr import humanize, selectors
from business_scout_worker.ocr.models import (
    CapturedItem,
    CaptureManifest,
    DomFields,
    OcrEndReason,
)
from business_scout_worker.settings import Settings

logger = get_logger(__name__)

# (captured_count, discovered_count, current_business_name) -> awaited by the capture loop so a
# failed progress write surfaces instead of being silently dropped.
ProgressCallback = Callable[[int, int, str | None], Awaitable[None]]

VIEWPORT: ViewportSize = {"width": 1680, "height": 1000}
# 2 segments (hero + info) cover the whole visible panel for the audit trail. Was 4, but now
# that the structured data comes from the DOM (exact) and OCR is only a fallback/visual record,
# more segments just add screenshot + OCR time for no data gain — the early-stop already ended
# most panels at 2 anyway. Bounds per-business OCR to 2 Tesseract calls.
MAX_SEGMENTS = 2
STAGNATION_ROUNDS = 3
# Panel-readiness polling: short slices up to ~1.5s total, returning as soon as it's ready.
PANEL_POLL_ATTEMPTS = 10
PANEL_POLL_INTERVAL_S = 0.15
# Hard ceiling for ONE business (navigate to place -> panel -> DOM extract -> screenshots).
# The place navigation alone can take ~10s on a cold profile, so this must comfortably exceed
# that — it's a stuck-listing backstop, NOT the normal per-item budget. A genuinely stuck item
# is abandoned here and the walk moves on immediately.
PER_BUSINESS_TIMEOUT_S = 30.0


class CaptureBlockedError(Exception):
    """Raised when Google serves a consent-loop / CAPTCHA / 'unusual traffic' wall. The caller
    marks the job 'blocked' and stops — we never try to solve it."""


class CaptureInterruptedError(Exception):
    """Raised when the daemon is shutting down mid-capture — checked between businesses so a
    graceful SIGTERM releases the job cleanly instead of leaving it stranded (the startup
    recovery sweep in ocr/jobs.py catches a hard kill that skips this)."""


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    return s[:40] or "business"


def _search_url(query: str, location: str) -> str:
    # Always an explicit location string, never "near me" (a server has no GPS — see §A2).
    term = quote(f"{query} near {location}")
    return f"https://www.google.com/maps/search/{term}?hl=en"


async def _is_blocked_fast(page: Page) -> bool:
    """Cheap block check for the per-business loop: URL + recaptcha selector only. Reading the
    whole page body text on every single business (the full check below) was a real, repeated
    per-item cost on a heavy Maps page — this keeps the hot path fast."""
    if "/sorry/" in page.url:
        return True
    return await page.query_selector(selectors.RECAPTCHA_IFRAME) is not None


async def _is_blocked(page: Page) -> bool:
    """Full check — includes the "unusual traffic" interstitial body text. Used at navigation
    (once per job), not per business."""
    if await _is_blocked_fast(page):
        return True
    body = (await page.inner_text("body")) if await page.query_selector("body") else ""
    return "unusual traffic" in body.lower()


async def _dismiss_consent(page: Page) -> None:
    try:
        btn = await page.query_selector(selectors.CONSENT_ACCEPT)
        if btn is not None:
            await btn.click()
            await humanize.dwell(600, 1200)
    except Exception as exc:  # noqa: BLE001 - consent is best-effort; absence is normal
        logger.debug("consent dismiss skipped", error=str(exc))


async def _collect_anchors(page: Page) -> list[tuple[str, str]]:
    """Returns [(href, name)] for every result card currently in the feed. Maps re-renders cards
    while scrolling, so the caller dedupes by href across rounds."""
    anchors = await page.query_selector_all(selectors.RESULT_ANCHOR_PRIMARY)
    if not anchors:
        anchors = await page.query_selector_all(selectors.RESULT_ANCHOR_FALLBACK)
    out: list[tuple[str, str]] = []
    for a in anchors:
        href = await a.get_attribute("href")
        name = await a.get_attribute("aria-label")
        if href and name and "/maps/place/" in href:
            out.append((href, name.strip()))
    return out


async def _place_panel(page: Page, expected_name: str) -> ElementHandle | None:
    """After navigating to a place href, wait for the place panel's h1 (the business name) and
    return the `role=main` panel container for screenshots. Polls in short slices so it returns
    the instant the place view is ready. Rejects the search view's "Results" heading — that
    means the navigation didn't land on the place."""
    exp = expected_name.lower()
    for attempt in range(PANEL_POLL_ATTEMPTS * 2):  # place nav can take a beat longer than a click
        h1 = await page.query_selector(selectors.DETAIL_TITLE)
        if h1 is not None:
            title = (await h1.inner_text()).strip().lower()
            if (
                title
                and title != "results"
                and (title in exp or exp in title or title[:12] == exp[:12])
            ):
                return await page.query_selector(selectors.DETAIL_PANEL) or h1
        if attempt < PANEL_POLL_ATTEMPTS * 2 - 1:
            await asyncio.sleep(PANEL_POLL_INTERVAL_S)
    return None


async def _extract_dom_fields(page: Page) -> DomFields:
    """Read the structured contact fields straight from the place-view DOM (authoritative, exact
    — no OCR). Queries the whole document (after navigation the page IS the place, and each
    contact button is unique): phone from the tel: data-item-id, website href, address/plus-code
    aria-labels, rating/reviews/category from their aria-labels/roles. Best-effort per field."""
    raw = await page.evaluate(
        """() => {
            const panel = document;
            const out = {};
            const q = (sel) => panel.querySelector(sel);

            // Phone: data-item-id="phone:tel:+919..." — the exact number, no OCR guesswork.
            const phoneEl = q('button[data-item-id^="phone:tel:"]');
            if (phoneEl) out.phone = phoneEl.getAttribute('data-item-id').replace('phone:tel:', '');

            // Website: the real destination URL (strip Google's redirect wrapper if present).
            const webEl = q('a[data-item-id="authority"]');
            if (webEl) out.website = webEl.getAttribute('href');

            // Address / plus code: aria-label is "Address: ..." / "Plus code: ...".
            const addrEl = q('button[data-item-id="address"]');
            if (addrEl) {
                out.address = (addrEl.getAttribute('aria-label') || '')
                    .replace(/^Address:\\s*/, '');
            }
            const plusEl = q('button[data-item-id^="oloc"]');
            if (plusEl) {
                out.plusCode = (plusEl.getAttribute('aria-label') || '')
                    .replace(/^Plus code:\\s*/, '');
            }

            // Rating + reviews: a role="img" whose aria-label reads "4.9 stars 47 reviews".
            const RE = /([0-5][.,]\\d)\\s*stars?\\s*([\\d,]+)\\s*review/i;
            for (const el of panel.querySelectorAll('[role="img"][aria-label]')) {
                const m = el.getAttribute('aria-label').match(RE);
                if (m) { out.rating = m[1]; out.reviewCount = m[2]; break; }
            }

            // Category: the button that fires the category-listing action (stable jsaction).
            const catEl = q('button[jsaction*="category"]');
            if (catEl) out.category = catEl.textContent.trim();

            // Hero photo: the header image button's <img src> (a real lh3.googleusercontent.com
            // URL, not a screenshot) — best-effort, absent on listings with no photos.
            const imgEl = q('button[aria-label^="Photo of"] img')
                || q('button[aria-label^="Photos of"] img');
            if (imgEl) out.imageUrl = imgEl.getAttribute('src');

            return out;
        }"""
    )
    fields = raw if isinstance(raw, dict) else {}

    def _to_float(v: object) -> float | None:
        try:
            return float(str(v).replace(",", ".")) if v is not None else None
        except (TypeError, ValueError):
            return None

    def _to_int(v: object) -> int | None:
        try:
            return int(re.sub(r"[^\d]", "", str(v))) if v is not None else None
        except (TypeError, ValueError):
            return None

    rating = _to_float(fields.get("rating"))
    return DomFields(
        phone=(fields.get("phone") or None),
        website=(fields.get("website") or None),
        address=(fields.get("address") or None),
        plus_code=(fields.get("plusCode") or None),
        rating=rating if rating is None or 1.0 <= rating <= 5.0 else None,
        review_count=_to_int(fields.get("reviewCount")),
        category=(fields.get("category") or None),
        image_url=(fields.get("imageUrl") or None),
    )


async def _panel_scroll_top(panel: ElementHandle) -> float:
    """Max scrollTop among the panel's scrollable descendants — the panel itself often isn't the
    scroll container, a nested div is, so we look across all of them rather than targeting one."""
    result = await panel.evaluate(
        """(el) => {
            let top = 0;
            for (const n of el.querySelectorAll('*')) {
                if (n.scrollHeight > n.clientHeight + 4) top = Math.max(top, n.scrollTop);
            }
            return top;
        }"""
    )
    return float(result)


async def _screenshot_segments(
    page: Page, panel: ElementHandle, raw_dir: Path, idx: int, name: str
) -> list[str]:
    """Screenshot the panel top-to-bottom in overlapping segments (20% overlap so no line is
    ever cut). Returns the relative image paths. Readability is entirely from deviceScaleFactor;
    never zoom the page out."""
    box = await panel.bounding_box()
    cx = (box["x"] + box["width"] / 2) if box else VIEWPORT["width"] * 0.25
    cy = (box["y"] + box["height"] / 2) if box else VIEWPORT["height"] * 0.5
    panel_h = box["height"] if box else 800.0

    # Force the panel to its top first.
    await humanize.wheel_over(page, cx, cy, -3000)
    await humanize.dwell(120, 200)

    slug = _slug(name)
    images: list[str] = []
    for seg in range(1, MAX_SEGMENTS + 1):
        rel = f"raw/{idx:03d}_{slug}_p{seg}.png"
        await panel.screenshot(path=str(raw_dir.parent / rel))
        images.append(rel)

        if seg == MAX_SEGMENTS:
            break
        # Scroll BEFORE deciding whether another segment is needed: if the scroll position
        # doesn't move, we're already at the bottom and the shot we just took was the last one.
        # (Checking after an unconditional screenshot — the previous version — always wasted one
        # extra screenshot + scroll + wait on the common 2-segment panel.)
        before = await _panel_scroll_top(panel)
        await humanize.wheel_over(page, cx, cy, panel_h * 0.8)
        await humanize.dwell(140, 220)  # let lazy content settle
        after = await _panel_scroll_top(panel)
        if abs(after - before) < 4:
            break
    return images


async def _expand_and_capture_hours(
    page: Page, panel: ElementHandle, raw_dir: Path, idx: int, name: str
) -> str | None:
    """Optional (§A5.5): click the hours row, capture the weekly table as pH, collapse. Best-
    effort — returns the image path or None."""
    try:
        row = await panel.query_selector(
            '*:has-text("Open"), *:has-text("Closed"), *:has-text("Hours")'
        )
        if row is None:
            return None
        await row.click()
        await humanize.dwell(500, 800)
        rel = f"raw/{idx:03d}_{_slug(name)}_pH.png"
        await panel.screenshot(path=str(raw_dir.parent / rel))
        await page.keyboard.press("Escape")
        return rel
    except Exception as exc:  # noqa: BLE001 - hours expansion is optional, never fatal
        logger.debug("hours expand skipped", name=name, error=str(exc))
        return None


class CaptureEngine:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings

    async def run(
        self,
        *,
        query: str,
        location: str,
        max_results: int,
        expand_hours: bool,
        job_id: str,
        job_dir: Path,
        started_at: str,
        on_progress: ProgressCallback | None = None,
        should_stop: object = None,
    ) -> CaptureManifest:
        raw_dir = job_dir / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)
        profile_dir = Path(self._settings.ocr_captures_dir) / ".profile"
        profile_dir.mkdir(parents=True, exist_ok=True)

        items: list[CapturedItem] = []
        end_reason: OcrEndReason = "end_of_list"

        async with async_playwright() as p:
            context: BrowserContext = await p.chromium.launch_persistent_context(
                user_data_dir=str(profile_dir),
                headless=self._settings.ocr_crawl_headless,
                viewport=VIEWPORT,
                device_scale_factor=self._settings.ocr_device_scale,
                locale="en-US",
                args=["--disable-dev-shm-usage", "--no-sandbox"],
            )
            # Two pages: the FEED page stays on the search results (for collecting hrefs +
            # scrolling to lazy-load), and a separate DETAIL page navigates to each place URL.
            # This preserves the "keep the list open, open each business one by one" model —
            # navigating the feed page itself to a place would destroy the list we're walking.
            page = context.pages[0] if context.pages else await context.new_page()
            page.set_default_timeout(self._settings.ocr_nav_timeout_ms)
            detail_page = await context.new_page()
            detail_page.set_default_timeout(self._settings.ocr_nav_timeout_ms)
            try:
                await page.goto(_search_url(query, location), wait_until="domcontentloaded")
                await _dismiss_consent(page)
                if await _is_blocked(page):
                    await page.screenshot(path=str(job_dir / "debug_blocked.png"))
                    raise CaptureBlockedError("blocked at navigation")

                await page.wait_for_selector(
                    selectors.RESULTS_FEED, timeout=self._settings.ocr_nav_timeout_ms
                )

                seen: dict[str, str] = {}
                stagnation = 0
                while len(items) < max_results:
                    anchors = await _collect_anchors(page)
                    new = [(h, n) for (h, n) in anchors if h not in seen]

                    if not new:
                        # Nothing new in view — try to load more, or stop.
                        feed = await page.query_selector(selectors.RESULTS_FEED)
                        feed_text = (await feed.inner_text()) if feed else ""
                        if selectors.END_OF_LIST_TEXT in feed_text:
                            end_reason = "end_of_list"
                            break
                        stagnation += 1
                        if stagnation >= STAGNATION_ROUNDS:
                            end_reason = "stagnation"
                            break
                        # Scroll the feed to lazy-load the next batch.
                        box = await feed.bounding_box() if feed else None
                        fx = (box["x"] + box["width"] / 2) if box else VIEWPORT["width"] * 0.2
                        fy = (box["y"] + box["height"] / 2) if box else VIEWPORT["height"] * 0.5
                        for _ in range(3):
                            await humanize.wheel_over(page, fx, fy, 900)
                            await humanize.dwell(180, 300)
                        await humanize.dwell(400, 650)
                        continue

                    stagnation = 0
                    for href, name in new:
                        if callable(should_stop) and should_stop():
                            raise CaptureInterruptedError
                        if len(items) >= max_results:
                            end_reason = "max_results"
                            break
                        seen[href] = name
                        # Denominator is the TARGET (max_results), not the number of anchors
                        # discovered so far — Google lazy-loads ~7 cards at a time, so len(seen)
                        # would race ahead of what's actually being processed and looked like the
                        # tool "computes the total first". The pipeline corrects total to the real
                        # captured count once capture finishes (e.g. if the list ends early).
                        # Report BEFORE the (slow) capture so the UI names the business actually
                        # being worked on right now, not the previous one.
                        if on_progress is not None:
                            await on_progress(len(items), max_results, name)
                        # Hard per-business ceiling: a listing whose panel never settles (dead
                        # click, endless spinner, DOM variant we don't recognize) must not stall
                        # the whole run. Abandon it and move to the next one immediately — the
                        # inner retries/waits are all well under this, so hitting it means the
                        # item is genuinely stuck, not merely slow.
                        try:
                            captured = await asyncio.wait_for(
                                self._capture_one(
                                    detail_page, raw_dir, len(items) + 1, name, href, expand_hours
                                ),
                                timeout=PER_BUSINESS_TIMEOUT_S,
                            )
                        except TimeoutError:
                            logger.info("skip: capture timed out", name=name)
                            captured = None
                        if captured is not None:
                            items.append(captured)
                            if on_progress is not None:
                                await on_progress(len(items), max_results, name)
                        # Between-business pacing. Kept randomized (never a fixed metronome
                        # interval — that's the obvious bot signature) but trimmed: this was the
                        # single largest contributor to per-item cost. See the README's tuning note.
                        await humanize.dwell(280, 620)
                        if await _is_blocked_fast(page):
                            raise CaptureBlockedError("blocked mid-walk")

                    if len(items) >= max_results:
                        end_reason = "max_results"
                        break
            finally:
                await context.close()

        manifest = CaptureManifest(
            job_id=job_id,
            query=query,
            location=location,
            started_at=started_at,
            end_reason=end_reason,
            items=items,
        )
        (job_dir / "manifest.json").write_text(
            json.dumps(manifest.model_dump(), indent=2), encoding="utf-8"
        )
        return manifest

    async def _capture_one(
        self,
        page: Page,
        raw_dir: Path,
        index: int,
        name: str,
        href: str,
        expand_hours: bool,
    ) -> CapturedItem | None:
        """Open one business by NAVIGATING to its place href (each result <a>'s href is the
        canonical place URL) and screenshot the panel. Verified live (2026-07): a programmatic
        click on a Maps result card does NOT reliably open the detail panel on the current Maps
        DOM — every click timed out with only the feed's role=main present. `page.goto(href)`
        opens the place panel directly, exposes the data-item-id contact buttons, and is both
        more robust and faster (no click/panel-poll retries). Best-effort: any failure -> skip."""
        try:
            await page.goto(
                href + ("&hl=en" if "?" in href else "?hl=en"), wait_until="domcontentloaded"
            )
            # The place panel's title is a plain h1 (the feed is gone now — this is the place view).
            panel = await _place_panel(page, name)
            if panel is None:
                logger.info("skip: panel not found", name=name)
                return None
            # Authoritative DOM fields (phone/website/address/…) — the accurate, fast source for
            # the data we care about; screenshots are the audit trail + OCR fallback.
            dom = await _extract_dom_fields(page)
            images = await _screenshot_segments(page, panel, raw_dir, index, name)
            if expand_hours:
                hours_img = await _expand_and_capture_hours(page, panel, raw_dir, index, name)
                if hours_img is not None:
                    images.append(hours_img)
            return CapturedItem(index=index, name=name, maps_url=href, images=images, dom=dom)
        except Exception as exc:  # noqa: BLE001 - one listing failing must not abort the job
            logger.info("skip: capture error", name=name, error=str(exc))
            return None
