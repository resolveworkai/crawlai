<!-- Authored by: Mohit Singh -->

# business-scout-ai

A multi-source crawl and research platform. It discovers nearby businesses, researches e-commerce
products, hunts distressed property deals, and runs outreach on what it finds. All of it sits behind
one dashboard and one PostgreSQL database.

Hybrid stack: Node (web tier) + Python (crawler tier), sharing one dedicated Postgres. See
`AGENTS.md`/`CLAUDE.md` for the full architecture, coding conventions, and API endpoint table.

## Stack

| Layer | Tech |
|---|---|
| Frontend | TanStack Start (React 19) + Vite + Tailwind + shadcn-ui + Leaflet + recharts + TanStack Query |
| Backend API | Node.js + Express + TypeScript (strict) |
| Crawler worker | Python (`mypy --strict`) + asyncio + psycopg + httpx + selectolax + Playwright + Tesseract OCR + phonenumbers + rapidfuzz |
| Database | PostgreSQL (own dedicated instance, never shared with another project) |
| Discovery | OpenStreetMap / Overpass API (free) |
| AI extraction | Optional, provider-agnostic (Ollama by default, or any OpenAI-compatible key) |

## Architecture

```
frontend (TanStack Start, pure API client)  --HTTP/SSE-->  backend (ONE image, two processes)
                                                              · Node API    (backend/api)
                                                              · Python worker (backend/worker)
                                                            Node <-> Python: Postgres only
                                                                 |
                                                                 v
                                                      PostgreSQL (dedicated)

operator's Windows host (outside Docker):
  Chrome (remote-debugging :9222) <-- host runners (property, noon) --> same Postgres
```

Node and Python never talk to each other over HTTP. They share only the database, using
`LISTEN`/`NOTIFY` plus shared job and result tables.

## Crawl operations

Every job type below follows the same pattern. Node inserts a job row and sends `pg_notify`, the
Python worker claims it atomically, and results land in that module's own tables. Modules share no
code with each other.

### 1. Business discovery crawler (main pipeline)
OpenStreetMap/Overpass discovery by business type within a configurable map radius, then tiered
website enrichment, all into the master `businesses` table. Free, ToS-clean, and built for scale.

- **Discovery:** pick a point on the map, a radius, and a business type.
- **Tier 1:** plain HTTP fetch and parse (emails, phones, socials, images).
- **Tier 2:** headless Playwright, used only when Tier 1 looks JS-shelled. Heavy resources are blocked.
- **Tier 3 (optional):** LLM extraction into `businesses.extras`, gated by a Settings toggle. Works with Gemini, OpenAI, or Ollama.
- **Normalisation and dedupe:** E.164 phone numbers, parsed opening hours, exact dedupe, and fuzzy soft-merge via `rapidfuzz` (never deletes).
- **Politeness:** robots.txt honoured by default, per-domain rate limiting, retries.
- **Job controls:** pause, resume, retry, cancel, with live progress over SSE.
- **Google enrichment (manual):** a "Fetch rating" button (per-row and bulk) via Places API, gated by `GOOGLE_API_KEY`.

### 2. Crawl (OCR): Google Maps (`md/OCR_CRAWL.md`)
A low-volume job type that opens each Google Maps place page. It captures structured contact data
plus a screenshot audit trail.

- **Fields from the DOM:** phone, website, address, plus code, rating, category, hero image. These come from exact `data-item-id` attributes, with no OCR misreads. Tesseract is the fallback for hours and email, and for the visual record.
- **Radius search and grid tiling:** center point and radius up to 300 km. Large areas are tiled into overlapping sub-searches, with an exact haversine filter on each business's own coordinates. Cross-cell duplicates are removed by Google place id.
- **Queueing:** new jobs never get rejected. They queue and auto-run one at a time, so there is never more than one concurrent Maps session.
- **Retry and refresh:** failed or blocked jobs resume from where they stopped. A `ready` job's Refresh re-scans from scratch and overwrites the old results.
- **Performance:** single-threaded Tesseract (`OMP_THREAD_LIMIT=1`) running concurrently across businesses (`OCR_CONCURRENCY`, defaults to cores minus 1, capped at 8).
- **Export:** whole-job CSV/XLSX, plus per-row export on every result.
- **Known gap:** review count is not obtainable anonymously.

### 3. Product Research / Ecom crawl (`md/ECOM_CRAWL.md`)
Searches **amazon.ae**, **amazon.in**, **noon.com**, and **AliExpress** for a query and walks the result cards page
by page. It reads card fields from the DOM (title, price, rating, reviews, badges, sponsored flag),
OCRs a screenshot as a fallback, and scores every product with a weighted opportunity score
(reviews, rating, demand, value).

- Sortable results table with CSV/XLSX/JSON export.
- **amazon.ae** runs headless in the container. **amazon.in** runs on the host runner through your real Chrome, because Amazon returns HTTP 503 to the headless browser. Amazon rate-limits automated traffic, so refused jobs end `blocked` and can be retried later.
- **noon and AliExpress** need the operator's real Chrome over CDP (see host runners below).

### 4. Property Research
Searches **dubizzle.com** and **propertyfinder.ae** by location, bedrooms, bathrooms, property type,
purpose (buy or rent), and ready or off-plan status.

- **Distress-deal scoring:** price per sq ft, distress language, freshness, verification, and rental yield, each weighted. Each score carries a data-completeness confidence figure.
- **Detail scrape of the top N:** phone number, `wa.me` WhatsApp link, listed date, property age, and average rent. Nothing is ever fabricated. A missing value stays `null`.
- **Sort before scraping:** newest or price low-to-high / high-to-low, using each site's own server-side sort.
- **Price tracking:** per-row live price refresh. Cross-job price drops are highlighted, matched on the listing URL.
- **Cross-platform duplicate badge:** flags a unit that appears on both sites ("also on propertyfinder"). It is a heuristic, labelled "possible".
- **Wishlist and compare:** save listings as snapshots and compare them side by side across jobs.
- **Global search:** search every captured listing by tower or building name.
- **Building-age reference table:** paste a per-region building-to-completion-year table to give listings a mapped age without a detail scrape.
- **Recurring searches:** saved searches that re-fire every 6 to 720 hours, so price-drop detection has fresh data. "Refresh Search" re-runs a job's own criteria in one click.
- **Concurrency:** dubizzle and propertyfinder run concurrently, with one job per platform at a time.

### 5. Marketing / outreach (`md/MARKETING.md`)
Acts on discovered businesses. Recipients come from an uploaded CSV/XLSX and/or finished OCR jobs,
deduped to unique businesses, plus manually added contacts.

- **WhatsApp manual (no ban risk):** per-business `wa.me` links, a fast keyboard-driven send panel, and a `.vcf` contact export.
- **WhatsApp automated (ban risk):** a local-only sender that drives your own WhatsApp Web session, with randomised delays, a daily cap, and a mandatory test-send. WhatsApp can and does restrict accounts for bulk automation, so use it with care.
- **Email via SMTP:** inline images and attachments, `{business_name}`-style placeholders, throttled bulk send, an unsubscribe footer, and a suppression list. SMTP passwords are AES-256-GCM encrypted at rest.
- **Templates:** curated, business-type-aware message templates.
- **Campaigns:** history, a per-campaign Excel report, and a Failed panel.

## Other features

- **Dashboard:** overview stats across every module, plus a live crawl log stream (SSE) covering the main crawler and OCR.
- **Exports:** XLSX/CSV/JSON generation with history and retention cleanup. XLSX uses `exceljs`, never the vulnerable SheetJS package.
- **Public API:** `GET /api/v1/businesses` with API-key auth and rate limiting, plus an unauthenticated OpenAPI spec at `/api/v1/openapi.json`.
- **Dynamic fields:** custom business fields managed in the UI.
- **Settings:** crawl concurrency, LLM toggle, OCR result cap, and robots.txt behaviour.
- **Auth:** JWT with roles (admin, operator, viewer). Routes are deny-by-default, with login rate limiting.
- **Observability:** `GET /stats/system` reports job success rate, a failure-spike alarm, tier-hit ratio, and LLM/Google call counts.
- **Light and dark theme:** toggle in the header, with no flash of the wrong theme on load.
- **Global command search** in the header.

## Host runners (Property Research, noon, AliExpress)

dubizzle, propertyfinder, and noon block automated and headless browsers at the edge, so those
modules run through your real Chrome. A Linux container can't reach it. Two small host processes
attach over CDP (`127.0.0.1:9222`) instead.

```powershell
powershell -File scripts\install-host-watchdog.ps1     # once per machine: install the self-healing watchdog
scripts\start-all-hosts.bat                            # any time: start whatever runner is missing, right now
powershell -File scripts\install-host-watchdog.ps1 -Uninstall
```

**Auto-healing.** The runners are plain Windows processes, so nothing used to restart one that died
(a reboot, a closed window, a crash) and jobs just sat queued. `install-host-watchdog.ps1` registers
a per-user scheduled task (no admin needed) that runs `scripts\host-watchdog.ps1` at logon and again
every 5 minutes. It checks both runners every 30 seconds and:

- **restarts a runner that is gone** (typically back within ~15s),
- **restarts a runner that is alive but frozen** (heartbeat older than 5 minutes),
- **backs off** instead of restarting forever if a runner keeps crashing (5 starts in 10 minutes).

It never starts a second copy of a healthy runner (a duplicate fails the first one's in-flight job),
and it only ever kills a runner by its exact command line, never a blanket `python.exe` or
`chrome.exe`. Each launch writes its own log in `backend\worker\storage\logs\`
(`noon-host-<time>.log`, `property-host-<time>.log`, plus `host-watchdog.log`).

- The runners also **self-heal Chrome**: if the debug Chrome dies, one relaunches it.
- Each runner writes a **heartbeat** from an always-running task, so the dashboard banner means what it says: it appears when a runner is dead or frozen, not merely busy with a long job.
- Never kill Chrome with a blanket `taskkill /IM chrome.exe`. Target the debug profile's PIDs only.

## Quickstart

```bash
docker compose up -d --build
```

Brings up `postgres` (dedicated, isolated instance), `backend` (Node API + Python worker via
supervisord, migrations applied automatically on start), and `frontend`.

| Service | URL |
|---|---|
| Frontend | http://localhost:3000 (override with `FRONTEND_PORT` + `FRONTEND_ORIGIN` in `.env` if the port is taken) |
| Backend API | http://localhost:4010 |
| Postgres | `localhost:5436` |

Then, for Property Research and noon, start the host runners (above). See `.env.example` for every
configurable variable.

Dev helpers: `scripts\restart-all.bat` (rebuild and restart everything, including host runners) and
`scripts\stop-all.bat`.

## Compliance notes

- **Maps and marketplace crawling:** automating Google Maps, dubizzle, propertyfinder, noon, and similar sites may violate their Terms of Service. The modules are built for low-volume, internal use. Google's Places API is the compliant route to the same Maps fields.
- **Outreach:** bulk emailing or messaging scraped contacts may fall under CAN-SPAM, GDPR, DPDP, or PECR depending on jurisdiction. The tool includes an unsubscribe and suppression mechanism. Compliance remains the operator's responsibility.
- **OpenStreetMap data (ODbL):** public use of discovered data needs an "© OpenStreetMap contributors" attribution. This is not yet surfaced in the UI or exports.

## Docs

| Doc | Covers |
|---|---|
| `AGENTS.md` / `CLAUDE.md` | Full architecture, API routes, engineering standards, verified-live status of every module |
| `md/OCR_CRAWL.md` | Crawl (OCR): capture mechanism, DOM-vs-OCR sourcing, retry/refresh, performance tuning |
| `md/ECOM_CRAWL.md` | Product Research: platforms, scoring, noon CDP requirement |
| `md/MARKETING.md` | Outreach: WhatsApp (manual and automated), email, templates, campaigns |
| `md/plans/` | Approved, dated implementation plans (newest first in `md/plans/README.md`) |
| `.claude/skills/` | Per-layer engineering conventions. Read the relevant one before touching that layer's code |

## Quality gates

Node (frontend + `backend/api`): `npm run lint && npm run typecheck && npm test`.
Python (`backend/worker`): `ruff check . && ruff format --check . && mypy . && pytest`.
CI runs all of the above plus a `docker compose build` for both images on every push.
