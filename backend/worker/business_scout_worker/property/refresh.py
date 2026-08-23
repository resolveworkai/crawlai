"""Authored by: Mohit Singh

On-demand single-listing refresh — the per-row "Refresh" button's backend. Much lighter than
pipeline.py's run_property_job: visits ONE known listing_url directly (no search, no pagination,
no scoring), re-reads its current price via the adapter's extract_detail (same method already used
by the normal job pipeline's detail-scrape stage — see adapters/dubizzle.py's and
adapters/propertyfinder.py's own confirmed detail-page price selectors), and updates the existing
property_listings row in place. The old/new price pair is recorded on the refresh row itself — that
IS the price-drop signal the UI highlights green from for a manually-refreshed row (the cross-job,
day-to-day price-drop signal for a normal capture-vs-capture comparison is computed separately, in
SQL, by the Node API's results query — this module only concerns the single-row refresh path).
"""

from __future__ import annotations

from playwright.async_api import async_playwright
from psycopg_pool import AsyncConnectionPool

from business_scout_worker.logging_config import get_logger
from business_scout_worker.property import jobs as property_jobs
from business_scout_worker.property.adapters import get_adapter
from business_scout_worker.property.models import ListingRefresh
from business_scout_worker.settings import Settings

logger = get_logger(__name__)


async def run_listing_refresh(
    pool: AsyncConnectionPool, refresh: ListingRefresh, settings: Settings
) -> None:
    log = logger.bind(
        refresh_id=str(refresh.id), listing_id=str(refresh.listing_id), platform=refresh.platform
    )
    old_price = await property_jobs.get_listing_price(pool, refresh.listing_id)
    cdp_url = settings.property_cdp_url
    if cdp_url is None:
        # Unreachable in practice — run_property_host.py's own startup already refuses to run at
        # all without PROPERTY_CDP_URL set (see its module docstring) — but keeps mypy honest and
        # gives a clean, terminal failure state instead of a crash if that guard is ever removed.
        await property_jobs.finish_listing_refresh(
            pool,
            refresh.id,
            status="failed",
            old_price=old_price,
            error_message="No CDP URL configured.",
        )
        return
    try:
        adapter = get_adapter(refresh.platform)
        async with async_playwright() as p:
            browser = await p.chromium.connect_over_cdp(cdp_url)
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = await context.new_page()
            page.set_default_timeout(settings.property_nav_timeout_ms)
            try:
                await page.goto(refresh.listing_url, wait_until="domcontentloaded")
                if await adapter.is_blocked(page):
                    raise RuntimeError("blocked (verification wall) while refreshing listing")
                detail = await adapter.extract_detail(page)
            finally:
                await page.close()

        if detail.price is None:
            await property_jobs.finish_listing_refresh(
                pool,
                refresh.id,
                status="failed",
                old_price=old_price,
                error_message="Could not read a price on the live listing page.",
            )
            log.warning("listing refresh found no price")
            return

        await property_jobs.update_listing_price(pool, refresh.listing_id, detail.price)
        await property_jobs.finish_listing_refresh(
            pool, refresh.id, status="done", old_price=old_price, new_price=detail.price
        )
        log.info("listing refresh done", old_price=old_price, new_price=detail.price)
    except Exception as exc:  # noqa: BLE001 - a failed refresh must still reach a terminal state
        await property_jobs.finish_listing_refresh(
            pool, refresh.id, status="failed", old_price=old_price, error_message=str(exc)[:500]
        )
        log.warning("listing refresh failed", error=str(exc))
