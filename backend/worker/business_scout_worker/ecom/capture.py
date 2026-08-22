"""Authored by: Mohit Singh

Stage A — capture engine for the e-commerce Product Research pipeline. Playwright-driven,
platform-adapter-agnostic (drives whichever `PlatformAdapter` the job's `platform` resolves to —
see ecom/adapters/). Walks search-result pages/scroll-rounds, screenshots each new product card
for the OCR-fallback + visual audit trail, and checkpoints a manifest to disk after every card so
a crashed/retried job resumes without re-capturing. Mirrors ocr/capture.py's shape (persistent
profile, humanized dwell/scroll, stagnation stop, incremental manifest checkpoint) but is
SEPARATE code — nothing here imports from or is imported by the ocr/ package's capture engine.
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

from business_scout_worker.ecom.adapters.base import PlatformAdapter
from business_scout_worker.ecom.models import CapturedProduct, EcomEndReason, EcomManifest
from business_scout_worker.logging_config import get_logger
from business_scout_worker.ocr import humanize
from business_scout_worker.settings import Settings

logger = get_logger(__name__)

# (captured_count, discovered_count, current_product_title) -> awaited by the capture loop so a
# failed progress write surfaces instead of being silently dropped (mirrors ocr/capture.py's
# ProgressCallback design note).
ProgressCallback = Callable[[int, int, str | None], Awaitable[None]]

VIEWPORT: ViewportSize = {"width": 1440, "height": 1000}
STAGNATION_ROUNDS = 3
DETAIL_SCRAPE_HARD_CAP = 10
"""Defense in depth beyond the DB CHECK (ecom_jobs.detail_scrape_top_n BETWEEN 0 AND 10) — never
navigate to more than this many detail pages regardless of what's requested."""


class EcomBlockedError(Exception):
    """Raised when a platform serves a CAPTCHA/robot-check wall. The caller marks the job
    'blocked' and stops — we never try to solve it. Mirrors ocr/capture.py's CaptureBlockedError."""


class EcomInterruptedError(Exception):
    """Raised when the daemon is shutting down mid-capture — checked between products so a
    graceful SIGTERM releases the job cleanly. Mirrors ocr/capture.py's CaptureInterruptedError."""


def _slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return s[:40] or "product"


def _write_manifest_checkpoint(
    job_dir: Path,
    job_id: str,
    platform: str,
    query: str,
    started_at: str,
    items: list[CapturedProduct],
    end_reason: EcomEndReason = "end_of_results",
) -> None:
    manifest = EcomManifest(
        job_id=job_id,
        platform=platform,
        query=query,
        started_at=started_at,
        end_reason=end_reason,
        items=items,
    )
    (job_dir / "manifest.json").write_text(
        json.dumps(manifest.model_dump(), indent=2), encoding="utf-8"
    )


class EcomCaptureEngine:
    def __init__(
        self, adapter: PlatformAdapter, settings: Settings, job_dir: Path, job_id: str
    ) -> None:
        self._adapter = adapter
        self._settings = settings
        self._job_dir = job_dir
        self._job_id = job_id

    def _chromium_args(self) -> list[str]:
        args = ["--disable-dev-shm-usage", "--no-sandbox"]
        if self._adapter.FORCE_HTTP1:
            args.append("--disable-http2")
        return args

    def _profile_dir(self) -> Path:
        d = (
            Path(self._settings.ecom_captures_dir).parent
            / f".profile-ecom-{self._adapter.platform}"
        )
        d.mkdir(parents=True, exist_ok=True)
        return d

    async def _open_context(self, p: Playwright) -> tuple[BrowserContext, Browser | None]:
        """Returns (context, cdp_browser). When ecom_cdp_url is set we ATTACH over CDP to the
        operator's already-running Chrome — the only way past noon.com's edge block (see the
        noon adapter / md/ECOM_CRAWL.md); cdp_browser is returned so the caller disconnects
        without killing that Chrome. Otherwise a headless persistent context is launched and
        cdp_browser is None (caller closes the context normally)."""
        cdp_url = self._settings.ecom_cdp_url
        if cdp_url:
            browser = await p.chromium.connect_over_cdp(cdp_url)
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            context.set_default_timeout(self._settings.ecom_nav_timeout_ms)
            return context, browser
        context = await p.chromium.launch_persistent_context(
            user_data_dir=str(self._profile_dir()),
            headless=self._settings.ecom_headless,
            viewport=VIEWPORT,
            device_scale_factor=self._settings.ecom_device_scale,
            locale="en-US",
            args=self._chromium_args(),
        )
        return context, None

    @staticmethod
    async def _close_context(context: BrowserContext, cdp_browser: Browser | None) -> None:
        if cdp_browser is not None:
            await cdp_browser.close()  # disconnect only — operator's Chrome stays running
        else:
            await context.close()

    async def run(
        self,
        *,
        query: str,
        sort: str,
        max_pages: int,
        max_products: int,
        started_at: str,
        resume_items: list[CapturedProduct] | None = None,
        on_progress: ProgressCallback | None = None,
        should_stop: Callable[[], bool] | None = None,
    ) -> EcomManifest:
        raw_dir = self._job_dir / "raw"
        raw_dir.mkdir(parents=True, exist_ok=True)

        items: list[CapturedProduct] = list(resume_items) if resume_items else []
        seen: set[str] = {it.product_key or (it.product_url or it.title) for it in items}
        end_reason: EcomEndReason = "end_of_results"
        stagnation = 0

        async with async_playwright() as p:
            context, cdp_browser = await self._open_context(p)
            await self._adapter.on_context_ready(context)
            # Under CDP we open (and later close) our OWN tab so we never hijack or close the
            # operator's existing tabs; under a launched context the default blank page is ours.
            page = (
                await context.new_page()
                if cdp_browser is not None
                else (context.pages[0] if context.pages else await context.new_page())
            )
            page.set_default_timeout(self._settings.ecom_nav_timeout_ms)
            try:
                page_num = 1
                while len(items) < max_products and page_num <= max_pages:
                    if should_stop is not None and should_stop():
                        raise EcomInterruptedError

                    url = self._adapter.search_url(query, sort, page_num)  # type: ignore[arg-type]
                    await self._goto_with_download_retry(page, url)
                    await self._adapter.prepare_page(page)
                    await self._wait_for_cards(page)

                    if await self._adapter.is_blocked(page):
                        await page.screenshot(path=str(self._job_dir / "debug_blocked.png"))
                        raise EcomBlockedError(f"blocked at page {page_num}")

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
                            raise EcomInterruptedError
                        if len(items) >= max_products:
                            end_reason = "max_products"
                            break

                        dom = await self._adapter.extract_card(card)
                        href = dom.product_url
                        key = self._adapter.product_key(href)
                        if key is None:
                            # Not a real product — a promo/deal/ad tile sharing the card CSS class
                            # with no genuine product SKU in its href (confirmed 2026-08-22:
                            # AliExpress's "Deals & discounts" banner tile matches
                            # search-item-card-wrapper but has no /item/ link). Every adapter's
                            # product_key() is the authoritative "is this a real product" check —
                            # falling back to a raw href/title here used to let such non-product
                            # chrome through as a fake row with garbage/empty data.
                            continue
                        if key in seen:
                            continue
                        seen.add(key)
                        new_count += 1

                        title = dom.title or f"Product {len(items) + 1}"
                        if on_progress is not None:
                            await on_progress(len(items), max_products, title)

                        idx = len(items) + 1
                        images: list[str] = []
                        try:
                            rel = f"raw/{idx:03d}_{_slug(title)}.png"
                            await self._screenshot_card(card, str(self._job_dir / rel))
                            images.append(rel)
                        except Exception as exc:  # noqa: BLE001 - screenshot is best-effort
                            logger.info("card screenshot failed", title=title, error=str(exc))

                        captured = CapturedProduct(
                            idx=idx,
                            page_num=page_num,
                            title=title,
                            product_url=href,
                            image_url=dom.image_url,
                            images=images,
                            dom=dom,
                            product_key=key,
                        )
                        items.append(captured)
                        _write_manifest_checkpoint(
                            self._job_dir,
                            self._job_id,
                            self._adapter.platform,
                            query,
                            started_at,
                            items,
                        )
                        if on_progress is not None:
                            await on_progress(len(items), max_products, title)
                        await humanize.dwell(200, 450)

                    if len(items) >= max_products:
                        end_reason = "max_products"
                        break

                    if new_count == 0:
                        stagnation += 1
                        if stagnation >= STAGNATION_ROUNDS:
                            end_reason = "stagnation"
                            break
                    else:
                        stagnation = 0

                    if self._adapter.uses_pagination:
                        page_num += 1
                        await humanize.dwell(400, 800)
                    else:
                        await self._adapter.load_more(page, page.locator("body"))
                else:
                    if page_num > max_pages:
                        end_reason = "max_pages"
            finally:
                if cdp_browser is not None:
                    # closing our own tab is best-effort — a torn-down page must not mask the
                    # real result/exception
                    with contextlib.suppress(Exception):
                        await page.close()
                await self._close_context(context, cdp_browser)

        _write_manifest_checkpoint(
            self._job_dir,
            self._job_id,
            self._adapter.platform,
            query,
            started_at,
            items,
            end_reason,
        )
        return EcomManifest(
            job_id=self._job_id,
            platform=self._adapter.platform,
            query=query,
            started_at=started_at,
            end_reason=end_reason,
            items=items,
        )

    async def _goto_with_download_retry(self, page: Page, url: str) -> None:
        """`page.goto` occasionally raises "Download is starting" against amazon.ae — confirmed
        2026-08-07 (reproducible across retries for a specific query+sort combo); a plain `curl`
        of the SAME url returns a normal 200 HTML page, so this is specific to what Chromium's
        navigation sees, not the URL itself — most plausibly Amazon's anti-bot layer serving a
        one-off trap response to that particular browser fingerprint/session. One retry (fresh
        navigation, same URL) has been enough in testing; if it recurs the second attempt's
        exception propagates and the job fails cleanly (pipeline.py's generic handler), same as
        any other unrecoverable capture error — this is NOT a silent-swallow, just a bounded retry
        for a known-transient case."""
        try:
            await page.goto(url, wait_until="domcontentloaded")
        except Exception as exc:
            if "download is starting" not in str(exc).lower():
                raise
            logger.warning("goto hit a download trap, retrying once", url=url, error=str(exc))
            await page.wait_for_timeout(1500)
            await page.goto(url, wait_until="domcontentloaded")

    async def _screenshot_card(self, card: ElementHandle, path: str) -> None:
        """`ElementHandle.screenshot()` waits for the element to be visually "stable" (no ongoing
        layout shift) before capturing — on AliExpress's grid (shimmer/loading placeholders,
        rotating promo badges, progressively-loading images) that check sometimes never converges
        within the default window, throwing "Timeout ... waiting for element to be stable"
        (confirmed 2026-08-22 — several cards failed this way, and since AliExpress is pure-OCR
        with no DOM fallback, a failed screenshot there means a totally empty row, not just a
        missing field). `animations="disabled"` freezes CSS animations/transitions for the shot,
        which is Playwright's documented fix for exactly this instability. Explicit
        scroll-into-view + a short settle wait first reduces the chance of a shift starting mid-
        capture; one retry covers a one-off race, a second failure propagates to the caller's
        existing best-effort catch (screenshot stays best-effort, not required)."""
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
        """Bounded wait for the FIRST product card to appear before we check is_blocked/count
        cards. `wait_until="domcontentloaded"` fires before a client-rendered SPA (noon, in
        particular — its data-qa attributes only exist post-hydration) has painted any results,
        so checking immediately raced the render and intermittently produced a false
        `end_of_results` on an otherwise-normal page (confirmed 2026-08-07: a fresh "yoga mat"
        noon search returned 0 cards from the pipeline but 62 from the same URL loaded manually
        with a few seconds' wait). Times out silently — a genuinely empty results page (or a
        CAPTCHA wall the `is_blocked` check catches right after) must still proceed, not raise."""
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

    async def capture_details(
        self,
        top_products: list[CapturedProduct],
        *,
        should_stop: Callable[[], bool] | None = None,
    ) -> dict[int, dict[str, object]]:
        """Phase 2b — opens a NEW tab per product (never disturbs the search-results page/profile
        state) to its `product_url`, extracts description/about_bullets/breadcrumb/seller, and
        screenshots the description/details region (falling back to the viewport). Capped at
        DETAIL_SCRAPE_HARD_CAP regardless of how many `top_products` are passed in. Returns
        {idx: {...DomDetailFields fields..., "detail_image": str | None}}."""
        capped = top_products[:DETAIL_SCRAPE_HARD_CAP]
        results: dict[int, dict[str, object]] = {}
        if not capped:
            return results

        async with async_playwright() as p:
            context, cdp_browser = await self._open_context(p)
            await self._adapter.on_context_ready(context)
            try:
                for product in capped:
                    if should_stop is not None and should_stop():
                        raise EcomInterruptedError
                    if not product.product_url:
                        continue
                    tab = await context.new_page()
                    tab.set_default_timeout(self._settings.ecom_nav_timeout_ms)
                    try:
                        await tab.goto(product.product_url, wait_until="domcontentloaded")
                        await self._adapter.prepare_page(tab)
                        if await self._adapter.is_blocked(tab):
                            logger.info("detail page blocked, skipping", idx=product.idx)
                            continue
                        detail = await self._adapter.extract_detail(tab)
                        image_rel: str | None = None
                        try:
                            region = await tab.query_selector(
                                '[data-qa="product-description"], #productDescription, '
                                "#feature-bullets"
                            )
                            image_rel = f"raw/{product.idx:03d}_{_slug(product.title)}_detail.png"
                            target = region or tab
                            await target.screenshot(path=str(self._job_dir / image_rel))
                        except Exception as exc:  # noqa: BLE001 - screenshot is best-effort
                            logger.info("detail screenshot failed", idx=product.idx, error=str(exc))
                            image_rel = None
                        results[product.idx] = {
                            "description": detail.description,
                            "about_bullets": detail.about_bullets,
                            "breadcrumb_category": detail.breadcrumb_category,
                            "seller_name": detail.seller_name,
                            "detail_image": image_rel,
                        }
                    except NotImplementedError:
                        raise
                    except Exception as exc:  # noqa: BLE001 - one bad detail page is not fatal
                        logger.info("detail capture failed", idx=product.idx, error=str(exc))
                    finally:
                        await tab.close()
                    await humanize.dwell(300, 700)
            finally:
                await self._close_context(context, cdp_browser)
        return results
