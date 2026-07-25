<!-- Authored by: Mohit Singh -->

# Crawl (OCR) module

Given a **business type** + **location** (e.g. "gym" near "Al Nahda, Dubai"), this module drives a
real Chromium to `google.com/maps`, walks the results feed item by item, and **navigates to each
business's own place page** (`page.goto(href)`, not a click on the result card — see "Capture
mechanism" below). It reads phone/website/address/plus-code/rating/category/hero-image straight
from the DOM's `data-item-id` attributes (exact, no OCR needed), captures high-DPI screenshots as
an audit trail, and OCRs those (Tesseract) as a fallback for whatever the DOM didn't expose. The
result serves as a sortable table with CSV/XLSX export.

It's a **parallel job type** to the main Overpass crawler — same architecture (Node inserts an
`ocr_jobs` row + `pg_notify`, the Python worker claims + drives it, results land in
`ocr_businesses`). The main crawler is untouched.

## Capture mechanism — navigate, don't click (critical, verified live)

A live diagnostic (2026-07-25) proved that clicking a result card's anchor does **not** reliably
open the place detail panel on the current Google Maps DOM — every click left only the search
feed's own `role="main"` element present, so every capture eventually hit its per-business timeout
with nothing to screenshot. Navigating directly to the anchor's `href` (the canonical
`/maps/place/...` URL each card already carries) opens the place view immediately and exposes the
`data-item-id` contact buttons. `CaptureEngine.run()` therefore keeps **two** Playwright pages: one
stays on the search feed (scrolling + collecting hrefs so the list is never destroyed), a second
navigates to each business in turn. Verified end-to-end: 15/15 Al Nahda, Dubai gyms captured,
0 timeouts, phone/rating/category/address 100% correct against the live page.

## Three clarifications baked in

1. **OCR is the fallback, not the primary source.** Phone/website/address/plus-code/rating/
   category come from `data-item-id` DOM attributes (`_extract_dom_fields` in `capture.py`) —
   exact, never a Tesseract misread. OCR only fills in what the DOM didn't expose, and always
   backs the screenshot audit trail (`raw_text`, `source_images`).
2. **Email is not on Google Maps.** The place page shows phone/website/address/hours but **no
   email** (verified against real exports). The `email` column stays null here; email only ever
   comes from the business's *website*, which the main crawler's Tier-1/2 enrichment already
   scrapes.
3. **Review count is usually unavailable, and this is expected — not a bug to keep debugging.**
   An anonymous/logged-out automated session gets Google's "You're seeing a limited view of Google
   Maps" degraded mode, which strips review count from both the place page and the search feed
   cards (confirmed live: the same business shows a review count in a real logged-in browser, not
   in this one). The only way to get it back is a real Google account login, which is a deliberate
   non-goal here (ToS risk, detection risk, account-ban risk — see Compliance below). Rating,
   phone, website, address, category, and hero-image are all still 100% reliable via the DOM;
   review count is the one field this pipeline cannot promise.

## ⚠️ Compliance

Automating Google Maps with a browser **violates Google's Terms of Service**. Practical risk is
temporary CAPTCHAs/blocks, not more, but this is built for **low-volume, internal use**: one job at
a time (DB-enforced single-flight lock), human-paced input, hard result caps, and a "detect the
wall → stop cleanly, never solve it" policy. For production/commercial scale, the compliant path
for the same fields (minus email) is the **Google Places API** — no OCR, no detection risk.

## Architecture & files

| Layer | Files |
|---|---|
| Schema | `db/migrations/*ocr-crawl.sql` — `ocr_jobs` (+ single-active partial-unique index) + `ocr_businesses` |
| Node API | `routes/ocrCrawl.ts`, `db/ocrJobs.ts` + `db/ocrBusinesses.ts`, `services/ocrExportService.ts`, `lib/ocrRetention.ts`, `schemas/ocrCrawl.ts` |
| Worker (Stage A capture) | `business_scout_worker/ocr/capture.py` (+ `selectors.py`, `humanize.py`) |
| Worker (Stage B OCR+parse) | `ocr/preprocess.py`, `ocr/ocr_engine.py`, `ocr/parse_fields.py` |
| Worker orchestration | `ocr/pipeline.py`, `ocr/jobs.py`, wired into `main.py` (LISTEN `ocr_crawl_jobs`) |
| UI | `src/routes/ocr-crawl.tsx`, `src/hooks/useOcrCrawl.ts`, sidebar "Crawl (OCR)" |

**Storage:** `OCR_CAPTURES_DIR/<jobId>/{manifest.json, results.json, raw/*.png}`. The heavy `raw/`
PNGs are purged after `OCR_CRAWL_RETENTION_DAYS` (boot + daily, `lib/ocrRetention.ts`); DB rows and
`results.json` persist so old jobs stay viewable/exportable.

## Job lifecycle

`queued → capturing → ocr → parsing → ready` (terminal failures: `failed` | `blocked`). Capture
records an `end_reason` (`end_of_list` | `max_results` | `stagnation` | `blocked` | `error`).

## API

| Route | Behavior |
|---|---|
| `POST /api/ocr-crawl/jobs` | `{query, location, maxResults, expandHours, langs}` → job (409 if one is already running) |
| `GET /api/ocr-crawl/jobs` | list |
| `GET /api/ocr-crawl/jobs/:id` | status + `{progress:{total,captured,ocrDone}}` (poll every 2 s) |
| `GET /api/ocr-crawl/jobs/:id/results` | parsed rows |
| `GET /api/ocr-crawl/jobs/:id/export?format=csv\|xlsx` | download (xlsx via exceljs — never the vulnerable `xlsx` npm pkg) |
| `GET /api/ocr-crawl/jobs/:id/images/*` | a captured screenshot (read-only, path-traversal-guarded, 404 after purge) |
| `DELETE /api/ocr-crawl/jobs/:id` | remove rows + on-disk folder |

## OCR-readability core & performance

Capture uses `deviceScaleFactor: 2` at 100 % zoom (never zoom out — that shrinks glyphs and wrecks
OCR). Long panels are captured as 2 **overlapping** segments (20 % overlap so no line is cut),
merged at OCR time by dropping overlap-duplicated lines. `?hl=en` locks labels to English so parse
regexes are stable.

Two independent, orthogonal performance fixes, both measured live:
- **`OMP_THREAD_LIMIT=1`** (`ocr_engine.py` + docker-compose env) — Tesseract's own internal
  multi-threading is 5.5x SLOWER on this app's image sizes (16.1s vs 2.9s for byte-identical
  output). Every OCR call stays single-threaded internally.
- **`OCR_CONCURRENCY`** (`settings.ocr_concurrency`, default 3, env `OCR_CONCURRENCY`) — Stage B
  runs this many businesses' (single-threaded) OCR calls concurrently via
  `asyncio.Semaphore`+`asyncio.gather`, which is what actually uses multiple CPU cores across a
  batch. Raise toward `core count - 1` if OCR still looks slow on a bigger box; set to `1` to fully
  serialize again for debugging.

## Selector drift (§7)

All Google Maps selectors live in `ocr/selectors.py` with role/aria fallbacks — Maps randomizes CSS
class names and reships its DOM without notice. **If capture returns 0 or mismatches, check that
file first**, then re-run a small `--max 3` job headful to see the live DOM.

## Setup

- **Docker:** `tesseract-ocr` is apt-installed in `backend/Dockerfile`; the capture volume is
  mounted in `docker-compose.yml`. Nothing else to do.
- **Local dev (Windows):** install the UB-Mannheim Tesseract build and set `TESSERACT_CMD` to
  `tesseract.exe`'s path; set `OCR_CRAWL_HEADLESS=false` to watch the browser. psycopg3 async needs
  the `SelectorEventLoop` (already set in `main.py` for Windows); Playwright's Chromium is happy
  headful there.

See `.env.example` for every config var.
