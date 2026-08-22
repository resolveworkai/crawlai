"""Authored by: Mohit Singh

Stage A — capture engine for the Property Research pipeline. Playwright-driven, platform-adapter-
agnostic. Walks search-result pages up to `max_pages` (the job's own page-count limit — every
platform here paginates via `?page=N`, confirmed live for both dubizzle and propertyfinder), and
for every listing not yet seen: reads whatever the card DOM exposes, screenshots the card for the
OCR-fallback + visual audit trail, and checkpoints a manifest to disk after every listing so a
crashed/retried job resumes without re-capturing. Mirrors ecom/capture.py's shape (persistent CDP
attach, humanized dwell, stagnation stop, incremental manifest checkpoint, the promo-tile dedup fix
and the animations-disabled screenshot retry both learned live on 2026-08-22) but is SEPARATE
code — nothing here imports from or is imported by ocr/ or ecom/'s capture engines.

Bathroom filtering: neither platform's server-side `bathrooms=`/`bathf=` URL param is confirmed to
actually narrow results (see the adapters' own docstrings) — this engine applies a CLIENT-SIDE
floor (skip any captured listing whose parsed bathroom count is below the job's requested minimum)
so the filter is enforced correctly regardless of whether the site's own param works.
"""

from __future__ import annotations

import contextlib
import json
import re
from collections.abc import Awaitable, Callable
from pathlib import Path

from playwright.async_api import (
    Browser,
    BrowserContext,
    ElementHandle,
    Page,
    Playwright,
    ViewportSize,
    async_playwright,
)

from business_scout_worker.logging_config import get_logger
from business_scout_worker.ocr import humanize
from business_scout_worker.property.adapters.base import PlatformAdapter, SearchFilters
from business_scout_worker.property.models import (
    CapturedListing,
    PropertyEndReason,
    PropertyManifest,
)
from business_scout_worker.settings import Settings

logger = get_logger(__name__)

ProgressCallback = Callable[[int, int, str | None], Awaitable[None]]

VIEWPORT: ViewportSize = {"width": 1440, "height": 1000}
STAGNATION_ROUNDS = 3
DETAIL_SCRAPE_HARD_CAP = 20
"""Defense in depth beyond the DB CHECK (property_jobs.detail_scrape_top_n BETWEEN 0 AND 20) —
never navigate to more than this many detail pages regardless of what's requested."""


class PropertyBlockedError(Exception):
    """Raised when a platform serves a CAPTCHA/robot-check wall. The caller marks the job
    'blocked' and stops — we never try to solve it."""


class PropertyInterruptedError(Exception):
    """Raised when the daemon is shutting down mid-capture."""


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:40] or "listing"


def _write_manifest_checkpoint(
    job_dir: Path,
    job_id: str,
    platform: str,
    location: str,
    started_at: str,
    items: list[CapturedListing],
    end_reason: PropertyEndReason = "end_of_results",
) -> None:
    manifest = PropertyManifest(
        job_id=job_id,
        platform=platform,
        location=location,
        started_at=started_at,
        end_reason=end_reason,
        items=items,
    )
    (job_dir / "manifest.json").write_text(
        json.dumps(manifest.model_dump(), indent=2), encoding="utf-8"
    )


class PropertyCaptureEngine:
    def __init__(
        self, adapter: PlatformAdapter, settings: Settings, job_dir: Path, job_id: str
    ) -> None:
        self._adapter = adapter
        self._settings = settings
        self._job_dir = job_dir
        self._job_id = job_id

    async def _open_context(self, p: Playwright) -> tuple[BrowserContext, Browser | None]:
        """Every property platform is REQUIRES_CDP today (see adapters/base.py) — this module has
        no launched-headless path at all, unlike ecom's (amazon runs headless there). Kept as a
        method (not inlined) so a future headless-capable platform doesn't need capture.py changed,
        only its own REQUIRES_CDP=False plus a real launch branch here."""
        cdp_url = self._settings.property_cdp_url
        if not cdp_url:
            raise RuntimeError(
                "settings.property_cdp_url is not set — every property platform requires CDP "
                "(see run_property_host.py)."
            )
        browser = await p.chromium.connect_over_cdp(cdp_url)
        context = browser.contexts[0] if browser.contexts else await browser.new_context()
        context.set_default_timeout(self._settings.property_nav_timeout_ms)
        return context, browser

    @staticmethod
    async def _close_context(context: BrowserContext, cdp_browser: Browser | None) -> None:
        if cdp_browser is not None:
            await cdp_browser.close()  # disconnect only — operator's Chrome stays running
        else:
            await context.close()

    async def _screenshot_card(self, card: ElementHandle, path: str) -> None:
        """Same hardening as ecom/capture.py's _screenshot_card (learned live 2026-08-22 against
        AliExpress's shimmer-loading grid) — scroll-settle + animations disabled + one retry."""
        try:
            await card.scroll_into_view_if_needed(timeout=5000)
        except Exception as exc:  # noqa: BLE001 - scroll is a best-effort stability aid
            logger.debug("card scroll-into-view skipped", error=str(exc))
        await humanize.dwell(150, 250)
        try:
            await card.screenshot(path=path, animations="disabled", timeout=20000)
        except Exception as exc:
            logger.debug("card screenshot retrying once", error=str(exc))
            await humanize.dwell(400, 600)
            await card.screenshot(path=path, animations="disabled", timeout=20000)

    async def _wait_for_cards(self, page: Page) -> None:
        selectors = [s for s in (self._adapter.CARD_SELECTOR, *self._adapter.BLOCK_SELECTORS) if s]
        if not selectors:
            return
        try:
            await page.wait_for_selector(", ".join(selectors), timeout=8000, state="attached")
        except Exception as exc:  # noqa: BLE001 - a timeout here is a normal "no results" case
            logger.debug("no card selector appeared within wait window", error=str(exc))

    async def _find_cards(self, page: Page) -> list[ElementHandle]:
        selectors = (self._adapter.CARD_SELECTOR, *self._adapter.BLOCK_SELECTORS)
        for selector in selectors:
            if not selector:
                continue
            cards = await page.query_selector_all(selector)
            if cards:
                return cards
        return []

    async def run(
        self,
        *,
        filters: SearchFilters,
        max_pages: int,
        max_listings: int,
        started_at: str,
        resume_items: list[CapturedListing] | None = None,
        on_progress: ProgressCallback | None = None,
        should_stop: Callable[[], bool] | None = None,
    ) -> PropertyManifest:
        raw_dir = self._job_dir / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)

        items: list[CapturedListing] = list(resume_items) if resume_items else []
        seen: set[str] = {it.listing_key for it in items if it.listing_key}
        end_reason: PropertyEndReason = "end_of_results"
        stagnation = 0

        async with async_playwright() as p:
            context, cdp_browser = await self._open_context(p)
            await self._adapter.on_context_ready(context)
            page = await context.new_page()
            page.set_default_timeout(self._settings.property_nav_timeout_ms)
            try:
                page_num = 1
                while len(items) < max_listings and page_num <= max_pages:
                    if should_stop is not None and should_stop():
                        raise PropertyInterruptedError

                    url = self._adapter.search_url(filters, page_num)
                    await page.goto(url, wait_until="domcontentloaded")
                    await self._adapter.prepare_page(page)
                    await self._wait_for_cards(page)

                    if await self._adapter.is_blocked(page):
                        await page.screenshot(path=str(self._job_dir / "debug_blocked.png"))
                        raise PropertyBlockedError(f"blocked at page {page_num}")

                    cards = await self._find_cards(page)
                    if not cards:
                        if page_num == 1:
                            end_reason = "end_of_results"
                            break
                        stagnation += 1
                        if stagnation >= STAGNATION_ROUNDS:
                            end_reason = "stagnation"
                            break
                        page_num += 1
                        continue

                    new_count = 0
                    for card in cards:
                        if should_stop is not None and should_stop():
                            raise PropertyInterruptedError
                        if len(items) >= max_listings:
                            end_reason = "max_listings"
                            break

                        dom = await self._adapter.extract_card(card)
                        href = dom.listing_url
                        key = self._adapter.listing_key(href)
                        if key is None:
                            # Not a real listing — an ad/promo tile sharing the card CSS class
                            # (see ecom/capture.py's 2026-08-22 fix for exactly this bug class).
                            continue
                        if key in seen:
                            continue
                        # Client-side bathroom floor — see module docstring.
                        if (
                            filters.bathrooms is not None
                            and dom.bathrooms is not None
                            and dom.bathrooms < filters.bathrooms
                        ):
                            continue
                        seen.add(key)
                        new_count += 1

                        title = dom.title or f"Listing {len(items) + 1}"
                        if on_progress is not None:
                            await on_progress(len(items), max_listings, title)

                        idx = len(items) + 1
                        images: list[str] = []
                        try:
                            rel = f"raw/{idx:03d}_{_slug(title)}.png"
                            await self._screenshot_card(card, str(self._job_dir / rel))
                            images.append(rel)
                        except Exception as exc:  # noqa: BLE001 - screenshot is best-effort
                            logger.info("card screenshot failed", title=title, error=str(exc))

                        captured = CapturedListing(
                            idx=idx,
                            page_num=page_num,
                            title=title,
                            listing_url=href,
                            image_url=dom.image_url,
                            images=images,
                            dom=dom,
                            listing_key=key,
                        )
                        items.append(captured)
                        _write_manifest_checkpoint(
                            self._job_dir,
                            self._job_id,
                            self._adapter.platform,
                            filters.location,
                            started_at,
                            items,
                        )
                        if on_progress is not None:
                            await on_progress(len(items), max_listings, title)
                        await humanize.dwell(200, 450)

                    if len(items) >= max_listings:
                        end_reason = "max_listings"
                        break

                    if new_count == 0:
                        stagnation += 1
                        if stagnation >= STAGNATION_ROUNDS:
                            end_reason = "stagnation"
                            break
                    else:
                        stagnation = 0

                    page_num += 1
                    await humanize.dwell(400, 800)
                else:
                    if page_num > max_pages:
                        end_reason = "max_pages"
            finally:
                with contextlib.suppress(Exception):
                    await page.close()
                await self._close_context(context, cdp_browser)

        _write_manifest_checkpoint(
            self._job_dir,
            self._job_id,
            self._adapter.platform,
            filters.location,
            started_at,
            items,
            end_reason,
        )
        return PropertyManifest(
            job_id=self._job_id,
            platform=self._adapter.platform,
            location=filters.location,
            started_at=started_at,
            end_reason=end_reason,
            items=items,
        )

    async def capture_details(
        self,
        top_listings: list[CapturedListing],
        message_template: str | None,
        *,
        should_stop: Callable[[], bool] | None = None,
    ) -> dict[int, dict[str, object]]:
        """Visits each of the top-N ranked listings' detail pages, reveals the phone number, and
        builds a WhatsApp deep link. Capped at DETAIL_SCRAPE_HARD_CAP regardless of what's
        requested. Returns {idx: {description, agent_name, phone_number, whatsapp_link,
        image_urls, age_years, average_rent}}."""
        from business_scout_worker.property.whatsapp import build_whatsapp_link

        capped = top_listings[:DETAIL_SCRAPE_HARD_CAP]
        results: dict[int, dict[str, object]] = {}
        if not capped:
            return results

        async with async_playwright() as p:
            context, cdp_browser = await self._open_context(p)
            try:
                for listing in capped:
                    if should_stop is not None and should_stop():
                        raise PropertyInterruptedError
                    if not listing.listing_url:
                        continue
                    tab = await context.new_page()
                    tab.set_default_timeout(self._settings.property_nav_timeout_ms)
                    try:
                        await tab.goto(listing.listing_url, wait_until="domcontentloaded")
                        await self._adapter.prepare_page(tab)
                        if await self._adapter.is_blocked(tab):
                            logger.info("detail page blocked, skipping", idx=listing.idx)
                            continue
                        detail = await self._adapter.extract_detail(tab)
                        whatsapp_link = (
                            build_whatsapp_link(detail.phone_number, message_template, listing)
                            if detail.phone_number
                            else None
                        )
                        results[listing.idx] = {
                            "description": detail.description,
                            "agent_name": detail.agent_name,
                            "phone_number": detail.phone_number,
                            "whatsapp_link": whatsapp_link,
                            "image_urls": detail.image_urls,
                            "age_years": detail.age_years,
                            "average_rent": detail.average_rent,
                        }
                    except PropertyInterruptedError:
                        raise
                    except Exception as exc:  # noqa: BLE001 - one bad detail page is not fatal
                        logger.info("detail capture failed", idx=listing.idx, error=str(exc))
                    finally:
                        await tab.close()
                    await humanize.dwell(300, 700)
            finally:
                await self._close_context(context, cdp_browser)
        return results
