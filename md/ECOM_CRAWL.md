<!-- Authored by: Mohit Singh -->

# Product Research (Ecom-Crawl) module

Given a **platform** (noon.com/uae-en or amazon.ae) + a **search query** (e.g. "yoga mat",
"adjustable dumbbells"), this module drives a real Chromium against that platform's search-results
page, walks the result cards page by page, reads whatever structured fields the card's own DOM
exposes (title, price, rating, review count, badges, sponsored flag, …), and OCRs (Tesseract) a
screenshot of each card as a fallback for whatever the DOM didn't expose. Every product is then
scored with a deterministic "opportunity score" (reviews + rating + demand + price-value, all
weighted) so the result table can be sorted to surface the most promising products for the given
query. Results are a sortable table with CSV/XLSX/JSON export.

It is a **parallel job type**, architecturally identical to the Crawl-OCR (Google Maps) module and
the main Overpass crawler — Node inserts an `ecom_jobs` row + `pg_notify`, the Python worker claims
+ drives it, results land in `ecom_products`. Nothing in the OCR/Maps module or the main crawler is
touched by this one.

## noon.com requires CDP-attach to the operator's real Chrome (host runner) {#noon-cdp}

**amazon.ae runs headless in the container like everything else. noon.com does NOT and cannot.**
noon's Akamai edge resets EVERY automated-launch browser transport before a byte of the page loads
— verified 2026-08-07 against HTTP/2 (`ERR_HTTP2_PROTOCOL_ERROR`), HTTP/1.1 (`--disable-http2` →
stall), QUIC/HTTP3 (`ERR_QUIC_PROTOCOL_ERROR`), DoH+ECH, and even Playwright's real-Chrome channel.
The operator's ordinary Chrome reaches noon fine, so the ONLY working path is **attaching over the
DevTools protocol (CDP) to that already-running Chrome** — which the site treats as a normal
browser. This is why noon is handled by a **host runner**, not the container:

- **`NoonAdapter.REQUIRES_CDP = True`** (base flag; `cdp_required_platforms()` in
  `ecom/adapters/__init__.py` is the single source of truth for which platforms are host-only).
- **`settings.ecom_cdp_url`** — when set (e.g. `http://localhost:9222`), `EcomCaptureEngine`
  ATTACHES via `connect_over_cdp` instead of launching Chromium, and disconnects (never kills) that
  Chrome on finish. Left unset in the container.
- **Claim/recover partition**: the container daemon claims and recovers with
  `exclude_platforms=cdp_required_platforms()` (never touches noon); the host runner
  (`backend/worker/run_noon_host.py`) claims and recovers with `only_platforms=` the same set. This
  is mandatory — without it a container respawn's orphan-recovery marks a live host job `failed`
  out from under it (a real bug hit + fixed 2026-08-07).
- **`ux_ecom_jobs_single_running`** was re-keyed (`migration 1785100000000`) from global
  (`ON ((TRUE))`) to per-runner-group (`ON ((platform = ANY(ARRAY['noon'])))`) so ONE host (noon)
  job and ONE container (non-noon) job can run concurrently — they're independent browser sessions
  on different machines. `claim_pending_ecom_job` also now catches the `UniqueViolation` as
  back-pressure (returns None) instead of crashing the claimer.
- **Windows event-loop catch-22**: on the host, psycopg's async pool refuses Windows' Proactor
  loop while Playwright's driver subprocess REQUIRES it. `run_noon_host.py` therefore runs the
  shared async pipeline on the Proactor loop and routes DB through a tiny **sync-psycopg shim**
  (`_SyncPoolShim`, via `asyncio.to_thread`) that presents the exact async-pool surface
  `ecom/jobs.py` uses — so the pipeline/jobs code runs UNCHANGED. The Linux container never hits
  this (both work there) and keeps using the real async pool.

**Operator flow for a noon job**: run `scripts/start-noon-chrome.bat` (starts Chrome with
`--remote-debugging-port=9222` on a dedicated scratch profile) → queue a `platform=noon` job from
the `/ecom-crawl` UI as normal → run `run_noon_host.py` with `DATABASE_URL` (host port 5436) +
`ECOM_CDP_URL=http://localhost:9222`. Results land in the same `ecom_products`/frontend as any
amazon job. Screenshots taken by the host runner live on host disk (not the container volume), so
their audit-trail images aren't served by the container API — but DOM extraction is complete for
noon (title/price/rating/reviews/badges/image all from the card DOM), and the frontend falls back
to noon's CDN `image_url` for thumbnails, so this is cosmetic only.

## AliExpress — same host-runner path, but PURE-OCR extraction {#aliexpress-ocr}

AliExpress is also Akamai-blocked (`REQUIRES_CDP = True`), so it runs through the SAME host runner
as noon (`cdp_required_platforms()` now returns `{noon, aliexpress}`; the container excludes both,
the host runner claims both). Two things differ from noon:

- **Pure OCR by design** (chosen 2026-08-07): `AliExpressAdapter.extract_card` reads NOTHING but the
  product link (and image) from the DOM — a URL OCR can't produce. Title, price, rating, and "N
  sold" all come from Tesseract OCR of the card screenshot in Stage B, because AliExpress's card
  classes are hashed CSS-modules that churn constantly and pixel OCR is more durable. `parse_product`
  gained a `_parse_sold` (AliExpress "4,000+ sold" → the shared `bought_past_month` demand field) and
  `_derive_title` (longest non-chrome OCR line, leading "Choice"/badge token stripped). The pipeline
  already forces the OCR path when the DOM is empty, so no pipeline change was needed.
- **English/USD forced before the first navigation**: on a UAE profile AliExpress renders in Arabic,
  which makes OCR titles garbage. `AliExpressAdapter.on_context_ready` (a new base-adapter hook run
  once after the context opens, before nav — wired into `capture.py`) sets the `aep_usuc_f` cookie
  (`site=glo&c_tp=USD&region=US&b_locale=en_US`); verified the page then loads English.

Sort is by orders (`total_tranpro_desc`) since AliExpress has NO rating sort — the "N sold" signal
OCRs cleanly and drives the opportunity score. **Accepted pure-OCR limitations**: the card visually
truncates long titles (so OCR titles are truncated — full title is only on the detail page), and OCR
occasionally drops a decimal in a price/rating (the 0-5 rating validation nulls a bad read rather
than storing a wrong one). Needs **Tesseract on the host** (`TESSERACT_CMD` env → `settings.tesseract_cmd`;
the container already has it on PATH). The host runner/launcher handles noon AND aliexpress
identically — `start-noon-host.bat` processes both.

**Alibaba was evaluated and deliberately NOT built**: even via real Chrome it serves a slider CAPTCHA
("Please drag the slider to verify") on a fresh profile, and its robots.txt explicitly disallows the
product/search paths. Solving CAPTCHAs is out of scope (policy + this module's own "CAPTCHA →
blocked, never solve" rule), so Alibaba is unsupported.

## Deliberately separate from Crawl (OCR) — own everything, shared utilities only

This module and the Crawl-OCR (Google Maps) module look similar (DOM-first + OCR-fallback +
CSV/XLSX export, resumable retry, single-running-job policy) but are **fully separate code and
data**:

| | Crawl (OCR) — Google Maps | Product Research (Ecom-Crawl) |
|---|---|---|
| DB tables | `ocr_jobs`, `ocr_businesses`, `ocr_logs` | `ecom_jobs`, `ecom_products`, `ecom_logs` |
| `pg_notify` channel | `ocr_crawl_jobs` | `ecom_crawl_jobs` |
| Worker package | `business_scout_worker/ocr/` | `business_scout_worker/ecom/` |
| API routes | `/api/ocr-crawl/*` | `/api/ecom-crawl/*` |
| Storage dir | `OCR_CAPTURES_DIR` (`./storage/ocr_captures`) | `ECOM_CAPTURES_DIR` (`./storage/ecom_captures`) |

The **only** things this module reuses from the OCR/Maps side are genuinely site-agnostic worker
utilities: `ocr_engine.py` (Tesseract wrapper + `merge_segments` overlap-stitching),
`preprocess.py`, `humanize.py` (dwell/scroll pacing), the shared `Settings`, and the shared DB pool.
No `ocr_*` table, route, or business-logic module is imported by or imports from `ecom/`.

## Platforms

| Platform | Status | Adapter |
|---|---|---|
| `noon` (noon.com/uae-en) | Implemented | `ecom/adapters/noon.py` |
| `amazon` (amazon.ae) | Implemented | `ecom/adapters/amazon.py` |
| `aliexpress` | **Reserved, not selectable** | `ecom/adapters/aliexpress.py` (stub — every method raises `NotImplementedError`) |

AliExpress is registered in the adapter registry (`ecom/adapters/__init__.py`'s `_REGISTRY`) and is
a valid value in the `ecom_jobs.platform` DB `CHECK` constraint and the `Platform` type — but the
API's `createEcomJobSchema` (`schemas/ecomCrawl.ts`) deliberately restricts the *creatable* set to
`["noon", "amazon"]`, so a job can never be queued against a platform whose adapter can't actually
search or capture anything. AliExpress is reserved because its search results are far more
aggressively bot-gated (heavy client-side rendering, frequent CAPTCHA) than noon/amazon, so it was
shipped as a stub rather than half-working.

## Pipeline stages

`queued → capturing → ocr → parsing → [detail →] ready` (terminal failures: `failed` | `blocked`).

| Stage | What happens |
|---|---|
| `queued` | Job row created, never rejected — see Queueing below |
| `capturing` (Stage A) | `EcomCaptureEngine` (`ecom/capture.py`) walks the adapter's `search_url()` across pages, screenshots each new card, and reads whatever the adapter's `extract_card()` exposes straight from the DOM (authoritative — title/price/rating/review_count/badges/sponsored/etc). Checkpoints `manifest.json` after every captured card. |
| `ocr` (Stage B) | For each captured product: if the DOM already has all of `title`/`price`/`rating`/`review_count` (`_dom_is_complete()` in `pipeline.py`), OCR is skipped entirely; otherwise the card screenshot(s) are OCR'd (`merge_segments`, shared with the Maps module) and `ecom/parse_product.py`'s regex parsers fill in whatever the DOM missed. DOM values always win over OCR when both are present. |
| `parsing` (Stage C) | `ecom/analysis.py`'s `compute_opportunity_scores()` runs once over the whole batch and each product is upserted into `ecom_products` with its score. |
| `detail` (Stage D, optional) | Only runs when the job's `detail_scrape_top_n > 0` — see "Detail-scrape" below. |
| `ready` | Terminal success. `results.json` is rebuilt from the DB so it reflects every attempt's union, not just the last one's. |
| `failed` / `blocked` | Terminal failure — `blocked` means the adapter's `is_blocked()` detected a CAPTCHA/robot-check wall; `failed` covers everything else (including a worker-shutdown interruption, which is retryable). |

## Detail-scrape (Phase 2b) — off by default

A job's `detail_scrape_top_n` (0–10, DB `CHECK`, default **0**) controls an optional Stage D that
navigates to individual product detail pages for a deeper scrape:

- **Off by default (`0`)** — no extra per-product navigation beyond the search-results pages, which
  keeps the bot-detection surface as small as possible.
- When `> 0`, the pipeline ranks all non-sponsored captured products by `(rating, opportunity_score)`
  descending and takes the top N (hard-capped at `DETAIL_SCRAPE_HARD_CAP = 10` in `capture.py`
  regardless of what's requested, defense-in-depth beyond the DB `CHECK`).
- For each of those, `PlatformAdapter.extract_detail()` (implemented by noon and amazon; the base
  class default raises `NotImplementedError` so aliexpress and any future non-detail-capable adapter
  fail loudly rather than silently) reads: `description`, `about_bullets` (key highlights/feature
  bullets), `breadcrumb_category`, and `seller_name`. These land on `ecom_products.description` /
  `about_bullets` / `breadcrumb_category` / `seller_name`, with `detail_scraped = true` marking which
  rows actually got the deep scrape (everything else stays `NULL`/`false`, never fabricated).
- Progress is tracked separately via `ecom_jobs.detail_done_count` / the job's `progress.detailDone`.

## Opportunity scoring (`ecom/analysis.py`)

Pure, no-I/O, deterministic math — deliberately free of DB/Playwright imports so it's directly unit
tested and portable (the same algorithm is the single source of truth; nothing re-derives it
elsewhere). For each product:

```
reviews_n = log10(reviews + 1) / log10(max_reviews + 1)
rating_n  = clamp((rating - 3) / 2, 0, 1)
demand_n  = log10(bought_past_month + 1) / log10(max_bought + 1)   (0 if bought_past_month is None)
value_n   = 1 - clamp(|price - median_price| / median_price, 0, 1)  (1.0 if price or median_price
            is missing/0 — "no penalty" rather than a division error)

score = 100 * (w.reviews * reviews_n + w.rating * rating_n + w.demand * demand_n + w.value * value_n)
```

- **Default weights** (`DEFAULT_WEIGHTS`): `reviews 0.35`, `rating 0.25`, `demand 0.25`, `value 0.15`.
- **Override per job** via `scoreWeights` on job creation (`POST /ecom-crawl/jobs`) — a partial
  object (`{reviews?, rating?, demand?, value?}`, each `0..1`); any key not supplied falls back to
  the worker's own default for that key (missing keys are `w.get(key, 0.0)` inside the score sum, so
  an omitted key contributes nothing rather than the default weight — pass the full set of weights
  you want honored).
- **Sponsored rows are excluded from the batch's denominators** (`max_reviews`, `max_bought`,
  `median_price` are computed over non-sponsored rows only, so a paid placement doesn't skew what
  "competitive" looks like) but a sponsored row is still scored using those same denominators — its
  own opportunity is still worth showing, and because `reviews_n`/`demand_n` are **not clamped to
  1.0**, a sponsored product with review/bought counts far above the organic max can legitimately
  score higher than 100 * (its weighted components alone would suggest) on those two components.
- `build_summary()` aggregates already-scored products (it never recomputes scores) into the
  `/analysis` endpoint's payload: price min/p25/median/p75/max, rating avg/median, review-count
  total/median, bought-past-month count/sum, free-delivery %, badge frequency (top 20), and the
  top-10 products by `opportunity_score`.

## Storage

`ECOM_CAPTURES_DIR/<jobId>/{manifest.json, results.json, raw/*.png}` — mirrors the OCR module's
layout exactly (env var default `./storage/ecom_captures`, worker `settings.ecom_captures_dir`,
Node `config.ECOM_CAPTURES_DIR`, both defaulting to the same path).

## Queueing, resumable retry, single-running policy

Identical policy to Crawl (OCR), reimplemented on the `ecom_*` tables:

- `POST /api/ecom-crawl/jobs` never rejects — a new job is created `queued` and the worker's claim
  loop (oldest `created_at` first, `FOR UPDATE SKIP LOCKED`) auto-runs it once whatever's ahead
  finishes. The response includes `queuePosition` (jobs already queued ahead).
- Only **actively running** work (`capturing`/`ocr`/`parsing`/`detail`) is capped at one at a time
  (`ux_ecom_jobs_single_running` partial unique index) — any number of jobs may sit `queued`. The
  worker daemon (`main.py`) is sequential across job types too: one process, one browser session
  total, `ecom` and `ocr` claims interleave rather than running concurrently.
- **Retry** (`POST /ecom-crawl/jobs/:id/retry`, capped at `MAX_ECOM_RETRIES = 3`, `db/ecomJobs.ts`)
  reuses the same job row/`storage_dir` and resumes from `manifest.json` rather than starting over —
  `run_ecom_job()` (`pipeline.py`) loads any prior manifest, seeds already-captured items so they're
  never re-navigated, and Stage B skips indices already present in `ecom_products`
  (`get_ecom_done_indices`, idempotent upsert either way).
- Partial results always survive: `/results`, `/analysis`, and `/export` never gate on job status —
  a `failed`/`blocked` job still has whatever it captured fully viewable/exportable.

## Config / env vars

Worker (`business_scout_worker/settings.py`):

| Var | Default | Purpose |
|---|---|---|
| `ECOM_CAPTURES_DIR` | `./storage/ecom_captures` | On-disk capture root |
| `ECOM_HEADLESS` | `true` | Headless Chromium (set `false` locally to watch the browser) |
| `ECOM_NAV_TIMEOUT_MS` | `45000` | Per-navigation timeout |
| `ECOM_DEVICE_SCALE` | `2` | Screenshot DPI multiplier — same OCR-readability rationale as the Maps module: never zoom out, it shrinks glyphs and wrecks OCR |

Node (`backend/api/src/config.ts`):

| Var | Default | Purpose |
|---|---|---|
| `ECOM_CAPTURES_DIR` | `./storage/ecom_captures` | Must match the worker's value — both processes read/write the same job folders |

Shared with the OCR module (not reconfigured per-module): `TESSERACT_CMD`, `OMP_THREAD_LIMIT`,
`OCR_CONCURRENCY` — see `md/OCR_CRAWL.md`'s "OCR-readability core & performance" section.

## How to run a job

1. `POST /api/ecom-crawl/jobs` with `{ platform: "noon" | "amazon", query, sortMode?, maxPages?,
   maxProducts?, detailScrapeTopN?, scoreWeights? }` (all optional fields have DB/schema defaults —
   see `schemas/ecomCrawl.ts`). Requires `operator` role.
2. Poll `GET /api/ecom-crawl/jobs/:id` (`{ job, progress: { total, captured, ocrDone, detailDone } }`)
   until `status === "ready"` (or a terminal failure).
3. `GET /api/ecom-crawl/jobs/:id/results` for the raw rows, or `GET
   /api/ecom-crawl/jobs/:id/analysis` for the scored summary.
4. `GET /api/ecom-crawl/jobs/:id/export?format=csv|xlsx|json` to download.
5. On `failed`/`blocked`, `POST /api/ecom-crawl/jobs/:id/retry` (up to 3 times) to resume.

## API

| Route | Behavior |
|---|---|
| `POST /api/ecom-crawl/jobs` | `{platform, query, sortMode?, maxPages?, maxProducts?, detailScrapeTopN?, scoreWeights?}` → `{job, queuePosition}` — never rejected, queues behind any job already running. `operator` role required. |
| `POST /api/ecom-crawl/jobs/:id/retry` | Resumable retry of a `failed`/`blocked` job (capped at 3) → `{job, queuePosition}`. `operator` role required. |
| `GET /api/ecom-crawl/jobs` | List all jobs |
| `GET /api/ecom-crawl/jobs/:id` | Status + `{progress: {total, captured, ocrDone, detailDone}}` (poll) |
| `GET /api/ecom-crawl/jobs/:id/results` | Parsed product rows (`{products}`) — never gated on job status |
| `GET /api/ecom-crawl/jobs/:id/analysis` | Scored summary (`{analysis}` — see `build_summary()` above) — never gated on job status |
| `GET /api/ecom-crawl/jobs/:id/export?format=csv\|xlsx\|json` | Download (xlsx via exceljs — never the vulnerable `xlsx` npm package; `json` is a format this module has that the OCR export deliberately doesn't) |
| `GET /api/ecom-crawl/jobs/:id/images/*` | A captured screenshot (read-only, path-traversal-guarded, 404 after retention purge) |
| `DELETE /api/ecom-crawl/jobs/:id` | Remove DB rows (cascades to `ecom_products`/`ecom_logs`) + the on-disk job folder. `operator` role required. |

## Architecture & files

| Layer | Files |
|---|---|
| Schema | `db/migrations/1785000000000_ecom-crawl.sql` — `ecom_jobs`, `ecom_products`, `ecom_logs` (own FKs, single-running partial-unique index) |
| Node API | `routes/ecomCrawl.ts`, `db/ecomJobs.ts` + `db/ecomProducts.ts`, `services/ecomExportService.ts` + `services/ecomAnalysisService.ts`, `schemas/ecomCrawl.ts` |
| Worker models | `business_scout_worker/ecom/models.py` (`EcomJob`, `DomProductFields`, `CapturedProduct`, `EcomManifest`, `DomDetailFields`, `ParsedProduct`) |
| Worker (Stage A capture) | `ecom/capture.py` (`EcomCaptureEngine`) |
| Worker (adapters) | `ecom/adapters/base.py` (`PlatformAdapter` contract), `ecom/adapters/noon.py`, `ecom/adapters/amazon.py`, `ecom/adapters/aliexpress.py` (stub), `ecom/adapters/__init__.py` (`get_adapter` registry) |
| Worker (Stage B parse) | `ecom/parse_product.py` |
| Worker (Stage C scoring) | `ecom/analysis.py` (`compute_opportunity_scores`, `build_summary`) |
| Worker orchestration | `ecom/pipeline.py` (`run_ecom_job`), `ecom/jobs.py` (DB access + `write_log`), wired into `main.py` (LISTEN `ecom_crawl_jobs`) |
| Tests | `backend/worker/tests/test_ecom_parse.py`, `test_ecom_adapters.py`, `test_ecom_analysis.py`; `backend/api/src/services/ecomExportService.test.ts` |

## Known risks / where to look first

- **amazon.ae bot detection**: Amazon serves a CAPTCHA (`#captchacharacters`) far more readily than
  noon under sustained automated traffic. `AmazonAdapter.is_blocked()` checks for it and the
  `_CAPTCHA_TEXT` body-text signal; if a job is unexpectedly `blocked` on amazon, check there first.
- **noon's sort-key mapping — CONFIRMED CORRECT (2026-08-07)**: `NoonAdapter.search_url()`'s
  `sort[by]=best_rating&sort[dir]=desc` param was live-verified against `noon.com/uae-en/search/`
  — the page's own "Sort By" control shows "Best Rated" selected when this URL is loaded. No
  longer an open risk; `price_asc`/`price_desc`/`relevance` remain unverified by the same standard
  (implemented from the same observed URL-shape pattern, not yet confirmed against a live page).
- **noon's card selectors — FIXED + VERIFIED END-TO-END (2026-08-07)**: the original card/field
  selectors were all wrong (guessed, never checked). Corrected against live noon DOM (via CDP) and
  proven by a real `rice cooker` capture — 10+ products with correct title/price(AED)/rating
  (4.5–4.8)/badges ("#1 in Rice Cookers", "Free Delivery", "Selling out fast"):
  - **Card container**: `div[data-qa="plp-product-box"]` (was `product-card`/`productContainer`,
    both matched 0). Naturally excludes the top sponsored banner cards (they lack it).
  - **title/price**: `plp-product-box-name` / `plp-product-box-price strong` (were
    `product-name`/`product-price`).
  - **rating/review**: no `data-qa` hook exists — matched via CSS-module class *prefix*
    `_textCtr_`/`_countCtr_` (the stable part of noon's per-build-hashed names). review counts
    render as `"23.7K"` (K/M-suffix parsing added).
  - **badges**: the `_nudgeText_` marquee strip (rank-in-category / stock / delivery nudges), not
    the old `pick-badge`/`badge` guesses.
  - **product_key (SKU)**: noon URLs are `.../<SKU>/p/?o=<tracking>` — SKU is BEFORE `/p/`, not
    after (the shipped regex matched nothing, so cross-page dedup silently fell back to the
    tracking-param'd href). Fixed + regression-tested.
  If a future noon redesign reshuffles the source class names (not just the hash suffix), re-inspect
  a live card via the host runner + a fresh `--max` job; the OCR fallback backstops any gap
  meanwhile.
- **Selector fragility (amazon, and noon beyond what's confirmed above)**: card/field selectors
  carry 2-3 fallbacks each (role/aria/data-qa-over-class-name, mirroring `ocr/selectors.py`'s
  philosophy) but e-commerce SPA class names drift. If `extract_card()` starts returning
  mostly-empty `DomProductFields` (pushing everything onto the OCR fallback and inflating
  `needs_review` rates), the adapter file for that platform is the first place to check, then
  re-run a small job to see the live DOM (`backend/worker/smoke_ecom.py` is an untracked ad hoc
  script for exactly this — bypasses the DB/queue, prints extracted fields for the first several
  cards of one query per platform).
- **`parse_product.py`'s regex coverage is intentionally narrow** — see the test suite
  (`test_ecom_parse.py`) for documented gaps: review/bought-count "K"-suffix formats (e.g. "1.7K",
  "1K+") and dash-style discount badges (e.g. "-13%") are not recognized by the current regexes.
  **Note this is a *different* code path from the noon `_parse_review_count` fix above** —
  `parse_product.py` only runs on OCR'd screenshot text (Stage B fallback); noon's own
  `_parse_review_count` (in `noon.py`, DOM-extraction path) was separately fixed to handle the
  "23.7K" K/M-suffix format noon actually renders, confirmed against the real sample above. The
  OCR-side K-suffix gap remains open — matters only when noon's DOM selectors miss the field.
- **amazon.ae review-count/"bought in past month" not yet confirmed present on real listings**: the
  2026-08-07 live Amazon run (8 real "camera" results, correct titles/prices/ratings/review counts/
  free-delivery flags, `product_url`/ASIN extraction all correct, sort order verified
  non-increasing) never actually observed a "bought in past month" badge on any sampled product —
  so that field's extraction logic is implemented but has zero live confirmation either way.
