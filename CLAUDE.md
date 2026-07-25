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
  Needs `tesseract-ocr` (apt in Dockerfile) + pytesseract/Pillow/opencv-headless. Single-flight
  (DB partial-unique index), retention purge of `raw/` PNGs, CAPTCHA→`blocked` stop.
  **⚠️ ToS: automating Maps violates it — low-volume/internal only; Places API is the compliant
  path for the same fields.**
- **Known follow-up, not yet done**: `supabase/` (CLI config + old Lovable-era migrations) is dead
  weight left over from the original scaffold — the real schema is `db/migrations/*.sql` via
  node-pg-migrate. Safe to delete, just hasn't been done. Prod deployment target (which host, TLS
  termination) was never specified — `docker-compose.yml` is the only "prod" config that exists,
  single-box, plain HTTP.

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
