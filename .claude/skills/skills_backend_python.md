<!-- Authored by: Mohit Singh -->

# Backend Skills — Python Worker (`backend/worker/`)

> Read before touching `backend/worker/business_scout_worker/`.

## Role

The other half of the `backend` image, run as a sibling process to the Node API under `supervisord`. A
long-running **daemon** — no HTTP server, no HTTP client calls to the Node API. It only talks to Postgres and to
external services (Overpass, target business websites, optionally an LLM). Control flows into it entirely
through DB columns (`cancel_requested`, `pause_requested`, job `status`).

**Python version**: `pyproject.toml` floors at `>=3.11`; CI and the Docker image (via
`mcr.microsoft.com/playwright/python:v1.49.0-noble`) target **3.12**. Local dev may use whatever interpreter is
on the host (this project has run cleanly against 3.14) — the floor/CI/Docker versions are what matters for
reproducibility, not the local host's exact version.

### ⚠️ Windows local dev — psycopg3 async needs SelectorEventLoop, not the default ProactorEventLoop
**Verified, not hypothetical**: the first Phase 1 integration-test run hung for 152 seconds and failed all 5
tests with `psycopg_pool.PoolTimeout` — the real error (`error connecting in 'pool-1': Psycopg cannot use the
'ProactorEventLoop' to run in async mode`) only shows in psycopg's own log output, not the pytest traceback,
which just shows a generic pool-timeout. Root cause: Windows' default asyncio event loop
(`ProactorEventLoop`) is incompatible with psycopg3's async connections. **Irrelevant inside the Linux Docker
container** (the only place this daemon actually deploys — Linux's default loop works fine), but required for
local Windows dev and for pytest runs on a Windows host. Fix (already applied in both `main.py` and
`tests/conftest.py`, at the top before any event loop is created):
```python
import asyncio, sys
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
```
`WindowsSelectorEventLoopPolicy` carries a deprecation warning (slated for removal in a future Python) with no
replacement API documented yet as of this writing — harmless noise for now; revisit if/when psycopg or asyncio
ships a supported alternative. If you ever see a mysterious multi-minute hang + pool-timeout on async DB code
on Windows, check for this exact symptom before assuming it's a real connectivity problem.

### ⚠️ Windows local dev — this SelectorEventLoop fix directly conflicts with Playwright (Phase 4)
**Verified, not hypothetical**: `test_tier2.py`'s real-Chromium-launch test failed with
`NotImplementedError` at `asyncio.create_subprocess_exec` — Playwright launches Chromium as a subprocess, and
Windows' `SelectorEventLoop` (the one psycopg3 needs, set process-wide above) **does not support subprocess
management at all**; only `ProactorEventLoop` does. There is no event loop policy that satisfies both psycopg3
and Playwright simultaneously in the same Windows process. Since `conftest.py` sets `SelectorEventLoop`
globally for the whole test session (required by every DB-touching test), the one test that needs a real
browser launch (`test_render_html_real_browser_launches_and_renders`) is `@pytest.mark.skipif(sys.platform ==
"win32", ...)` — it still runs in CI (Linux, no conflict) and in the actual Docker deployment. Every other
Tier-2 test (`looks_js_shelled`, the escalation wiring in `enrich_website`) mocks `tier2.render_html` and needs
neither event loop policy, so it runs everywhere. If you ever add another test that needs a *real* browser
launch, it needs the same skip — don't try to "fix" this by changing the global event loop policy, it can't be
fixed that way on Windows.

## Structure (Phase 3 — current)

```
backend/worker/business_scout_worker/
├─ main.py                # daemon entrypoint: _listen_loop (dedicated LISTEN connection) +
│                          #   startup/periodic claim_pending_job sweep + calls pipeline.run_job
├─ pipeline.py             # run_job() — the per-job orchestration: discover -> batch loop
│                          #   (concurrency-sized) -> upsert -> conditional Tier-1 -> counters/logs
├─ jobs.py                 # job-lifecycle queries: claim_pending_job/claim_job_by_id, refresh_job,
│                          #   set_job_status, increment_counters, write_log, finish_job, release_job
├─ dedupe.py               # exact upsert (osm_type,osm_id) + email secondary-override tolerance
│                          #   (fuzzy rapidfuzz pass is Phase 4, not here)
├─ settings.py             # pydantic-settings — env validated once at startup, fail fast
├─ db.py                   # psycopg pool, typed row models (pydantic) mirroring the schema
├─ discovery/
│  ├─ models.py            # DiscoveredBusiness — the pre-persistence normalized shape
│  └─ overpass.py          # tag map + QL builder + tiling + httpx client + element parsing
├─ enrich/
│  ├─ models.py            # Tier1Result
│  └─ tier1.py             # httpx+selectolax fetch/parse (tier2.py/playwright is Phase 4)
└─ (Phase 4+, not yet built): parse/ (phonenumbers, pypostal), llm.py, google.py
```

## The job loop (the core discipline — as actually implemented)

1. `main.py`'s `_listen_loop` holds a **dedicated, non-pooled, autocommit** connection for
   `LISTEN crawl_jobs` (a pooled connection could be handed back and reused for an unrelated query,
   silently dropping the LISTEN) and reconnects on drop. The main loop **also** calls
   `claim_pending_job` on startup and on every `poll_interval_seconds` tick — `NOTIFY` is not
   persisted, so a notification sent while the worker was down is lost; the daemon must never rely
   on `LISTEN` alone.
2. Claim atomically (`jobs.claim_pending_job`): `UPDATE crawl_jobs SET status='discovering' ...
   WHERE id = (SELECT id FROM crawl_jobs WHERE status='pending' ... FOR UPDATE SKIP LOCKED LIMIT 1)
   RETURNING *`. Never claim with a plain `SELECT` then `UPDATE` — that's a race under multiple
   workers (not exercised today — one daemon process — but free correctness).
3. **One job runs at a time** per daemon process (`main.py`'s loop `await`s `pipeline.run_job`
   before claiming the next) — a deliberate Phase 3 simplification, not a hard requirement; revisit
   only if throughput ever demands concurrent jobs.
4. Businesses within a job are processed in **batches of `crawl_settings.concurrency`**
   (`asyncio.gather` per batch) — `cancel_requested`/`pause_requested`/daemon-shutdown are checked
   **between batches**, not between every single business (a documented Phase 3 simplification: it
   still satisfies "checked between businesses" at batch granularity while making the Concurrency
   setting do something real). `pause_requested` → status `paused`, idle-poll every
   `pipeline.PAUSE_POLL_SECONDS` until cleared or cancelled.
5. Every business writes to `crawl_logs` and updates the job's counters (`found_count`,
   `crawled_count`, `website_crawled_count`, `failed_count`, `current_business`) — the Node API's
   SSE stream is only as good as these writes being frequent and accurate.
6. **Graceful shutdown is a third terminal path, distinct from cancel/complete**: `main.py` sets a
   `stop_event` on SIGTERM/SIGINT and passes it into `pipeline.run_job(..., shutdown_event=...)`.
   Between batches, if the event is set, the job is released via `jobs.release_job` (status back to
   `'pending'`, **not** `'cancelled'` — the user never asked for that) so the next daemon start (or
   the periodic sweep) picks it back up. Businesses already upserted/enriched this run are untouched
   (`dedupe.needs_enrichment`'s freshness check makes the retry cheap, not a full re-scrape).

## The enrichment cascade — cheapest tier first, always

**Never skip straight to a browser or an LLM.** The whole cost model depends on this order:

1. **OSM tags** (from discovery) already fill many fields for free — check before scraping at all.
2. **Tier 1 — httpx + selectolax**, deterministic: `mailto:`/`tel:` + regex, denylist junk
   (`sentry.io`, `@2x.png`, `noreply@`), contact pages discovered from **nav links** (not a blind `/contact`
   guess), `impressum` included for EU sites.
3. **Tier 2 — Playwright** (`enrich/tier2.py`, built Phase 4), only when Tier 1's result looks JS-shelled
   (`tier2.looks_js_shelled` — near-empty body text, or a near-empty designated SPA root div like `#root`/`#app`).
   Resource-blocking (abort image/font/media/stylesheet) on every Tier-2 page load. **One reused `Browser`
   instance for the whole daemon process** (`tier2._get_browser`, lazy-launched, closed once in `main.py`'s
   shutdown via `tier2.close_browser()`) — never one browser per page/request. Tier-2's only job is producing a
   *better HTML source* for `tier1.py`'s same extraction functions to parse — it is not a separate parsing path.
4. **Tier 3 — LLM**, only for the enabled `dynamic_fields.prompt`s and genuinely ambiguous cases. Provider-agnostic
   via `LLM_BASE_URL` (OpenAI-compatible: Ollama/Gemini/OpenAI/Anthropic-compat) — **default Ollama, optional and
   can be off entirely** (`use_ai_extraction=false`); never assume a paid key is present. Structured JSON output,
   `pydantic`-validated, one retry, cached per `(domain, field-set)`.

A business with only OSM + Tier-1 data is a **valid, complete row** — not a failure. Enrichment is best-effort.

## Crawl politeness (`enrich/policy.py`, Phase 4) — every fetch goes through this

`tier1._fetch` (both the homepage fetch and every contact-page fetch) always calls, in order: (1)
`policy.is_allowed_by_robots` — fail-OPEN (treats the page as allowed) if `robots.txt` is missing/unreachable,
since a broken robots.txt isn't a disallow signal; skip entirely with `crawl_settings.respect_robots_txt=false`.
(2) `policy.wait_for_rate_limit` — enforces `crawl_settings.request_delay_ms` as a **per-domain** minimum gap
(never a global delay; unrelated domains never wait on each other), guarded by a per-domain `asyncio.Lock` so
two near-simultaneous fetches to the same domain (homepage + a contact page) can't both read a stale
"last request time". (3) `policy.get_with_retries` — `crawl_settings.retry_count` **extra** attempts after the
first (so `retry_count=0` = exactly one try; matches the same "N retries after the first" meaning used
elsewhere, e.g. `discovery/overpass.py`'s hardcoded `stop_after_attempt(3)`), no backoff sleep beyond the rate
limiter's own spacing. All three are driven by `crawl_settings` end to end: `pipeline._process_one` →
`enrich_website(respect_robots_txt=, request_delay_ms=, retry_count=, proxy_url=)` → `_fetch`. `proxy_url` is
passed straight to the `httpx.AsyncClient(proxy=...)` constructor when `enrich_website` builds its own default
client (a caller-supplied `client=` in tests bypasses proxy entirely, which is fine — proxying is a
`crawl_settings` feature for the real daemon, not something tests need). The `_robots_cache`/`_last_request_at`
dicts in `policy.py` are process-lifetime module state (same pattern as `tier2`'s browser singleton) — call
`policy._robots_cache.clear()` / `_last_request_at.clear()` / `_domain_locks.clear()` between tests that reuse a
domain name, or state leaks across test cases (see `test_policy.py`).

## Phone/opening-hours parsing (`parse/`, Phase 4) — and why pypostal isn't wired in

- `parse/phone.py` (`normalize_phones`/`normalize_phone`) wraps `phonenumbers.parse(num, region)` +
  `is_valid_number` + E.164 formatting. `region` is always the business's OSM `country` tag (`addr:country`,
  2-letter code) — passing `None` still works for already-international `+`-prefixed numbers but silently fails
  to parse local-format numbers (e.g. `"030 1234567"` needs `region="DE"`).
  **Only the primary `businesses.phone` column is normalized** (`dedupe.upsert_discovered`'s OSM
  `phone` tag, and `dedupe.apply_enrichment`'s first Tier-1 candidate) — the `phones` **array** stays as
  Tier-1's raw, deduped, unnormalized candidates on purpose: req #4 wants *every* phone found on the page, and
  `phonenumbers` would silently drop real-but-ambiguous-without-locale numbers, which defeats that. Same
  reasoning applies to `emails`/`email`.
- `parse/hours.py` (`parse_opening_hours`) parses OSM's `opening_hours` tag into the weekday-keyed JSONB shape
  `businesses.opening_hours` expects. **Deliberately a best-effort parser for the common subset only**
  (day ranges/lists + `HH:MM-HH:MM` ranges, `;`-separated rules, `off`/`closed`) — OSM's full spec includes
  public holidays, seasons, "sunrise"/"sunset", and free-text comments that this does not attempt. **Whole
  string parses cleanly, or the result is `None`** — never a partial/guessed result. Wired into
  `dedupe.upsert_discovered` (writes via `psycopg.types.json.Jsonb`, not a bare dict — psycopg3 doesn't
  auto-adapt plain dicts to jsonb).
- **`pypostal` (libpostal bindings) — deliberately NOT wired in, and not a hard dependency.** Two reasons: (1)
  **verified real blocker**: `pip install postal` fails outright on a plain Windows dev machine (needs MSVC +
  the libpostal C library, neither present) — making it a hard dependency would break local dev/testing on
  Windows entirely. (2) **no actual caller exists**: pypostal's job per the plan is splitting an *unstructured*
  "name on map" address string into components, but our primary discovery path (OSM/Overpass) already provides
  **structured** `addr:housenumber`/`addr:street`/`addr:city`/etc. tags directly — there's no free-text address
  blob in the current pipeline that needs splitting. It becomes relevant once Phase 6 lands (parsing Google's
  `formatted_address` string, which genuinely is unstructured free text) — add it then, behind a lazy
  `try/except ImportError` (Docker-only, apt-installed there) so local Windows dev keeps working regardless.

## Two verified real-crawl bugs (both fixed — read before touching overpass.py or tier1.py)

**1. Overpass's public endpoint needs a form-encoded POST body *and* a descriptive User-Agent, or
it 406s/504s.** Sending the QL as a raw POST body (`content=query`) is intermittently rejected;
the documented-correct shape is `data={"data": query}` (httpx form-encodes it). Separately, a
request with no `User-Agent` header gets a bare `406 Not Acceptable` from the Apache front-end —
same reasoning as Nominatim (`geocode.ts`) and Tier-1's own site fetches. `discovery/overpass.py`'s
default client now sets both. If you ever see Overpass calls failing with 406/504 in a way the
mocked unit tests don't reproduce, check these two things first — the `httpx.MockTransport`-based
tests can't catch either, only a live call can (this is exactly what `test_live_smoke.py` is for).

**2. Regex-scanning raw HTML for phones/emails picks up markup noise, not just page content.**
The original Tier-1 implementation ran `PHONE_RE`/`EMAIL_RE` over the raw HTML string. A live crawl
(64 real Berlin libraries) showed this matching SVG `<path d="...">` coordinate data, CSS decimal
values from `<style>` blocks, `<script>` variable literals (a build timestamp came back as a
"phone"), and `DD.MM.YYYY` dates — sometimes 20-60 garbage "phones" per business. Fixed in two
parts, both required:
- `tier1._strip_noise_and_get_text()` calls `.decompose()` on every `script, style, svg, noscript`
  node **before** reading `.text()` — attribute values (like an SVG path's `d=""`) were never text
  nodes to begin with, but `<script>`/`<style>` *contents* are, and leak through `.text()` unless
  explicitly stripped. Regex extraction now runs on this cleaned text, not the raw HTML string.
- `PHONE_RE` itself was tightened: digit groups must be joined by a **mandatory** space/dash/parens
  separator (`(?:[\s\-]\d{2,8}){1,5}`, not `?`-optional) — this structurally excludes bare
  contiguous digit runs (timestamps, ids) since they have no internal separator to split on. Groups
  may **not** contain `.` at all (kills decimals/dates/version-numbers/SVG coordinates outright,
  since none of those characters are in the pattern). A `YEAR_RANGE_RE` guard additionally drops
  two-4-digit-group matches like `"1998-2026"` that are structurally phone-shaped but aren't. See
  `test_tier1.py`'s regression test (`test_enrich_website_extracts_everything`'s garbage-shape
  assertions) — it encodes every exact garbage pattern seen in the real crawl; extend it, don't
  remove it, if you touch this regex again.
- **Lesson for any future regex-based extraction from HTML** (Phase 4's address/phone parsing,
  Phase 5's pre-LLM text cleanup): always extract from `.text()` after stripping noise tags, never
  from the raw response body. Mocked unit tests with clean HTML fixtures won't catch this class of
  bug — only a real page (real crawl or a fixture deliberately including `<script>`/`<style>`/`<svg>`
  noise, which `test_tier1.py` now does) will.

## Google enrichment is NOT this worker's job

`POST /businesses/:id/enrich-google` lives in the Node API and is user-triggered, per-business, on a button
click. The crawl loop **never** calls Google. If you find yourself wiring a Google call into the discovery/enrich
pipeline, stop — that violates the explicit "manual only" requirement.

## Conventions

- Full type hints, `mypy --strict` clean. `pydantic` models for every DB row shape and every external API
  response — never pass around untyped dicts.
- `tenacity` retries with backoff on all network calls (Overpass, target sites, LLM). Typed exceptions; every
  stage wrapped so a single business's failure never crashes the daemon or drops the rest of the job.
- `structlog`, JSON output, every log line carries `job_id`/`business_id`.
- Region-aware phone parsing: `phonenumbers.parse(num, region)` where `region` comes from the **OSM country tag**
  — omitting it silently drops valid national-format numbers.
- Idempotent re-crawl: skip businesses with a recent `updated_at` unless a "force refresh" flag is set.

## Phase 8 — pool sizing, metrics

- **`settings.db_pool_min`/`db_pool_max`** (defaults 4/40) are now explicit on `create_pool`'s
  `AsyncConnectionPool(...)` — psycopg_pool's real default is `min_size=4, max_size=None` (`None` means "capped
  at min_size", i.e. only 4 connections total unless set). A batch of `crawl_settings.concurrency` (up to 32)
  businesses processed concurrently, each doing several sequential DB writes, would badly serialize behind only
  4 pooled connections — this was a real, easy-to-miss bottleneck, not a hypothetical one. Bump `db_pool_max`
  further only if `concurrency` is ever raised meaningfully above 32.
- **`metrics.py`**'s `increment_metric(pool, key, by=1)` upserts into the same `system_metrics` table Node writes
  to (`backend/api/src/db/systemMetrics.ts` — see `skills_db.md`). Every call site in `pipeline.py` wraps itself
  in its own try/except — a metrics-table write failure must never retroactively mark an otherwise-successful
  business as `'failed'`. Follow that pattern for any new metric you add; don't let observability code affect
  the outcome it's observing.

## Testing (no browser automation against our own app)

Playwright **is** used here — as the product's own Tier-2 scraper against *other* businesses' sites. That is not
"testing with a browser," it's a pipeline stage; it stays exactly as designed. What's off-limits is using
browser automation to verify *our own* app. Unit test extraction/parsing against HTML fixtures; `pytest-asyncio`
for the daemon loop; mock Overpass/LLM/target-site HTTP in tests, live only in the CI-gated smoke tests.
