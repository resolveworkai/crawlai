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

## Radius search, grid tiling, and exhaustive coverage

Given a center point (`centerLat`/`centerLng` — the UI's "Use my location" button, or manual
entry) + `radiusKm`, the job is **radius-bounded, exactly**: every captured business's own
coordinates (parsed from its place href's `!3d{lat}!4d{lng}` segment — Google's own value, not an
estimate) are haversine-checked against the true center, and anything beyond `radiusKm` is skipped
before it's ever captured. This is a hard filter, not a soft Maps-viewport bias.

**Why a single search can still miss businesses, and how tiling fixes it:** Google Maps' consumer
search is relevance-ranked and soft-capped (`STAGNATION_ROUNDS` gives up after repeated stagnant
scrolls) — a broad search over a big area silently stops loading results well before every real
business has surfaced. `generate_grid_cells()` (`capture.py`) covers a large `radiusKm` with a
ring-based grid of smaller, overlapping `cell_radius_km` (default 2km) sub-searches — small enough
that each one *is* realistically exhaustive — walked **sequentially, within the same single
Chromium session** (never concurrent Maps automation; see Compliance below). A radius that fits in
one cell (≤2km by default) runs exactly one search, unchanged from the original behavior.

**Cross-cell dedup**: the same business legitimately appears in more than one overlapping cell.
The primary key is Google's own stable place id (the href's `!1s{hex}:{hex}` segment) — exact, so
`seen` recognizes and skips it as soon as it resurfaces in a later cell, without re-capturing. A
final `_dedupe_by_name_phone()` pass is a safety net for the rare href without a parseable place
id: exact phone match, or a close fuzzy name match within 250m (guards against merging two
different branches of the same-named chain).

**Radius ceiling & cell-count safety (`MAX_GRID_CELLS = 60`)**: `radiusKm` accepts up to 300km. A
naive grid at the default 2km cell size would produce thousands of cells for a radius that large —
impractical (hours of sequential navigation) and a real ToS/detection-risk multiplier (far more
automated requests against Maps from one session). `generate_grid_cells()` auto-widens
`cell_radius_km` in steps until the total cell count fits `MAX_GRID_CELLS`, trading some per-cell
exhaustiveness for a bounded, predictable job duration at very large radii. The UI hints "large
radii auto-tile, take longer" past 20km.

**Setting the center point**: two ways, both write `centerLat`/`centerLng` — "Use my location"
(browser Geolocation API) for wherever the operator physically is, or **pin a typed address**
(the same Nominatim `/geocode` proxy the main crawler's Discover screen uses) via the search-icon
button next to Location, for pinning anywhere regardless of where the browser is.

## Queueing — jobs stack, never rejected

`POST /ocr-crawl/jobs` never 409s. A new job is created `queued` and `claim_pending_ocr_job()`
(oldest `created_at` first, `FOR UPDATE SKIP LOCKED`) auto-runs it the moment whatever's ahead
finishes — `main.py`'s worker loop already `continue`s straight into the next claim after a job
completes, so this needed no worker changes, only relaxing the DB constraint (migration
`1784500000000`): only **actively running** work (`capturing`/`ocr`/`parsing` — an open Chromium
session) is still capped at one at a time (`ux_ocr_jobs_single_running`); any number of jobs may
sit `queued` simultaneously. The create response includes `queuePosition` (jobs already queued
ahead) so the UI can say "queued behind N" instead of silently accepting into a void.

## Per-business timeout and why jobs "time out" (2026-11-15)

Each business has a hard ceiling (`settings.ocr_business_timeout_s`, default **90s**, env
`OCR_BUSINESS_TIMEOUT_S`; it was a hard-coded 30s). A business over the ceiling is skipped
(`skip: capture timed out` in the worker log) and the walk moves on — so a too-low ceiling silently
throws data away while the job still reads "capturing". Measured on a loaded 4-CPU machine, one
business needs ~40–45s (navigation 11–16s, panel detection 7–9s, two panel screenshots 19–22s), so the
old 30s ceiling abandoned ~80% of them. Check the worker log (`docker logs business-scout-backend |
grep "capture timed out"`) before assuming Google is blocking you. Container CPU near 300% and a
saturated host are the usual cause; see the levers listed in `CLAUDE.md`.

**Redeploying kills a running job.** Recreating the backend container marks an in-flight OCR job
`failed` ("Interrupted by a server restart — relaunch the job."). It is resumable via Retry, but
rebuild only when no OCR job is running.

## Retry — resumes a failed/blocked job, refreshes+overwrites a ready one

**Every non-running job is retryable** (2026-09-12 — was `failed`/`blocked` only), with two
different behaviors depending on the job's status when **Retry**/**Refresh** is clicked
(`POST /ocr-crawl/jobs/:id/retry`, capped at `MAX_OCR_RETRIES = 3` — `db/ocrJobs.ts`). Either way
it reuses the **same job row** (same id, same `storage_dir`) rather than creating a new one, so
nothing needs relocating:

- **`failed`/`blocked` -> RESUME** (unchanged behavior, described below): picks up from wherever
  the prior attempt left off.
- **`ready` -> REFRESH**: a completed job's manifest is already fully done, so a plain resume would
  find everything already there and finish instantly without capturing anything new — not useful
  for "the listing may have changed, re-scan it." Instead the route (`routes/ocrCrawl.ts`) deletes
  the on-disk `manifest.json` **and every existing `ocr_businesses` row for that job** before
  requeueing it, so the worker walks the search fresh from scratch. The new capture's rows land at
  the SAME `(job_id, idx)` via `insert_ocr_business`'s `ON CONFLICT DO UPDATE`, so the refreshed
  data genuinely **overwrites** the old results rather than sitting duplicated alongside them; the
  DB-level row delete (not just relying on the UPSERT) also covers a fresh walk finding fewer
  businesses than before (one closed/delisted) — those stale extra rows are removed too, not left
  behind with outdated data.

The RESUME path (failed/blocked retry) works like this:

- **Capture checkpoints incrementally.** `_write_manifest_checkpoint()` (`capture.py`) overwrites
  `manifest.json` after **every** successful capture, not just once when the whole run finishes —
  so a crash mid-capture still leaves an accurate record of everything captured so far.
- **On claim, the worker checks for a manifest already on disk.** `run_ocr_job()`
  (`pipeline.py`) loads it if present and passes those items into `CaptureEngine.run()` as
  `resume_items`, which seeds `items`/`seen` (`_seed_from_resume()`) — those businesses are never
  re-navigated, only genuinely new ones get walked.
- **Stage B skips indices already in `ocr_businesses`.** `get_ocr_done_indices()` — safe either
  way (`insert_ocr_business` is `ON CONFLICT`-idempotent) but avoids redundant OCR work.
- **`results.json` is rebuilt from the DB** (`list_ocr_business_rows()`) at the end, so it reflects
  the union of every attempt, not just the last one's.
- **Partial results always survive.** `/results` and `/export` don't gate on job status — a job
  that hits the 3-retry cap and stays `failed` still has its captured businesses fully viewable
  and exportable in the UI (the "No rows parsed" table only shows when `status==='ready'` OR
  there's real `captured_count` on a failed/blocked job).

## ⚠️ Compliance

Automating Google Maps with a browser **violates Google's Terms of Service**. Practical risk is
temporary CAPTCHAs/blocks, not more, but this is built for **low-volume, internal use**: only one
job **actively runs** at a time — multiple regions queue and auto-run sequentially, deliberately
never concurrently, so there is never more than one automated Maps session open regardless of how
many jobs (or grid cells within one job) are pending — human-paced input, hard result caps, and a
"detect the wall → stop cleanly, never solve it" policy. For production/commercial scale, the
compliant path for the same fields (minus email) is the **Google Places API** — no OCR, no
detection risk.

## Architecture & files

| Layer | Files |
|---|---|
| Schema | `db/migrations/*ocr-crawl.sql` + follow-ups — `ocr_jobs` (center/radius, retry_count, single-**running** partial-unique index) + `ocr_businesses` (lat/lng/distance_km, image_url) + `ocr_logs` (own FK, mirrors `crawl_logs`) |
| Node API | `routes/ocrCrawl.ts`, `db/ocrJobs.ts` + `db/ocrBusinesses.ts` + `db/ocrLogs.ts`, `services/ocrExportService.ts`, `lib/ocrRetention.ts`, `schemas/ocrCrawl.ts` |
| Worker (Stage A capture) | `business_scout_worker/ocr/capture.py` (+ `selectors.py`, `humanize.py`) |
| Worker (Stage B OCR+parse) | `ocr/preprocess.py`, `ocr/ocr_engine.py`, `ocr/parse_fields.py` |
| Worker orchestration | `ocr/pipeline.py`, `ocr/jobs.py` (incl. `write_log`), wired into `main.py` (LISTEN `ocr_crawl_jobs`) |
| UI | `src/routes/ocr-crawl.tsx`, `src/hooks/useOcrCrawl.ts`, sidebar "Crawl (OCR)"; also surfaced on the dashboard (`src/routes/index.tsx`'s "Crawl (OCR)" card + the merged "Live crawl log" stream) |

**Storage:** `OCR_CAPTURES_DIR/<jobId>/{manifest.json, results.json, raw/*.png}`. The heavy `raw/`
PNGs are purged after `OCR_CRAWL_RETENTION_DAYS` (boot + daily, `lib/ocrRetention.ts`); DB rows and
`results.json` persist so old jobs stay viewable/exportable.

## Job lifecycle

`queued → capturing → ocr → parsing → ready` (terminal failures: `failed` | `blocked`). Capture
records an `end_reason` (`end_of_list` | `max_results` | `stagnation` | `blocked` | `error`).

## API

| Route | Behavior |
|---|---|
| `POST /api/ocr-crawl/jobs` | `{query, location, maxResults, expandHours, langs, centerLat?, centerLng?, radiusKm?}` → `{job, queuePosition}` — never rejected, queues behind any job already running |
| `GET /api/ocr-crawl/jobs` | list |
| `GET /api/ocr-crawl/jobs/:id` | status + `{progress:{total,captured,ocrDone}}` (poll every 2 s) |
| `GET /api/ocr-crawl/jobs/:id/results` | parsed rows |
| `GET /api/ocr-crawl/jobs/:id/export?format=csv\|xlsx` | download (xlsx via exceljs — never the vulnerable `xlsx` npm pkg) |
| `GET /api/ocr-crawl/jobs/:id/businesses/:businessId/export?format=csv\|xlsx` | row-level export — one business, same columns as the whole-job export |
| `GET /api/ocr-crawl/jobs/:id/images/*` | a captured screenshot (read-only, path-traversal-guarded, 404 after purge) |
| `POST /api/ocr-crawl/jobs/:id/retry` | retry any non-running job (capped at 3) — resumes `failed`/`blocked`, refreshes+overwrites `ready` → `{job, queuePosition}` |
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
- **`OCR_CONCURRENCY`** (`settings.ocr_concurrency`, env `OCR_CONCURRENCY`) — Stage B runs this many
  businesses' (single-threaded) OCR calls concurrently via `asyncio.Semaphore`+`asyncio.gather`,
  which is what actually uses multiple CPU cores across a batch. **Default changed 2026-09-12**
  from a flat `3` to `min(8, cpu_count() - 1)` (`settings.py`) — a flat default left multi-core
  containers under-using Stage B (found live: a real job stuck well below expected throughput on a
  4-core box, only using 3 of them). Set to `1` to fully serialize again for debugging.
- **Detail-page resource blocking (2026-09-12, `capture.py`)** — Stage A's detail page (the one
  that navigates to each place URL, not the feed page) now blocks `font`/`media` requests via
  `page.route`, mirroring `enrich/tier2.py`'s pattern. `image` is deliberately NOT blocked, unlike
  Tier-2 — the segment screenshots here ARE the OCR/audit-trail artifact, so blocking photos would
  degrade that trail for no real data gain (structured fields already come from the DOM, not
  screenshot pixels). Cuts real per-business navigation time on Maps' photo-heavy place pages
  without touching captured data or the audit screenshots.
- **Investigated and deliberately NOT done**: unconditionally skipping the Tesseract call for
  businesses where the DOM already has phone+website was considered but rejected — `opening_hours`
  and `email` have no DOM equivalent at all (`DomFields` in `models.py` doesn't carry them), so
  skipping OCR outright would silently drop those two fields for the majority of businesses, not
  just save time. Revisit only alongside a product decision to accept that tradeoff (e.g. an
  explicit "skip hours/email" job option), not as a blind performance change.

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
