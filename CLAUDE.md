<!-- Authored by: Mohit Singh -->

# business-scout-ai

**Type**: standalone nearby-business discovery/enrichment crawler | **Author**: Mohit Singh

## What this is

Discovers nearby businesses by type within a configurable map radius, enriches them into a shared master
database, and exposes that data via a public API for downstream consumers. Not part of any other repository —
own Postgres, own deploy, own history.

The frontend originated from a Lovable-generated scaffold. **This project's documentation and authorship make no
reference to Lovable** — see "File authorship" below. The scaffold's functional build tooling
(`@lovable.dev/vite-tanstack-config` in `vite.config.ts`) is kept as-is where removing it would add risk for no
functional benefit; this is a deliberate, documented choice, not an oversight.

## Architecture — exactly 2 application images + 1 dedicated database

```
frontend (repo root, Dockerfile)  --HTTP/SSE-->  backend (backend/Dockerfile, ONE image)
  TanStack Start, pure API client                  supervisord runs 2 sibling processes:
                                                      · Node API (backend/api)  — the only HTTP surface
                                                      · Python worker (backend/worker) — the crawler daemon
                                                    Node <-> Python: DB only, never HTTP/IPC
                                                        |
                                                        v
                                              PostgreSQL (new, dedicated instance — see skills_devops.md)
```

- **Frontend** (repo root — kept in place, not moved to a subfolder; see `.claude/skills/skills_frontend.md`).
- **Backend** = one image, two processes: `backend/api/` (Node/Express, TypeScript strict) and
  `backend/worker/` (Python, `mypy --strict`) — the crawler engine (Overpass discovery → tiered enrichment →
  optional AI extraction). They communicate **only through Postgres** (`LISTEN`/`NOTIFY` + shared tables).
- **Database**: plain PostgreSQL, a brand-new dedicated instance for this project only — see
  `.claude/skills/skills_devops.md` for the exact container name/volume/port/credentials. Never reused from, or
  shared with, any other project on the same host.

Full architecture rationale, the requirement-coverage matrix, the phased build plan, and every design decision:
**`md/plans/0001-business-scout-ai-crawler.md`** (this project's first approved plan).

## Current status (updated 2026-07-13 — read this first when resuming work)

**Phases 0-8 are all code-complete** (`md/plans/README.md` tracks the authoritative phase status).
Phases 0-3 were live-verified end-to-end via a real `docker compose` run (login → launch a crawl →
64 real Berlin libraries discovered via Overpass and enriched from their real websites, no mocking).
**Phases 4-8's code is written, typechecked/linted/unit-tested (all green), but the equivalent live
`docker compose` + integration-test verification has NOT been re-run yet** — that's the single
remaining task before this is fully "shipped," deferred to one consolidated end-of-session pass per
explicit user instruction ("complete all dev first and then test together at the end"). Don't assume
Phases 4-8 work in a live container until that pass has actually happened — re-run it before relying
on this status for a deploy decision.

- **Phase 0-1**: scaffold, quality gates, full DB schema + migrations, typed data-access both runtimes.
- **Phase 2**: JWT auth, jobs/businesses/fields/settings/stats/geocode REST API with SSE, all 7
  frontend screens wired to the real API (zero mock data). Fixed a real bug: cookies shipped
  `Secure` over the plain-HTTP local `docker-compose.yml`, which silently breaks login in any real
  browser — see `COOKIE_SECURE` in `backend/api/src/config.ts` and skills_security.md.
- **Phase 3 (the first shippable milestone)**: Overpass discovery (`backend/worker/business_scout_worker/
  discovery/`), Tier-1 website enrichment (`enrich/`), exact dedupe (`dedupe.py`), the job daemon
  (`main.py`/`jobs.py`/`pipeline.py` — LISTEN/NOTIFY + atomic claim + pause/cancel/graceful-shutdown).
  Two real bugs found via the live verification run and fixed (both documented in
  `skills_backend_python.md`): Overpass rejecting requests without a form-encoded body + User-Agent,
  and a phone-extraction regex picking up SVG/CSS/script markup noise instead of visible text.
- **Phase 4 (enrichment depth)**: Tier-2 Playwright fallback (`enrich/tier2.py`, escalates only on a
  JS-shell heuristic, resource-blocked), `phonenumbers` E.164 normalization + hand-rolled
  `opening_hours` parsing (`parse/`), `rapidfuzz` fuzzy secondary dedup (soft-merge via
  `businesses.merged_into_id`, never deletes — see `dedupe.py`), robots.txt + per-domain rate
  limiting + retry (`enrich/policy.py`). **`pypostal` deliberately excluded** — no real free-text-
  address caller exists (OSM already gives structured tags) and it fails to install on a plain
  Windows dev box (needs libpostal + a C toolchain); documented, not silently dropped.
  ⚠️ A real Docker/Playwright version-mismatch bug was found and fixed
  (`backend/Dockerfile`'s base image tag must exactly match `playwright`'s pinned pip version —
  see the comments in both files) but **not yet re-verified with a fresh container build** — do
  that first in the consolidated test pass (`docker compose up -d --build backend`, then exec in
  and launch Chromium).
- **Phase 5 (AI extraction)**: provider-agnostic `llm.py` (one OpenAI-compatible
  `/v1/chat/completions` client — Gemini/OpenAI/Ollama via `LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`
  env vars), structured-JSON output + one retry + per-`(domain,field,prompt)` cache, gated by the
  DB-side `crawl_settings.use_ai_extraction` toggle. Wired into `pipeline.py`'s `_run_ai_extraction`
  — writes into `businesses.extras.{key}`, isolated in its own try/except so an LLM/DB hiccup never
  retroactively fails an already-successful Tier-1 enrichment.
- **Phase 6 (manual Google enrichment)**: `POST /businesses/:id/enrich-google` (Node,
  `services/googleEnrichmentService.ts` + `lib/googlePlaces.ts` — Find Place + Place Details, 1h
  cooldown on repeat clicks), gated by `GOOGLE_API_KEY`; frontend "Fetch rating" button (per-row +
  bulk-select) on the Businesses screen, hidden/disabled via `GET /businesses/google-enrichment-status`.
- **Phase 7 (exports + public API)**: `POST /exports` (xlsx/csv/json, batched/streamed generation —
  `exceljs` for xlsx, never uses the vulnerable `xlsx`/SheetJS npm package), `GET /exports` (history),
  `GET /exports/:id/download`, hourly retention-cleanup sweep (`server.ts`). Frontend Exports screen
  fully wired (was still a Lovable-era static mock until this pass — fixed). Public
  `GET /api/v1/businesses` (api-key auth, `Authorization: Bearer <key>` or `X-API-Key`),
  `GET /api/v1/openapi.json` (unauthenticated spec).
- **Phase 8 (hardening)**: observability (`system_metrics` table + `businesses.enrichment_tier`,
  `GET /stats/system` — job success rate, failure-spike alarm, tier-hit ratio, LLM/Google call
  counts); security pass (rate limiting on login + public API via `express-rate-limit`, full authz
  audit — every route already deny-by-default, no gaps found; dependency scan — **removed the
  unused, vulnerable `xlsx` npm package from the frontend** (high-severity, no fix available,
  never actually imported by any code — pure leftover risk), bumped `pytest` to fix
  PYSEC-2026-1845, confirmed no real secrets tracked in git); performance (`DB_POOL_MAX` /
  `db_pool_min`/`db_pool_max` made explicit and tunable in both runtimes — psycopg_pool's default
  `max_size=None` effectively caps the worker at 4 connections, too few once several businesses in
  a batch are writing concurrently).
- **Post-Phase-8 live-verification fixes (2026-07-13, all verified against the running stack)**:
  the frontend runtime image was missing Nitro's sibling `server/`+`public/` layout (every asset
  500'd — see the root `Dockerfile`'s runtime-stage comment); the backend now **runs migrations on
  container start** (`backend/docker-entrypoint.sh` — closed a real schema-drift incident where an
  unapplied migration made every enrichment fail with "column enrichment_tier does not exist"
  while discovery worked fine); discovery is now shutdown-interruptible (a container restart
  mid-Overpass-call used to orphan the job in 'discovering' forever); Docker builds are
  dependency/source layer-split + BuildKit-cache-mounted (source-only rebuild ~26s, full cached
  up ~41s); the public-API rate limiter's IP fallback is IPv6-safe (`ipKeyGenerator`). End-to-end
  proof: a real Delhi "Gym" crawl — 120 discovered, 120 crawled, 0 failures.
- **Crawl (OCR) add-on module** (`md/OCR_CRAWL.md`): a *parallel job type* to the Overpass crawler
  that opens each Google Maps business's place page and captures structured contact data + a
  screenshot audit trail. Same DB-as-queue seam: `ocr_jobs`/`ocr_businesses` (migrations
  `1784000000000`, `1784100000000` current_business, `1784200000000` image_url), Node
  `routes/ocrCrawl.ts` + `db/ocrJobs.ts`, Python `business_scout_worker/ocr/` (capture via
  Playwright + Stage-B Tesseract/parse), UI `src/routes/ocr-crawl.tsx` ("Crawl (OCR)" nav).
  **Verified live end-to-end (2026-07-25, 15/15 Al Nahda-Dubai gyms, 0 failures/timeouts):**
  - **Capture navigates to the place `href`, never clicks the result card** — a live diagnostic
    proved a programmatic click does not reliably open the detail panel on the current Maps DOM
    (every click timed out with only the feed's own `role=main` present); `page.goto(href)` opens
    the place view directly and is both more robust and faster. Two Playwright pages: one stays on
    the search feed (scrolling/collecting hrefs), a second navigates per-business.
  - **Phone/website/address/plus-code/rating/category/hero-image come from `data-item-id`
    DOM attributes** (`_extract_dom_fields` in `capture.py`), not OCR — exact, no misreads. OCR
    (Tesseract) is the fallback for whatever the DOM doesn't expose, plus the visual audit trail.
    Live proof: 15/15 phones and ratings correct; the earlier reported "OCR can't read the phone"
    bug doesn't reproduce once DOM extraction is used instead of pixel-reading it.
  - **Review count is NOT reliably obtainable**: an anonymous/logged-out Playwright session gets
    Google's "You're seeing a limited view of Google Maps" degraded mode, which omits review count
    from both the place page and the search feed cards (confirmed: same business shows it in a
    real logged-in browser, not in ours). Getting it back requires a real Google account login,
    which is a deliberate non-goal (ToS/detection risk — see below). `review_count` stays null on
    this data source; treat it as a known gap, not a bug to keep chasing.
  - **Tesseract: `OMP_THREAD_LIMIT=1`** — measured 5.5x SLOWER (16.1s vs 2.9s) multi-threaded on
    this app's image sizes; set at both the Python module level and docker-compose.
  - **`OCR_CONCURRENCY`** (default 3, `settings.ocr_concurrency`) — Stage B now runs this many
    businesses' OCR concurrently (`asyncio.Semaphore` + `asyncio.gather` in `pipeline.py`), each
    call still single-threaded internally. Orthogonal to the OMP fix above: that fix is about one
    image being slower multi-threaded internally; this is about using multiple CPU cores across a
    batch by running several single-threaded calls in parallel.
  - Progress counters (`captured_count`/`ocr_done_count`/`current_business`) update correctly
    through both capture and OCR phases and denominate against `max_results`, not a racing
    discovered-count.
  - **Radius search + grid tiling (2026-07-25, `md/OCR_CRAWL.md`)**: `centerLat`/`centerLng`/
    `radiusKm` on job creation → exact haversine filter against each business's own href-derived
    coordinates (never a soft Maps-viewport guess). A radius bigger than one `cell_radius_km`
    (default 2km) is tiled into overlapping sub-searches (`generate_grid_cells`, ring-based) so
    Maps' relevance/stagnation cap doesn't silently crowd out real businesses in a big region —
    walked sequentially within the same single Chromium session (never concurrent Maps
    automation). Cross-cell duplicates deduped by Google's own place id (href's `!1s{hex}:{hex}`,
    exact) with a fuzzy name+phone fallback pass. `ocr_businesses` gained `lat`/`lng`/
    `distance_km` + `image_url` (hero photo, DOM-sourced). `radiusKm` accepts up to 300km;
    `generate_grid_cells`'s `MAX_GRID_CELLS = 60` auto-widens `cell_radius_km` at very large radii
    so job duration stays bounded rather than spawning thousands of sequential sub-searches. The
    center point comes from either "Use my location" (browser Geolocation) or pinning a typed
    address via the existing `/geocode` Nominatim proxy (same one Discover already used) — both
    write `centerLat`/`centerLng`.
  - **Queueing (2026-07-25)**: `POST /ocr-crawl/jobs` never 409s anymore — a new job queues
    (`queuePosition` in the response) and auto-runs the moment whatever's ahead finishes
    (`main.py`'s claim loop already re-checks immediately; only the DB constraint changed, from
    "≤1 job in queued/capturing/ocr/parsing" to "≤1 job actively **running**"). Still never more
    than one concurrent automated Maps session — the safety property is unchanged, only the
    submit-time UX (no more manual resubmit-and-wait).
  - **`OCR_CRAWL_MAX_RESULTS`/`ocr_max_results`**: the per-job result cap moved from a static env
    ceiling (200) to `crawl_settings.ocr_max_results` (DB-configurable, default 1000, Settings
    screen slider), enforced at request time via `getCrawlSettings()`.
  - **Resumable retry (2026-07-26, `md/OCR_CRAWL.md`)**: `POST /ocr-crawl/jobs/:id/retry` (capped
    at `MAX_OCR_RETRIES=3`) resumes a `failed`/`blocked` job from wherever it stopped — never from
    zero. Reuses the SAME job row (no new id, no image relocation): `capture.py` now checkpoints
    `manifest.json` after **every** capture (not just at run's end), `pipeline.py` reloads it on
    claim and seeds the walk to skip already-captured hrefs (`_seed_from_resume`), and Stage B
    skips indices already present in `ocr_businesses`. Partial results (whatever was captured
    across all attempts) always stay viewable/exportable even if the job never reaches `ready` —
    `/results`/`/export` never gated on status, and the UI's results table now also renders for a
    failed/blocked job with `captured_count > 0`. New column: `ocr_jobs.retry_count`.
  - **Dashboard reporting (2026-07-26)**: the Overview screen (`GET /stats/overview`,
    `db/stats.ts`) previously only reported the main Overpass crawler — OCR was invisible there.
    `getOverviewStats()` now also returns `ocrBusinessesCount`/`ocrJobsThisWeek`/
    `ocrActiveJobsCount`, kept as distinct fields (never merged into `crawlsThisWeek`/
    `activeJobsCount` — two different job vocabularies and volume profiles). The Overview page
    (`src/routes/index.tsx`) gained a "Crawl (OCR)" card — a summary line + the 4 most recent OCR
    jobs (reusing the existing `useOcrJobs()` hook, no new endpoint needed for the list) with a
    "View all" link to `/ocr-crawl`. `StatusBadge` (`components/status-badge.tsx`) gained styles
    for OCR's own status vocabulary (`ready`/`capturing`/`ocr`/`parsing`/`blocked`) — it previously
    only covered the main crawler's statuses and silently fell back to the "queued" (gray) style
    for all of these.
  - **Live crawl logs (2026-07-26)**: OCR jobs previously wrote activity only to structlog/stdout
    — invisible on the dashboard's "Live crawl log" panel, which only ever read `crawl_logs` (main
    crawler). New `ocr_logs` table (own FK to `ocr_jobs`, same `log_level` enum, migration
    `1784700000000`); `ocr/jobs.py write_log()` mirrors the main crawler's, called from
    `pipeline.py` at job start/resume/per-business-capture/capture-done/OCR-stage-start/ready/
    blocked/failed. `GET /logs/stream` (`routes/jobs.ts`) now runs two parallel queries
    (`listRecentLogs` + `listRecentOcrLogs`, two independent bigint cursors since they're separate
    sequences), tags each entry `source: 'crawl'|'ocr'`, and merges+sorts by `ts` before sending.
    Frontend (`index.tsx` + `jobs.tsx`, both consumers of the same stream) render an "OCR" badge on
    tagged entries and key list items by `${source}-${id}` — a real key-collision fix, since the
    two tables' IDs aren't unique across each other.
  Needs `tesseract-ocr` (apt in Dockerfile) + pytesseract/Pillow/opencv-headless. Retention purge
  of `raw/` PNGs, CAPTCHA→`blocked` stop.
  **⚠️ ToS: automating Maps violates it — low-volume/internal only; Places API is the compliant
  path for the same fields.**
- **Marketing / Messaging outreach tool (2026-07-26, `md/MARKETING.md`)**: acts on the discovered
  businesses — WhatsApp + Email outreach to onboard them. New sidebar group **Marketing**
  (`/marketing` composer, `/marketing/campaigns` history). Recipients come from an uploaded
  CSV/XLSX AND/or selected finished OCR jobs, **deduped to unique businesses** carrying
  type+location (`lib/recipientParse.ts`). **WhatsApp = click-to-chat + vCard** (no automation, no
  credentials, ToS-safe): per-business `wa.me` deep link opens WhatsApp with the curated message
  pre-filled (operator presses Send), and a `.vcf` export saves every business by name into
  contacts. **Email = SMTP (nodemailer)** with inline CID images, `{business_name}`-style
  placeholders (`lib/placeholders.ts`), throttled bulk send, test-send, **unsubscribe footer +
  suppression list** (public HMAC-token `/unsubscribe`). SMTP password is **AES-256-GCM** at rest
  (`lib/messagingCrypto.ts`, key = `MESSAGING_ENCRYPTION_KEY` env; absent ⇒ email creds disabled,
  wa.me/vCard still work), never returned to the client. Migration `1784800000000` adds
  `email_credentials`/`message_templates`(+images)/`campaigns`/`campaign_recipients`/
  `email_suppressions`. New dep: `nodemailer` (lazy-imported in `emailService` to stay out of the
  hot import graph). New env: `MESSAGING_ENCRYPTION_KEY` + `APP_PUBLIC_URL` (unsubscribe-link base).
  Backend `routes/marketing.ts`; frontend `routes/marketing.tsx` + `hooks/useMarketing.ts`.
  ⚠️ Same cold-outreach ToS/legal posture as the Maps scraping — compliance guardrails are the
  responsible-use minimum; volume stays low/manual.
- **Marketing v2 (2026-07-27, `md/MARKETING.md`)**: Contacts (`marketing_contacts` — manually-added
  reusable recipients via a "+ Add business" form, merged into recipient preview by `contactIds`);
  curated business-type-aware templates (nullable `message_templates.business_type`, seeded via
  upsert in `scripts/seed.ts` so content edits actually apply on re-run — every message links
  `https://portal.c7corp.com` as a plain URL for link-preview unfurling); email attachments beyond
  inline images (`message_template_images.is_inline` — false = a plain `Content-Disposition:
  attachment`, e.g. a PDF); per-campaign Excel report + in-app Failed panel
  (`services/campaignExportService.ts`, `GET /marketing/campaigns/:id/export` — Summary/Recipients/
  Failed-only sheets). **`backend/whatsapp-sender/`** — a new local-only third package (sibling to
  `backend/api`/`backend/worker`, never in `docker-compose.yml`) drives the operator's own WhatsApp
  Web session via a visible Playwright browser for real automated bulk send, built after the
  operator explicitly re-confirmed wanting true automation despite the ToS/ban-risk v1 had
  deliberately avoided. Guardrails: randomized inter-send delay + a persisted daily cap
  (`rateLimiter.ts`), a `npm run test-send` trial-send step (default `+919560397112`) required before
  ever touching real leads, and a risk-acknowledgment confirm dialog on the frontend's **⚡ Start
  Automated Send** button (`hooks/useWhatsappAgent.ts`, talks directly to the local
  `127.0.0.1:8787` agent — a different process from the main backend; "not detected" is the expected
  default state). Migration `1784900000000` adds `marketing_contacts` +
  `message_templates.business_type` + `message_template_images.is_inline`. `normalizePhone` now
  infers `+91` for a bare 10-digit Indian mobile number (found live-verifying v1 — the same business
  listed with vs. without a country code was surviving dedup as two recipients).
- **Backend HTTP keep-alive fix (2026-07-27, `server.ts`)**: intermittent `ECONNRESET`/recv-failure
  on requests from both curl and the real browser UI, with **no** matching log line on the backend
  (the request never reached Express) — root cause was Node's default `keepAliveTimeout` (5s) racing
  against any client that reuses a connection across requests (every browser, and curl within a
  session); Docker Desktop's Windows/WSL2 network translation adds enough latency to make this race
  hit often in practice. Fixed by explicitly setting `server.keepAliveTimeout = 65_000` and
  `server.headersTimeout = 66_000` (must stay greater) on the `http.Server` returned by
  `app.listen()`. Verified live: 6 rapid sequential POSTs succeeded, and a POST → 7s wait (past the
  old 5s default) → POST again on the same connection both returned 201. If this exact symptom
  reappears (connection reset, zero backend log line for that request), check this setting first
  before assuming an application bug.
- **WhatsApp automation reliability fixes + Automation/Manual send split (2026-07-28,
  `md/MARKETING.md`)**: the operator's WhatsApp account got restricted by WhatsApp's own anti-spam
  system for automated/bulk messaging. Before that happened, a chain of real bugs in
  `backend/whatsapp-sender/` were found and fixed while debugging why sends weren't going
  through: a login-readiness selector that matched the QR screen as "ready" (login never actually
  persisted), zombie Chromium processes left holding the profile lock after an abrupt kill (silent
  `about:blank` hang on the next launch), no flush-before-close (WhatsApp's session lives in lazily-
  written IndexedDB), a missing composer-focus click before `Enter` (messages silently stayed
  drafts), an unhandled "Continue to Chat" interstitial for first-time numbers, and a double-decode
  in `campaignRunner.ts` (`decodeURIComponent()` on an already-decoded `URLSearchParams.get()`
  value) that crashed on any message containing a bare `%`. `npm run agent` now runs under
  `tsx watch` so a long-running process can't keep serving pre-fix code. Full list + root causes:
  `md/MARKETING.md`'s WhatsApp browser automation section. **After** the restriction, since
  automation now carries real risk, the WhatsApp send step's UI was split into two clearly labeled
  sections — amber "AUTOMATION (ban risk)" (unchanged) and green "MANUAL (zero risk)": a new
  `ManualSendPanel` fast keyboard-driven single-recipient flow (`Enter`=open+mark sent via
  `web.whatsapp.com` not `wa.me`, `S`=skip, `Ctrl+Z`=undo via a new `mark-pending` endpoint), all
  three status mutations optimistic for instant advance. Verified live in a real browser against the
  running Docker stack, not just automated tests.
- **Property Research add-on module (2026-08-22/23, `md/PROPERTY_CRAWL.md`)**: a *third* parallel
  job type — searches dubizzle.com/propertyfinder.ae for a location + bedroom/bathroom/property-type/
  ready-or-off-plan filter, captures every listing, scores each as a "distress deal" (best value for
  money — price-per-sqft + distress-language + freshness + verification), and for the top-N ranked
  listings reveals a phone number and builds a `wa.me` WhatsApp link. Same DB-as-queue seam as
  ecom/OCR: `property_jobs`/`property_listings`/`property_logs` (migration `1785300000000`), Node
  `routes/propertyCrawl.ts` + `db/propertyJobs.ts`/`propertyListings.ts`, Python
  `business_scout_worker/property/` (own capture engine, own OCR-fallback parser, own scoring — zero
  imports from `ecom/`/`ocr/`), UI `src/routes/property-crawl.tsx` ("Property Research" nav).
  **Both platforms are `REQUIRES_CDP`** — dubizzle returns an empty-body 200 and propertyfinder a
  bare 403 under plain headless Chromium; there is no container-daemon claimant for this module at
  all, only the operator-run host runner (`run_property_host.py`, `PROPERTY_HOST_WATCH=1` poll loop,
  default 15s — no `pg_notify`, since there's nothing headless to wake).
  - **Extraction is `data-testid`-selector-first, regex fallback second** (confirmed live
    2026-08-22 via the operator's real Chrome over CDP) — this is the PRIMARY, stable path for both
    adapters (`adapters/dubizzle.py`/`adapters/propertyfinder.py`); the original innerText-regex
    heuristics (`parse_property.py`, shared by both adapters for whatever a testid selector doesn't
    find) are now defense-in-depth, not the primary path. Three real bugs found/fixed this way:
    `BEDROOMS_RE` missed hyphenated forms ("2-Bedroom"/"2-bhk" — no whitespace between digit and
    label); dubizzle's "WhatsApp" contact-button text was winning as the guessed location
    (`_UI_ACTION_WORDS` blocklist fixed it); `description` selector matched nothing on the real MUI
    markup (fixed to `[data-testid="description"]`, and the preceding "Read More" click turned out
    unnecessary AND actively harmful — a stray promo modal could intercept it and abort the whole
    extraction block).
  - **propertyfinder was returning 0 results — two independent, confirmed-live root causes, both
    fixed (2026-08-22)**: the search path was `/en/search/{purpose}` (a bare 404 on the real site;
    correct path is `/en/search`, purpose controlled by `fu=0|1`), and the location param was
    `q=<free text>` (silently ignored — propertyfinder has no free-text location search on this
    endpoint; the real working param is `l=<numeric id>&t=1`, the id resolved from a public,
    unauthenticated GET to `{BASE_URL}/b2c-location/api/v1/en/locations` once per job — new adapter
    hook `resolve_location()` in `adapters/base.py`, called before pagination begins since
    `search_url()` itself must stay synchronous). Once real results loaded, price/beds/baths came
    back `None` for the same reason as the description bug above (no "AED"/"Bed"/"bath" text next to
    a bare number+icon on this site) — fixed via the same testid-first pattern
    (`property-card-price`/`-spec-bedroom`/`-spec-bathroom`/`-spec-propertyType`/`-location`,
    confirmed live). Also fixed: the card's first `<img>` was always a lazy-load placeholder (real
    photos are a placeholder+real-src PAIR per image slot); "Listed N months/years ago" (not just
    "N days ago") left freshness blank (`parse_property.py`'s `LISTED_AGO_UNIT_RE`, ~30/365 day
    approximation).
  - **Ready vs. off-plan filter** (`property_jobs.property_status`, defaults `"ready"` — confirmed
    preference): no confirmed server-side URL param on either platform, so enforced client-side at
    capture time (`capture.py`) against each card's own `is_offplan` flag — dubizzle's real
    `[data-testid="offplan-badge"]` element (presence = off-plan), propertyfinder's badge text
    containing the literal word "Offplan" (e.g. "Offplan: First Sale") — both confirmed live.
  - **Detail-page-only fields** (`age_years`/`average_rent`/`listed_date`/`phone_number`/
    `whatsapp_link`) — populated ONLY for the job's `detail_scrape_top_n` highest-scoring listings,
    and never fabricated: an off-plan listing genuinely lacking a "Property Age"/"Average Rent" field
    on the real site stays `null`, not guessed from general knowledge (explicitly declined a request
    to "look up ages on the internet" — that would attach an unverifiable number to a real listing
    someone might use to make a buying decision, with no way to tell it apart from a genuine
    site-sourced value).
  - **Wishlist, cross-search compare, per-row price refresh + drop highlight (2026-08-23)**:
    `property_wishlist` (migration `1785600000000`) is a save-for-later **snapshot** at click-time,
    not a live FK — a job (and its listings, `ON DELETE CASCADE`) can be deleted/re-run at any point,
    but a saved listing keeps showing what the operator saved; de-duped on `listing_url` (the real
    site URL — the one stable identity a listing has across separate job runs on different days).
    Compare-checkbox selection is held in frontend state keyed by listing id, **global across jobs
    on purpose** — checking a listing while viewing one job's results and then switching to a
    DIFFERENT job's results (which unmounts the first job's own results array) keeps it comparable,
    since the full snapshot is held in the selection itself, not re-derived from whichever job is on
    screen. Per-row "Refresh" re-visits that ONE listing's real URL live (new lightweight
    `property_listing_refreshes` queue, migration `1785700000000` — same claim pattern as
    `property_jobs` but far cheaper: no search/pagination, drained by the host runner BEFORE full
    search jobs every poll cycle, since a refresh is one quick page visit vs. a job that can run for
    minutes) via each adapter's own confirmed detail-page price selector (dubizzle's
    `[data-testid="listing-price"]` — confirmed the FIRST DOM match is the listing's own price, a
    "similar properties" carousel further down the page reuses the same testid but always sorts
    after it; propertyfinder's `[data-testid="property-price"]`, confirmed unique on the page) and
    updates the row's price in place. Results are enriched at read time
    (`listPropertyListingsWithHistory`) with `previous_price`/`price_dropped` — the price the SAME
    `listing_url` was captured at in the most recent EARLIER job (any day), correlated by a
    subquery — plus the latest completed refresh's own old/new price; a row highlights green with
    the old price struck through when either signal shows a genuine drop. **Verified live
    end-to-end** against the real running stack (not just unit tests): wishlist add/list/dedup/
    remove, a real refresh claimed+processed by the host runner updating a real row's price, and
    both the cross-job and refresh-triggered price-drop signals firing correctly (confirmed via
    direct DB inspection + the real `/results` API response).
  - **Gotcha hit mid-session**: `git stash`/`git stash pop` on Windows with `core.autocrlf=true`
    round-trips every touched file through CRLF conversion, which the project's prettier config
    flags — re-running `eslint --fix` scoped to just the touched files (never a broad
    `prettier --write .`/`eslint --fix .` across the whole repo — that reformats hundreds of
    unrelated files) fixes it cleanly, same as any other line-ending drift.
  - **Per-platform concurrency (2026-08-23)**: dubizzle and propertyfinder now run CONCURRENTLY —
    a running dubizzle job no longer blocks a queued propertyfinder job (or vice versa) from
    starting. The old GLOBAL "at most one job running" lock (`ux_property_jobs_single_running`,
    `UNIQUE ((true)) WHERE status IN (...)`) is narrowed to per-platform (migration
    `1785800000000`, `UNIQUE (platform) WHERE status IN (...)`) — two jobs on the SAME platform
    still can't run concurrently (they'd fight over the same site's pagination/rate-limit
    posture), but one of EACH platform now can. `run_property_host.py`'s single sequential
    claim-loop was split into one `_drain_platform_jobs()` loop PER platform, launched
    concurrently via `asyncio.gather` — each connects over CDP independently and opens its OWN
    Playwright Page within the SAME shared Chrome context (dubizzle.com/propertyfinder.ae are
    different origins, so cookie/session state never collides). `claim_pending_property_job` gained
    a required `platform` param (was global); Node's `countQueuedPropertyJobs` likewise (a queued
    job on the OTHER platform no longer sits "ahead of" this one in any real sense). **Verified
    live**: two real jobs (one dubizzle, one propertyfinder) queued at the same instant both showed
    `status='capturing'` simultaneously and their `captured_count`s climbed in lockstep
    (3-then-2, 8-then-7, 12-then-11...) until both independently reached `ready` at 15/15 — proof
    they ran as two genuinely separate, concurrent Playwright sessions, not a fast sequential
    illusion.
- **Product Research (ecom) — noon/amazon concurrency confirmed, independent of Property
  (2026-08-23, `md/ECOM_CRAWL.md`)**: amazon (headless, run by the container daemon
  `business_scout_worker.main`) and noon/aliexpress (CDP-required, run by the separate host
  process `run_noon_host.py`) were ALREADY architecturally able to run concurrently — no code
  change was needed. `ux_ecom_jobs_single_running`'s indexed expression
  (`platform = ANY(['noon','aliexpress'])`) only has two possible values, so it's actually TWO
  independent locks (one per group), not the single global lock its old code comment claimed —
  fixed the comment (`ecom/jobs.py`) since it was factually misleading. **Verified live**: a real
  amazon job and a real noon job both showed `status='capturing'` at the same time, with amazon
  completing (`ready`, 10/10) while noon was still mid-run, unaffected. Confirmed fully
  independent of Property Research too — own DB tables, own host-runner scripts, own claim logic
  (module-separation convention already in place); the two DO share the same physical operator
  Chrome window on port 9222 (by longstanding design, each opens its own Page within it — see
  `start-noon-host.bat`'s own comment), which is a resource-sharing convenience, not a coupling.
  Real remaining gap, NOT this session's scope: noon and aliexpress still serialize against each
  other (same CDP-group lock) — only worth revisiting if aliexpress sees real usage.
- **Host-runner reliability — self-heal + heartbeat (2026-08-23, `chrome_health.py`)**: both host
  runners attach to the SAME physical operator Chrome window, so Chrome dying previously took
  every CDP-required platform down SILENTLY — a job just failed with an ECONNREFUSED
  `error_message` and nothing else happened until a human noticed and manually re-ran the launcher
  .bat. Shared (infra-level, not business logic — same tier as `logging_config.py`/`settings.py`)
  `chrome_health.py` gives both `run_property_host.py` and `run_noon_host.py`:
  - `ensure_chrome_running()` — checked BEFORE claiming any job, every poll cycle. If CDP is
    unreachable, best-effort relaunches Chrome with the exact `--remote-debugging-port`/
    `--user-data-dir` flags `scripts/start-*-host.bat` use (same profile, so it attaches to
    whatever's already there rather than creating a second conflicting one), with a jittered
    delay + re-check first so the common case is only ONE of the two runners actually launches it
    when both notice the outage at the same moment. If unreachable, the whole poll cycle is
    skipped (no jobs claimed) — claiming a job then having it immediately fail would burn a real
    attempt (and, for a job, its retry count) over what's often a momentary Chrome closure.
  - `write_heartbeat()` — a `host_runner_status` row (migration `1785900000000`) UPSERTed every
    poll cycle regardless of whether there was work to do, so a STALE heartbeat means the process
    itself died, while a fresh heartbeat with `cdp_reachable=false` means the process is alive but
    Chrome is down — distinguishable failure modes. `GET /system/runner-status` (Node) + a shared
    `RunnerStatusBanner` component (property-crawl.tsx shows `property`, ecom-crawl.tsx shows
    `noon` — amazon needs no runner heartbeat, it's container-run) surface this as an in-app
    warning banner instead of a silently stuck queue.
  - **Verified live, end-to-end, the hard way**: killed the real debug Chrome process mid-session
    to test this — both runners detected the outage within one poll cycle, one of them (via the
    jitter/recheck race) actually relaunched it, and both fully recovered within ~15s with zero
    manual intervention, confirmed via `host_runner_status` heartbeats flipping back to
    `cdp_reachable=true`. **⚠️ Real mistake made while doing this test**: used
    `taskkill /F /IM chrome.exe`, which kills EVERY Chrome process system-wide, not just the debug
    instance — this also closed the operator's own regular browser windows/tabs. **Never do this
    again** — target only the debug profile's specific PID(s) (e.g. via `wmic process where
    "name='chrome.exe' and commandline like '%remote-debugging-port%'"`), never a blanket
    `taskkill /IM chrome.exe`.
  - `backend/api/src/__tests__/health.test.ts`'s per-test timeout was bumped 5s → 15s in the same
    pass (unrelated to this feature, found while running the full suite) — this test re-imports
    the whole app fresh on every case, and that import graph has grown enough across this
    project's life that it started genuinely exceeding vitest's 5s default under full-suite load.
    Not a race to chase; if it flakes again, the app has grown further and the fix is the same.
- **Recurring searches — Property Research scheduling (2026-08-23, `property_job_schedules`)**: a
  saved search (same criteria shape as `createPropertyJobSchema`, plus `intervalHours` 6–720) that
  re-fires itself automatically — the use case is a daily re-check of the same area, so the price-
  drop highlighting (`property_listing_refreshes` / `listing_url`-matched `previous_price`) has
  fresh data to compare against without a human re-launching the search every day.
  - **No new dependency, no cron.** `backend/api/src/server.ts` gained a THIRD boot+fixed-interval
    sweep (same pattern as the export/OCR retention sweeps already there) — every 5 minutes,
    `services/propertyScheduler.ts`'s `runDuePropertySchedules()` selects every `enabled` schedule
    whose `next_run_at <= now()`, calls the existing `createPropertyJob()` for each (identical to a
    human clicking Launch), and advances `next_run_at = now() + interval_hours`. The Python host
    runner needs ZERO changes — a schedule-created job is a completely ordinary `property_jobs` row,
    indistinguishable from a manually-launched one once it lands in the queue.
  - **Concurrency is an in-process flag, not a DB lock, and that's deliberate.** An earlier draft
    tried `FOR UPDATE SKIP LOCKED` inside `listDuePropertyJobSchedules()` to "claim" due rows —
    wrong, because each standalone `pool.query()` call auto-commits its own implicit transaction in
    `pg`, so the row lock is released before it could ever protect anything across calls. Fixed by
    dropping the DB-level claim entirely (`listDuePropertyJobSchedules` is now a plain `SELECT`) and
    relying on a `running` boolean inside `propertyScheduler.ts` — correct because this is a single
    Node process with one `setInterval` timer, not a multi-instance deployment. If this API ever
    runs as more than one process, this guard stops being sufficient and needs a real distributed
    lock (e.g. `pg_try_advisory_lock`).
  - **`property_job_schedules.created_by` is nullable** (`ON DELETE SET NULL`, since a schedule can
    outlive the user who created it) — `createPropertyJob()`'s `createdBy` param was widened from
    required `string` to `string | null` to match the real DB column nullability rather than papering
    over it with a fake `""` value (which would have violated `property_jobs.created_by`'s own FK on
    the next schedule fire).
  - **Frontend**: `usePropertyJobSchedules()`/`useCreatePropertyJobSchedule()`/
    `useSetPropertyJobScheduleEnabled()`/`useDeletePropertyJobSchedule()` in `usePropertyCrawl.ts`;
    `property-crawl.tsx` gained a "Repeat every ___ hours" input + "Save as recurring" button next to
    the existing Launch button (reuses every field already filled into the create-job form — no
    separate schedule-creation form), and a collapsible "Scheduled Searches" panel (same pattern as
    the existing WishlistPanel) listing each schedule's platform/location/filters/interval/next-run
    countdown/last-fired time, with a `Switch` to pause/resume (`enabled=false` just stops it from
    ever being selected as due; toggling back to `true` sets `next_run_at = now()` so it fires on the
    very next 5-minute tick rather than waiting out its original interval) and a delete button.
- **Cross-platform dedup — "also on {platform}" badge (2026-08-23, `possible_duplicate`)**: dubizzle
  and propertyfinder listings for the SAME physical unit have no shared external ID across the two
  sites, so a captured listing has no way to know it's a duplicate of one already seen on the other
  platform — every unit could be scored, wishlisted, and messaged as if it were two independent
  deals. `propertyListings.ts`'s `listPropertyListingsWithHistory` (already the single query behind
  `/results`, same place `previous_price`/`price_dropped` are computed) gained a THIRD correlated
  subquery, `possible_duplicate`: for each listing, look for a candidate on the OTHER platform with
  the same purpose (buy vs rent never cross-matches) + same community (case-insensitive exact — the
  strongest signal available) + same bedroom count (both sides must have a known value — an
  unknown-bedroom listing never participates) + same bathroom count IF both sides have one recorded
  (skipped, not required, when either is missing) + price within 8% (or AED 5,000, whichever is
  larger) + area within 6% IF both sides have an area recorded. This is a HEURISTIC, not a certain
  match — the UI badge says "possible" everywhere, never asserts identity. Runs live on every read
  (not precomputed/stored) so it can never go stale as new jobs capture new data on the other
  platform.
  - **Frontend**: a small warning-colored "also on {platform}" badge next to the existing verified/
    review/off-plan/price-drop badges on each row (`ResultRow` in `property-crawl.tsx`), linking
    straight to the matched listing on the other site; hover shows the matched title/price so the
    match is inspectable, not a black box.
  - **Live-verified end-to-end**: inserted two real rows into `property_listings` (one on an
    existing dubizzle job, one on an existing propertyfinder job, both for "liwan") with matching
    community/bedrooms/bathrooms and price/area inside tolerance — confirmed the match resolves in
    BOTH directions (each row correctly points back at the other) via `GET .../results`, then
    confirmed against a real 129-listing job (JVC, no propertyfinder counterpart job existed for
    that area in this DB) that zero false positives were flagged. Test rows removed after
    verification — this was DB state, not app logic, so no migration/rollback needed.
- **Distress-score accuracy + confidence + rental yield + "Rented for" column (2026-08-23)**: a
  direct ask ("is there an existing Python API for this kind of scoring with a confidence score")
  was investigated and answered honestly in `analysis.py`'s own docstring — no, multi-parameter
  real-estate deal scoring with a genuine confidence figure isn't something scikit-learn/
  statsmodels/etc. gives you off the shelf; that needs LABELED ground truth ("this listing really
  was underpriced by X%") this pipeline has no source for. What's buildable and genuinely improves
  accuracy without one:
  - **New `yield` component** (default weight 0.20, `analysis.py`) — rental yield
    (average_rent/price) PERCENTILE RANK among whichever listings in the batch have both fields.
    average_rent only exists post-detail-scrape (top-N only), so it can't influence which listings
    get detail-scraped in the first place — `pipeline.py` now runs `compute_distress_scores` a
    SECOND time, on the WHOLE batch, right after Stage D completes, so the final displayed score/
    ranking rewards real yield for the listings it was actually measured on. Rebalanced
    DEFAULT_WEIGHTS to make room: value 0.50→0.40, freshness/verified each 0.15→0.10, keywords
    unchanged at 0.20, yield 0.20 new (sums to 1.00). `_percentile_rank_component` is now shared
    machinery between `value` (cheaper/sqft wins) and `yield` (higher yield wins) so the two can't
    silently drift apart in behavior.
  - **New `compute_distress_confidence`** (sibling pure function, same file) — a genuine 0-100
    figure: how much of `distress_score`'s weight came from REAL data for this listing vs. a
    neutral 0.5 fallback (missing price/area, no average_rent, unknown days-on-market), weighted by
    the SAME per-component weights so a missing HIGH-weight field drags confidence down more than a
    missing low-weight one. This is a data-completeness measure, not a statistical prediction
    interval — there's no model to have one, and the docstring says so rather than overclaiming.
    Stored alongside distress_score (new `distress_confidence REAL` column, migration
    `1786100000000`) at every scoring pass.
  - **"Rented for" column** (the second half of the same ask) — `average_rent` moved from an inline
    text fragment under the Listing cell to its own dedicated, SORTABLE table column (and a Compare-
    modal row), matching the existing Price/Area/AED-sqft/Listed column treatment. Score cell gained
    a `(NN% conf.)` label + hover tooltip explaining what confidence means, so a low-confidence high
    score isn't silently presented as equally certain as a high-confidence one.
  - **Live-verified end-to-end against the real running stack**: restarted the live property host
    runner process (killed only its own 2 PIDs by exact CommandLine match, never a blanket
    `taskkill /IM python.exe`) to pick up the code, ran a real small dubizzle job (6 listings,
    top-2 detail scrape) through the actual site, and confirmed via both direct DB query and the
    real `/results` API response: `distress_confidence` populated (90 for the 2 detail-scraped
    listings with real average_rent, 70 for the 2 that never got a detail visit — correctly
    reflecting the missing yield/freshness signal), `average_rent` correctly NULL for non-detail-
    scraped rows. Test job deleted after verification.
  - Tests: 28→38 cases in `tests/test_property_analysis.py` (every pre-existing test that isolates
    a single component now explicitly zeroes the new `yield` weight, or the DEFAULT_WEIGHTS merge
    would silently pollute its exact-value assertions — plus new yield-component and confidence
    tests). Full property suite: 117 passing, zero regressions.
- **"Refresh Search" — re-run a job's own criteria as a new job (2026-08-24)**: distinct from the
  existing per-row `RefreshListingButton` (re-checks ONE already-captured listing's live price) —
  this is a whole-JOB action, shown on the focused job's header whenever it isn't actively running
  (`!ACTIVE.has(focus.status)`). `handleRefreshSearch(job)` clones the focused job's own criteria
  (platform/location/bedrooms/bathrooms/propertyType/purpose/propertyStatus/maxPages/maxListings/
  detailScrapeTopN/whatsappMessageTemplate/scoreWeights) into an ordinary `createPropertyJob` call
  and switches focus to the new job. **No new backend endpoint needed**: the EXISTING cross-job
  price-drop matching (`propertyListings.ts`'s `listPropertyListingsWithHistory`, matched on
  `listing_url` — the site's own stable identity, across ANY earlier job regardless of search) was
  already comparing a newly-captured listing's price against whatever the same real ad last showed
  — so "compare old vs new results and highlight price changes" falls out of that pre-existing
  mechanism for free; this button just saves re-typing the whole search form for a daily re-check
  of the same area (exactly the "fetching the same area listing on daily basis" use case rule 55's
  original price-drop feature was built for).
- **Light/dark theme toggle (2026-08-24)**: the app was dark-only (a "deep space navy" palette
  hardcoded straight into `:root`, with `.dark` present but only ever redundantly re-declaring
  `--background`/`--foreground` to the SAME values — no real light mode ever existed).
  - `styles.css` rewritten: `:root` now holds a REAL light palette (same cyan-primary/navy-neutral
    brand hue family as before, just re-lit for a white surface — new oklch values, not reused
    dark ones), `.dark` holds the exact original dark values moved wholesale (zero visual change
    for anyone who stays dark, which is still the default). Leaflet's dark-tile-inversion trick
    (`.leaflet-tile { filter: invert(1)... }`) is now scoped `.dark .leaflet-tile` — it only makes
    sense against the dark theme's navy background; light mode shows the map's real tile colors.
    The attribution/zoom-control chrome colors now reference the theme tokens directly instead of
    duplicating literal oklch values, so they adapt automatically.
  - `hooks/useTheme.ts` — `useSyncExternalStore` over the `<html>` element's own `.dark` class
    (the single source of truth on the DOM side, not a duplicated React state that could drift),
    persisted to `localStorage["theme"]`. No Context provider — the only two consumers
    (`ThemeToggle`, `__root.tsx`'s `<Toaster theme=...>`) sit at unrelated tree positions and a
    provider would be overkill for one string value.
  - `components/theme-toggle.tsx` — a Sun/Moon icon button, mounted once in `AppShell`'s header
    (shared across every route) so the toggle is available everywhere with one addition.
  - **Flash-of-wrong-theme prevention**: this is a TanStack Start SSR app, so the server always
    renders `<html class="dark">` (the default) — a returning user who chose "light" would
    otherwise see a flash of dark before React hydrates and corrects it. Fixed with a blocking
    inline `<script>` in `__root.tsx`'s `<head>` (before `<HeadContent/>`), which runs synchronously
    before paint and applies the persisted class immediately; `suppressHydrationWarning` on `<html>`
    stops React from fighting that pre-hydration DOM mutation when it later reconciles.
  - **Live-verified against the real running stack** (Docker Desktop had entered its
    "manually paused" resource-saver state mid-session — recovered via `docker desktop restart`,
    a safe non-destructive recovery, then `docker compose up -d` brought postgres/backend/frontend
    back with volumes untouched; both host-runner processes reconnected on their own within
    seconds): confirmed via `curl` against the real container that the served HTML contains
    `<html lang="en" class="dark">` + the theme-init script, and that the compiled CSS bundle
    contains a real `.dark{...}` block and the re-scoped `leaflet-tile` selector. An actual
    click-through of the toggle (and of Refresh Search creating a real job) was NOT performed — no
    browser tool was available in this pass — flagged honestly as a verification gap rather than
    silently claimed complete; the underlying `createPropertyJob` call Refresh Search reuses has
    already been live-verified multiple times elsewhere in this same session (Launch, Save as
    recurring), so its correctness is high-confidence even without a fresh click-through.
- **Global search by tower/building name (2026-08-24)**: search across EVERY captured listing —
  not scoped to one job — matched against title/community/location_text (a tower name usually
  shows up in one of those, e.g. "Sports View Residence, International City Phase 2 (Warsan 4),
  Dubai" as either the title or, for some listings, only `location_text` while the title itself is
  a generic ad blurb). Distinct from the existing per-job free-text filter (client-side, scoped to
  whichever job is currently open) — this is a NEW backend endpoint since it queries across jobs.
  - **Backend**: `GET /property-crawl/search?q=&limit=` (`searchPropertyListingsQuerySchema`, q
    min 2 chars, limit 1-100 default 50) → `searchPropertyListingsGlobally()`
    (`propertyListings.ts`). Refactored the three enrichment subqueries (previous_price/
    latest_refresh/possible_duplicate) that `listPropertyListingsWithHistory` already had into a
    shared `HISTORY_ENRICHMENT_SQL` string fragment + a shared `toListingWithHistory()` mapper —
    both the per-job view and this new global-search view interpolate the SAME fragment, so a
    listing's price-drop/duplicate signal can never read differently depending on which endpoint
    happened to fetch it. The new query additionally selects `cur_job.platform`/`cur_job.location`
    (a `PropertySearchResult` extends `PropertyListingWithHistory` with these two fields) since
    results span multiple jobs — every other view can infer platform/location from "whichever job
    is currently open," this one can't.
  - **Frontend**: a "Global Search" toolbar button (next to Wishlist/Scheduled Searches) opens a
    self-contained `GlobalSearchModal` — own query input + debounce, not synced with any toolbar
    state, matching this file's existing self-contained-panel convention (WishlistPanel/
    CompareModal). Results render as full detail cards (`GlobalSearchResultCard`) rather than
    compact table rows — photo, title+link, platform/verified/off-plan/price-drop/possible-
    duplicate badges, which job/search it was captured under + how long ago, price (+ strikethrough
    prior price on a drop), AED/sqft, area, beds/baths, rented-for, listed-days-ago, score+
    confidence, community, distress keywords, description, agent/WhatsApp, and a wishlist star —
    "all the details" the per-job results table shows, just card-shaped instead of row-shaped since
    a modal list reads better vertically.
  - **Live-verified against real captured data**: searched "Sports View Residence" via the real
    API — correctly matched listings whose TITLE contains it AND a separate listing whose title is
    unrelated but whose `location_text` contains it (proving the OR-across-3-fields matching works,
    not just a title-only search); confirmed `limit` truncates correctly (50 default → 3 when
    requested); confirmed a 1-character query cleanly 400s (below the 2-char floor) and an
    unauthenticated request 401s. Verified the built frontend bundle contains "Global Search"/
    "Tower or building name"/"Captured under" (the modal's own strings) — an actual browser click-
    through wasn't performed (no browser tool available this pass), flagged as a real gap.
- **Global Search unusable while typing during an active job (2026-08-24 fix)**: reported as
  "not able to type in Global Search while results are capturing." Root cause: `PropertyCrawl`
  re-renders every 2s while any job is active (`usePropertyJobs`/`usePropertyJob`'s own
  `refetchInterval`), and `GlobalSearchModal` was mounted with an inline
  `onClose={() => setGlobalSearchOpen(false)}` — a BRAND NEW function reference on every one of
  those re-renders. Fixed by wrapping `GlobalSearchModal` in `React.memo` and passing a
  `useCallback([])`-stabilized `closeGlobalSearch` instead — with both pieces in place, React
  bails out of `GlobalSearchModal`'s subtree entirely on a poll-triggered re-render (referentially
  equal props), so the modal's `<input>` is never touched by background polling regardless of how
  active the job is, guaranteeing typing responsiveness. **Either change alone is insufficient**:
  `memo()` without a stable callback still re-renders on every poll (the callback prop "changed");
  a stable callback without `memo()` still re-renders because a plain function component has no
  memoization by default. `WishlistPanel`/`SchedulesPanel` weren't given the same treatment — they
  don't hold a text input that needs sustained per-keystroke responsiveness the way Global Search
  does, so the same class of fix wasn't yet needed there.
- **"Pages to scrape" default raised 3 → 20 (2026-08-24)**: both the frontend form's initial
  `useState(20)` and the backend's `createPropertyJobSchema` Zod default (`maxPages` — matters for
  any direct API caller that omits the field) — kept the two in sync rather than fixing only the
  UI. Verified live: a job created via a direct API call with `maxPages` omitted now gets
  `max_pages: 20`. The field's own 1–20 range cap was already 20, so this makes the default equal
  the ceiling rather than raising the ceiling itself.
- **CRITICAL — propertyfinder starved indefinitely by a busy dubizzle queue (2026-08-24 fix,
  `run_property_host.py`)**: reported live as "property finder is not working at all" — a real
  job sat QUEUED for 50+ minutes with zero activity. Root-caused via the runner's own log: it
  never mentioned "propertyfinder" ONCE in that whole window, while dubizzle jobs processed one
  after another back-to-back the entire time. The bug was in the 2026-08-23 "run platforms
  concurrently" design (see rule above it): each `_run()` watch-cycle called
  `asyncio.gather(*(_drain_platform_jobs(platform) for platform in [...]))`, and each
  `_drain_platform_jobs` call was "claim+run everything queued for this platform RIGHT NOW, then
  return." `asyncio.gather` doesn't return until EVERY one of its coroutines returns — so as long
  as dubizzle kept finding more work (new jobs kept arriving faster than it could drain them),
  its own drain-loop never returned, `gather()` never resolved, and the outer watch loop never got
  to call `_run()` again — meaning propertyfinder's drain-loop, which had already checked ONCE at
  the very start (found nothing queued at that exact instant, returned immediately), was never
  RE-CREATED to notice the propertyfinder jobs queued moments later. The two platforms WERE running
  concurrently within a single cycle — the bug was that a busy platform could prevent the NEXT
  cycle (and thus a fresh check of every platform, including an idle one) from ever starting.
  - **Fix**: replaced the "re-created every outer cycle" design with genuinely PERSISTENT,
    independent loops — `_drain_platform_forever(platform)`, one per platform, started ONCE and
    running for the life of the process (immediately re-checks its own queue after finishing a
    job, or sleeps `poll_seconds` if empty) — plus a separate `_housekeeping_forever` loop
    (heartbeat + refresh-draining, also persistent). All started together via one `asyncio.gather`
    that itself never returns (every child loop is `while True`), so there's no outer cycle left
    to get stuck waiting on a busy platform in the first place.
  - **Orphan recovery moved to a true one-time call** (`recover_orphaned_property_jobs()` — marks
    EVERY row currently `capturing`/`parsing`/`detail`/`scoring` as failed, unconditionally) —
    this MUST run exactly once, before any persistent loop starts claiming, never on a repeating
    interval; the old design got this right only because `_run()` itself was re-invoked fresh
    each cycle. `_housekeeping_forever` deliberately does NOT call it — calling it on a repeating
    interval would kill every legitimately-still-running job within one poll tick, a much worse
    bug than the one being fixed.
  - The one-shot `PROPERTY_HOST_WATCH` unset path (`_run()`/`_drain_platform_jobs`, "drain what's
    queued right now, then exit" — used for a single CI-style invocation) is UNCHANGED — the
    starvation bug only applies to the long-running watch loop, since it needs new work to keep
    arriving faster than a platform drains to manifest at all.
  - **Live-verified against the real running host runner**: confirmed via the DB that 3 real
    propertyfinder jobs had been queued 09:08–09:50 with zero progress, and via the runner's raw
    log that it never mentioned propertyfinder once since its last start. Restarted the runner
    with the fix (killed only its own 2 PIDs by exact CommandLine match, never a blanket kill —
    same discipline as every other restart this session); confirmed the one-time orphan-recovery
    fired exactly once (`{"count": 1, "event": "recovered orphaned property jobs"}`) and,
    critically, that propertyfinder was claimed within SECONDS of restart — concurrently with an
    already-running dubizzle job — and was genuinely capturing real listings
    ("The Diamond, Dubai Sports City, Dubai"), not just marked as claimed.
- **Sort-before-scraping — the SOURCE SITE's own sort order, both platforms (2026-08-24)**: a
  direct ask — "sort by cost/rating/review/other available parameter BEFORE scraping" — was
  investigated honestly: "rating"/"review" don't exist as a concept on either dubizzle or
  propertyfinder (no listing has one), so those weren't fabricated. What both sites genuinely
  support server-side: **newest** and **price (low↔high)** — confirmed empirically, not guessed,
  via real screenshots of each site's own sort UI clicked through live on the operator's real
  Chrome:
  - **dubizzle**: a "Sort: Popular" button opens a dropdown (Popular/Verified/Newest to Oldest/
    Oldest to Newest/Price Highest to Lowest/Price Lowest to Highest) — clicking each and reading
    the resulting URL confirmed `sorting=date_desc|date_asc|price_desc|price_asc` (Popular = no
    param at all; "Verified" turned out to be the pre-existing "Show Verified First" toggle, not a
    real sort mode — clicking it left the URL unchanged).
  - **propertyfinder**: an icon-only button (no text/aria-label — found only by screenshot, between
    "Filters" and the bell icon) opens a "Sort by" panel (Featured/Newest/Price low/Price high/
    Beds least/Beds most) — confirmed `ob=mr|nd|pa|pd` (+`ba`/`bd` for beds, not surfaced since
    dubizzle has no equivalent bedroom sort and this feature only exposes dimensions BOTH platforms
    share, so a choice behaves consistently across a platform switch).
  - **Shared `PropertySortOrder`** (`"default"|"newest"|"price_low_high"|"price_high_low"`) — new
    `models.py`/`db.ts`/`types/api.ts` type, new `sort_order` column on both `property_jobs` AND
    `property_job_schedules` (migration `1786200000000` — a saved recurring search remembers its
    sort choice too, fired into every job it creates same as every other criteria field).
    `SearchFilters` (worker) gained a `sort` field; each adapter's own `_SORT_PARAM` dict maps it
    to that platform's real query param, with the confirmation method documented inline as a
    comment (never re-derive/guess these if the site's UI ever changes — re-screenshot it).
  - **Frontend**: a "Sort by" `<Select>` in the launch form (next to Status), threaded through
    Launch/Save-as-recurring/Refresh-Search identically to every other criteria field; the recent-
    jobs list and Scheduled-Searches panel both show the chosen sort in their filter-summary line
    (omitted when "default", to avoid cluttering the common case).
  - **Live-verified end-to-end against the real running sites** (not just the URL — the actual
    resulting DATA): launched a real dubizzle job with `price_low_high` and confirmed the 5 real
    captured listings' prices were genuinely ascending (262,943 → 419,999 → 420,000 → 440,000 →
    445,000); launched a real propertyfinder job with `price_high_low` and confirmed the 8 real
    captured listings' prices were genuinely descending (2,244,000 → … → 875,000). Both jobs and
    their captured data deleted after verification. Restarted the live property host runner to
    pick up the code (killed only its own 2 PIDs by exact match, never a blanket kill — same
    discipline as every other restart this session).
  - Tests: 8 new cases in `test_property_adapters.py` (default/newest/price-low/price-high × both
    adapters) — full adapter suite 42/42 passing, full property suite 117/117.
- **Region building-age reference table (2026-08-25, `db/migrations/1786300000000_property-building-ages.sql`)**:
  a real per-listing `age_years` only ever exists for a job's `detail_scrape_top_n` highest-scoring
  listings — most captured rows never get one. New `property_building_ages` table (case-insensitive
  unique on `(region, building_name)`, so re-pasting the same region's table upserts rather than
  duplicates) lets the operator paste a real building-name→completion-year reference table per region
  (starting with Dubai Sports City, 107 real buildings) once; every listing whose title/community/
  location_text contains a known building name then gets a **mapped** age even without its own detail
  scrape. `completion_year` is the stored fact — age is always derived at READ time
  (`current_year - completion_year`), never stored, so it can't go stale across calendar years.
  `is_estimated` (source row marked with `*` or a year range like "2015/16") surfaces as an
  approximate "~" age in the UI rather than an exact one; NULL `completion_year` (source's "N/V"
  rows) stays genuinely unknown, never guessed. A listing's own real `age_years` always wins — the
  mapped estimate (`mapped_age_years`/`mapped_age_is_estimated`/`mapped_building_name` on
  `PropertyListingWithHistory`) is only ever populated when the real field is null.
  - **Parsing** (`backend/api/src/services/buildingAgeTableParser.ts`): tab-separated or
    loosely space-aligned pasted text, one building per line; a bulk-import 400s with a specific
    message when zero recognizable rows are found rather than silently importing nothing.
  - **API**: `GET /property-crawl/building-ages/regions`, `GET /property-crawl/building-ages?region=`,
    `POST /property-crawl/building-ages/bulk-import` (operator+), `DELETE
    /property-crawl/building-ages/region/:region` (operator+), `DELETE
    /property-crawl/building-ages/:id` (operator+) — all in `routes/propertyCrawl.ts`, backed by
    `db/propertyBuildingAges.ts` (own in-process cache, invalidated on every import/delete).
  - **`capture.py` client-side bedroom exact-match filter**: confirmed live 2026-08-25 that
    propertyfinder can leak studio listings into a 2-bedroom search once "Price low to high" sort is
    selected, even with `bf=2&bt=2` set — re-enforced client-side the same defensive way as the
    existing bathroom floor (skips only when the card's own bedroom count is confidently known and
    doesn't match; a studio search is exempt since a studio card's own bedroom count is already that
    search's target).
  - **Global command search** (`src/components/global-command-search.tsx`): replaced the old static,
    non-functional search-box placeholder in `AppShell`'s header (`Search businesses, jobs, fields…`
    with a decorative ⌘K badge that did nothing) with a real `GlobalCommandSearch` modal +
    `GlobalSearchTrigger`, wired into `app-shell.tsx`.
  - **`scripts/restart-all.bat`/`scripts/stop-all.bat`**: one-click dev-environment scripts — restart
    ensures Docker Desktop is running, rebuilds backend+frontend images, applies pending migrations,
    recreates containers, then restarts both host-runner processes (matched by exact command line
    only, never a blanket kill of every `python.exe`/`chrome.exe` — see the earlier Chrome-taskkill
    mistake above) via the existing `start-property-host.bat`/`start-noon-host.bat` launchers; stop
    tears the same set down.
- **Host runners auto-start at Windows login (2026-09-12)**: the Property Research and noon/
  AliExpress host runners are architecturally host-only, not containerized — both
  dubizzle.com/propertyfinder.ae and noon.com block plain headless Chromium at the edge, so they
  only work through the operator's real, visible Chrome on the Windows host (see
  `start-property-host.bat`/`start-noon-host.bat`'s own comments) — this is a deliberate constraint,
  not something `docker compose`/the backend container can absorb. Previously nothing restarted them
  after a reboot/crash, so they could silently sit dead for days (surfaced only via the
  `RunnerStatusBanner`'s stale-heartbeat warning — see `chrome_health.py`'s
  `host_runner_status`/`ensure_chrome_running` above). New **`scripts/start-all-hosts.bat`**
  launches Property first, waits 10s for its Chrome debug port on 9222 to come up, then launches
  noon — **sequenced, not concurrent, on purpose**: both scripts point at the same
  `--remote-debugging-port=9222`/`--user-data-dir` (the shared-Chrome design noted above under
  "Product Research (ecom)"), so launching them at the exact same instant risks two Chrome
  processes racing to lock the same profile directory; starting one first and letting it open the
  debug port before the second attaches avoids that race. Once both are up, their runner loops are
  fully independent and DO run concurrently against the shared Chrome window, unaffected by the
  startup ordering. A Windows Startup-folder shortcut (`business-scout-hosts.lnk`, added via
  PowerShell `WScript.Shell`, points at this .bat) now runs it automatically on every login — not
  committed to the repo (it's a per-machine OS setting, not project source), so a fresh machine
  needs it recreated once.
- **OCR crawl performance pass + retry-refreshes-ready-jobs (2026-09-12, `md/OCR_CRAWL.md`)**:
  reported live — a real Haldwani "gym" OCR job sat stuck well below expected throughput. Analysis
  found `OCR_CONCURRENCY` (`settings.py`) defaulted to a flat `3` regardless of the container's real
  core count, under-using Stage B's already-existing concurrency machinery; changed the default to
  `min(8, cpu_count() - 1)` (override via `OCR_CONCURRENCY` unchanged). Also added `font`/`media`
  resource blocking on Stage A's detail page (`capture.py`, mirroring `enrich/tier2.py`'s pattern) —
  `image` deliberately stays unblocked since the segment screenshots ARE the OCR/audit-trail
  artifact, unlike Tier-2's plain-HTML-only use case. **Investigated and deliberately rejected**:
  skipping the Tesseract call entirely whenever DOM already has phone+website — `opening_hours` and
  `email` have no DOM equivalent at all, so that would have silently dropped those two fields for
  most businesses, not just saved time.
  - **Retry now works on `ready` jobs too, and overwrites rather than resumes** — previously Retry
    only appeared on `failed`/`blocked` jobs (a resumable retry, unchanged: picks up from the
    on-disk `manifest.json`, skips already-captured businesses). A `ready` job's Retry (labeled
    "Refresh" in the UI) now deletes that job's `manifest.json` + every existing `ocr_businesses`
    row FIRST (`routes/ocrCrawl.ts`), then requeues — the worker walks the search completely fresh
    and the new rows land at the same `(job_id, idx)` via `insert_ocr_business`'s existing
    `ON CONFLICT DO UPDATE`, so the results are genuinely replaced with current data rather than
    duplicated or silently stale. `retryOcrJob`'s SQL `WHERE` widened to
    `status IN ('failed','blocked','ready')`; still blocked while a job is actively
    queued/capturing/ocr/parsing.
  - Verified: full backend test suite (117/117) and the OCR/settings-scoped Python suite (45/45)
    green after the change; `tsc --noEmit`/eslint clean on both frontend and backend. **Not yet
    live-verified against a real running job** — no live browser/container click-through was done
    in this pass, flagged as a real gap rather than claimed complete; the underlying
    `ON CONFLICT DO UPDATE` and manifest-resume mechanics were already relied on and tested by the
    pre-existing resumable-retry feature this builds on.
- **Known follow-up, not yet done**: `supabase/` (CLI config + old Lovable-era migrations) is dead
  weight left over from the original scaffold — the real schema is `db/migrations/*.sql` via
  node-pg-migrate. Safe to delete, just hasn't been done. Prod deployment target (which host, TLS
  termination) was never specified — `docker-compose.yml` is the only "prod" config that exists,
  single-box, plain HTTP. **Property Research**: propertyfinder's phone-reveal button selector on
  the detail page was never independently live-verified (best-effort guess mirroring dubizzle's
  confirmed pattern); `community` comes back `null` for most listings on both platforms (the UI
  falls back to `location_text`, which is populated) — a pre-existing gap, not touched this pass.

## Skills

Canonical conventions live in `.claude/skills/`, indexed at [.claude/skills/README.md](.claude/skills/README.md)
— **start there**, it maps task → skill. Read the relevant skill file before touching that layer's code:

- Frontend: `.claude/skills/skills_frontend.md`
- Backend (Node API): `.claude/skills/skills_backend_node.md`
- Backend (Python worker): `.claude/skills/skills_backend_python.md`
- Database: `.claude/skills/skills_db.md`
- DevOps: `.claude/skills/skills_devops.md`
- Security: `.claude/skills/skills_security.md`
- Efficiency (token/action discipline — read once, apply always): `.claude/skills/skills_efficiency.md`

## API reference (backend/api — all routes, as actually registered)

Every list/single-resource endpoint wraps its payload in a named envelope (`{jobs:[...]}`,
`{job:{...}}`, etc.) — see `skills_frontend.md` for the full convention and the one exception
(`/stats/overview`, which returns its shape bare). `requireAuth` is applied **per-route**, never via
`router.use()` (a verified real bug — see `skills_backend_node.md`).

| Group | Routes |
|---|---|
| `/auth` | `POST /login` (rate-limited, 10/15min), `POST /logout`, `GET /me`, `POST /refresh` |
| `/jobs` | `POST /` (create), `GET /` (list), `GET /:id`, `POST /:id/{pause,resume,retry,cancel}`, `DELETE /:id`, `GET /:id/stream` (SSE), `GET /logs/stream` (SSE, global) |
| `/businesses` | `GET /` (filter/paginate), `GET /google-enrichment-status`, `GET /:id`, `POST /:id/enrich-google` (operator+), `DELETE /:id` |
| `/dynamic-fields` | `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` |
| `/settings` | `GET /` (any role), `PATCH /` (admin only) |
| `/stats` | `GET /overview` (30s cache), `GET /system` (job success rate, failure alarm, tier-hit ratio, LLM/Google call counts) |
| `/geocode` | `GET /?q=` (Nominatim proxy) |
| `/exports` | `GET /` (history), `POST /` (generate xlsx/csv/json, operator+), `GET /:id/download` |
| `/api/v1` | `GET /businesses` (api-key auth, rate-limited 120/min/key), `GET /openapi.json` (unauthenticated) |
| `/ocr-crawl` | `POST /jobs` (operator+, 409 single-flight), `GET /jobs`, `GET /jobs/:id` (+progress), `GET /jobs/:id/results`, `GET /jobs/:id/export?format=csv\|xlsx`, `GET /jobs/:id/images/*splat` (screenshot), `DELETE /jobs/:id` (operator+) |
| `/property-crawl` | `POST /jobs` (operator+, queues — never rejects), `POST /jobs/:id/retry` (operator+, resumable, capped at 3), `GET /jobs`, `GET /jobs/:id` (+progress), `GET /jobs/:id/results` (price-drop-enriched), `GET /jobs/:id/analysis`, `GET /jobs/:id/export?format=csv\|xlsx\|json`, `GET /jobs/:id/images/*splat` (screenshot), `DELETE /jobs/:id` (operator+), `GET /wishlist`, `POST /wishlist` (operator+), `DELETE /wishlist/:id` (operator+), `POST /listings/:id/refresh` (operator+), `GET /listings/:id/refresh/:refreshId`, `GET /building-ages/regions`, `GET /building-ages?region=`, `POST /building-ages/bulk-import` (operator+), `DELETE /building-ages/region/:region` (operator+), `DELETE /building-ages/:id` (operator+) |
| `/health` | `GET /` (checks DB) |

## Project convention — approved-plan archival (REQUIREMENT)

Final, **approved** plans are durable project history so every later plan builds on the last:

- Location: `md/plans/`, named `NNNN-<slug>.md` (zero-padded sequence), indexed in `md/plans/README.md`
  (number · title · date · status, newest-first).
- **Only approved/final plans are committed here — never intermediate/working drafts.**
- Every new plan references relevant prior plans by number ("Builds on / supersedes NNNN") at its top.
- Superseded plans are kept (marked `Superseded by NNNN` in the index), never deleted.
- **Before planning new work, read the latest entry in `md/plans/`.**

## Project convention — file authorship (REQUIREMENT)

Every source file authored in this project carries a header attributing **Mohit Singh**:
- TS/JS: `/** Authored by: Mohit Singh */`
- Python: `"""Authored by: Mohit Singh"""` (module docstring) or `# Authored by: Mohit Singh`
- SQL/YAML/Dockerfiles: `-- Authored by: Mohit Singh` / `# Authored by: Mohit Singh` as the first line

Applies to files we write (backend, frontend routes/components, migrations, infra, skills, docs). Exempt:
third-party/vendor/generated files (`routeTree.gen.ts`, `node_modules`, lockfiles, shadcn `components/ui/*`
primitives kept as-is) — attribution goes on code we author, not on generated or vendored code. No mention of
Lovable (or any other scaffold-generation tool) as author-of-record belongs anywhere in this project's docs.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 19 + TanStack Start + Vite + Tailwind + shadcn-ui + Leaflet + recharts |
| Backend API | Node.js + Express + TypeScript (strict) |
| Backend worker | Python (`mypy --strict`) + psycopg + httpx + selectolax + Playwright (Tier-2 fallback) + phonenumbers + rapidfuzz |
| Database | PostgreSQL (dedicated instance) |
| Discovery | OpenStreetMap / Overpass API (free) |
| AI extraction | Optional, provider-agnostic (Ollama default/free, or any OpenAI-compatible key) |

## Engineering standards (non-negotiable, every phase)

Strict typing both runtimes · one quality-gate command per runtime wired into CI + pre-commit (lint/format/
typecheck/test) · tests written with the feature, not after · config validated at boot, fail-fast · structured
logging with correlation IDs · consistent typed error handling · migrations are the only schema authority ·
idempotent/atomic job handling · containerized from day 1 · CI green from commit #1 · Node↔Python share only
the DB, never HTTP · security baseline (bcrypt, JWT, deny-by-default authz, parameterized SQL, env-only secrets).

## Testing policy — no browser automation against our own app

Verification uses Vitest/RTL/supertest/pytest — never Chrome/Playwright-as-test-runner/computer-use to drive our
own frontend or API. **This does not restrict Playwright as a product dependency**: the worker's Tier-2
enrichment legitimately uses headless Chromium to render *other businesses'* websites — that's core product
functionality, unrelated to how we test our own code. See `.claude/skills/skills_devops.md`.

## Compliance (Phase 8)

- **robots.txt**: honored by default on every Tier-1/Tier-2 fetch (`crawl_settings.respect_robots_txt`,
  fail-open only when robots.txt itself is missing/unreachable — see `enrich/policy.py`).
- **ODbL attribution**: discovered data originates from OpenStreetMap (ODbL-licensed) — any public-
  facing use of the exported/API data must carry an "© OpenStreetMap contributors" attribution.
  **Not yet surfaced in the UI/exports** — a real gap, not done.
- **PII / outreach**: scraped emails/phones are business-listed contact info, not personal data collected
  from individuals directly — still, bulk emailing/calling scraped contacts may be subject to
  CAN-SPAM/GDPR/DPDP/PECR depending on jurisdiction and use. This tool extracts and stores; it does
  not send outreach itself. Anyone building outreach on top of the export/API is responsible for
  their own compliance — not enforced or advised on further here.

## Backup & restore (single-box Postgres — `business-scout-postgres`)

No automated backup job exists yet (real gap — Phase 8 flagged this, not built). Manual runbook:

```bash
# Backup (from the host, container name per docker-compose.yml)
docker exec business-scout-postgres pg_dump -U postgres -Fc master_db_crawler > backup.dump

# Restore into a fresh/empty database
docker exec -i business-scout-postgres pg_restore -U postgres -d master_db_crawler --clean --if-exists < backup.dump
```

`-Fc` (custom format) is required for `--clean --if-exists` to work; a plain-SQL dump (`-Fp`) would need
`psql < backup.sql` instead. Never restore over a database with newer data than the backup without
confirming with whoever owns that data first — this is a destructive operation for any 100%-post-backup
writes.

## Pre-commit rule

Before every `git commit`, if the changed area touched a durable convention/pattern/pitfall, update the matching
skill file + this `CLAUDE.md` + `AGENTS.md` (mirrored) in the same change set. Stale docs are a bug.
