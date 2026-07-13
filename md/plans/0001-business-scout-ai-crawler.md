<!-- Authored by: Mohit Singh -->

> **Plan 0001** · Status: **Approved** · Date: 2026-07-13 · Builds on: none (first plan for this project)

# business-scout-ai — Nearby-Business Crawler (Hybrid Node + Python)

## Context

**Standalone new product — `business-scout-ai`** (GitHub `mohit-singh4180/business-scout-ai`; local folder
`C:\GIt\Projects\Latest\crawlee`). Not part of myhub; shares no code with it; built and run entirely at that
separate path. myhub is only a *possible future consumer* of this app's API.

**Authorship & provenance:** the repo currently carries a Lovable-generated scaffold (an `AGENTS.md` Lovable
banner, a "Prospera" placeholder brand). Both are being **removed** as part of this build — see the new
"Project convention — file authorship" section below. All code going forward is authored by **Mohit Singh**.

The tool **discovers nearby businesses by type within a map radius**, scrapes/enriches them into a **master
database**, and exposes that data via an **API** for downstream consumers. A Lovable design exists in the repo —
a TanStack Start (React 19) frontend with **seven screens** (Overview, Discover, Businesses, Crawl Jobs, Dynamic
Fields, Exports, Settings) + a Supabase schema. **All currently mock UI + schema — no crawler engine, no data
wiring, no edge functions.** (Full re-read of every route/component confirmed below — see "Design-spec alignment.")

### Decisions locked in
- **Hybrid stack: Node (web tier) + Python (crawler tier), sharing PostgreSQL.** See the split below.
- **Database: plain PostgreSQL** (not Supabase) — chosen on merit (JSONB, arrays, `ON CONFLICT`, geo, FTS).
- **Discovery: OpenStreetMap / Overpass** (free, no key, ODbL-redistributable).
- **Enrichment: tiered cascade** — HTTP fetch → headless browser (only on demand) → LLM (only for unstructured).
- **AI: provider-agnostic, optional** (OpenAI-compatible: Ollama free / Anthropic / OpenAI). Off = pipeline still runs.
- **Dedupe: OSM element id primary + email override** (+ fuzzy secondary pass).
- **Master DB is GLOBAL** (one shared table, dedupe not scoped per-user; `created_by` for audit).

### ⚠️ Two standing limitations (unchanged)
- **Claude Max ≠ a server API key.** The worker needs a real billed key or local Ollama; or set `use_ai_extraction=false`.
- **OSM ≠ Google.** No Google rating/review-count/photos (kept empty, not faked); "About" tags come from OSM tags,
  images from website scraping, the Google Maps link is constructed from coordinates.

---

## The hybrid architecture — 2 deployable images, DB is the only seam

**Deployment shape: exactly 2 application images + 1 database (as required).**

```
   IMAGE 1: frontend                    IMAGE 2: backend  (Node API + Python worker, one container)
┌───────────────────────┐        ┌────────────────────────────────────────────────────────┐
│ TanStack Start (React) │  HTTP  │  supervisord runs 2 sibling processes:                 │
│ Discover/Jobs/         │───────►│                                                          │
│ Businesses/Fields/     │  SSE   │  ① Node API (Express/Fastify)   ② Python worker (asyncio)│
│ Exports/Settings       │◄───────│     auth·jobs·businesses·        LISTEN+claim→pipeline   │
│ (pure API client — no  │        │     fields·settings·exports·     Overpass→enrich→        │
│  server-side routes)   │        │     geocode·public /api/v1       dedupe→LLM→upsert       │
└─────────────────────────┘        │        │                              │                 │
                                    │        │ SQL                          │ SQL             │
                                    │        ▼                              ▼                 │
                                    │   ┌─────────────────── shared psycopg/pg pool ───────┐ │
                                    └───┴─────────────────────┬──────────────────────────────┴─┘
                                                                ▼
                                          ┌──────────────────── PostgreSQL (own instance) ────────────────┐
                                          │ jobs (LISTEN/NOTIFY+SKIP LOCKED) · businesses (master) · logs  │
                                          │ dynamic_fields · settings · users                              │
                                          └─────────────────────────────────────────────────────────────────┘
```

**The rule that keeps hybrid clean, even inside one image:** the Node API process and the Python worker process
**never call each other directly** — no HTTP, no IPC. Node writes a job row and `NOTIFY`s; Python `LISTEN`s, does
the work, writes results + logs + counters back; Node reads those and streams them to the UI over SSE. The
**only** integration contract is the Postgres schema, enforced even though both processes happen to live in the
same container. This preserves independent testability (each process is unit/integration-tested standalone) and
means the two could be split back into separate containers later with zero code change — only a compose/orchestration
change — if independent scaling is ever needed.

**Why backend = one image (Node+Python via supervisord), per your requirement:** simpler to build, ship, and run —
one image to push/pull/deploy for the whole backend. Trade-off, noted for the record: the two processes can't be
scaled or restarted independently and the image is heavier (Node runtime + Python runtime + Chromium). Acceptable
given the requirement; revisit only if scaling ever demands it.

**Why the frontend is a pure API client (not TanStack server routes doing double duty as the API):** this makes
the frontend a client of the backend's public HTTP surface — the *exact same* surface any future external
consumer (e.g. myhub) uses. No special coupling, no hidden second API. The frontend Dockerfile builds/serves the
TanStack Start app in SSR mode; all data calls go to `BACKEND_URL` (an env var, resolvable via the compose network).

---

## Component-wise plan — who builds what

| # | Component | Owner | Responsibility | Key libraries |
|---|-----------|-------|----------------|---------------|
| **N1** | Frontend (image 1) | **Node** | The 7 screens; Leaflet map (pin + radius circle); recharts dashboard; TanStack Query; pure API client of the backend | TanStack Start, react-leaflet/leaflet, recharts, TanStack Query |
| **N2** | API server (in image 2) | **Node** | Auth (JWT), jobs CRUD + `NOTIFY`, SSE progress stream, businesses read/filter, dynamic-fields CRUD, settings, exports, geocode proxy | Express/Fastify, pg, node-pg-migrate, jsonwebtoken, bcrypt, zod, xlsx |
| **N3** | Public API `/api/v1` | **Node** | API-key-authed read endpoints for external consumers (e.g. myhub) | (same as N2) |
| **N4** | DB schema + migrations | **Node** | **Single source of truth** for the schema (ported from Lovable). Python consumes it, never migrates it | node-pg-migrate (SQL migrations) |
| **N5** | Supervisor (in image 2) | **Node/Python** | Starts + monitors both sibling processes (Node API, Python worker) inside the single backend container; restarts a crashed process | `supervisord` |
| **P1** | Worker daemon | **Python** | `LISTEN crawl_jobs` + startup/periodic poll; atomic job claim; drive status machine; honor `cancel_requested` | psycopg (v3), asyncio, tenacity |
| **P2** | Discovery | **Python** | Overpass QL from type→tag map; query around center+radius; tile large radii; map OSM tags→fields | httpx |
| **P3** | Enrichment cascade | **Python** | Tier-1 fetch+parse (contacts/images/socials); Tier-2 headless fallback; false-positive filtering | httpx, selectolax/BeautifulSoup, playwright |
| **P4** | Address + phone parsing | **Python** | Parse "name on map" → components; validate/normalize phones with region hint | **pypostal** (libpostal), **phonenumbers** |
| **P5** | Dedup | **Python** | Exact upsert (osm_type,osm_id)+email; secondary fuzzy merge (name+addr+geo) | **rapidfuzz**, pg (pg_trgm) |
| **P6** | LLM extraction (optional) | **Python** | Enabled `dynamic_fields` prompts + ambiguous cases → `extras`/AI columns; strip HTML→text; JSON out | openai SDK (any OpenAI-compatible base_url incl. Ollama), pydantic |
| **DB** | Contract | **shared** | Job queue, master businesses table, logs, settings, fields, users | PostgreSQL 15+ |

### Node side — detail (the "web tier")
- **N1 Frontend**: keep the Lovable screens (rename branding away from the "Prospera" placeholder); delete
  `src/integrations/supabase/*` + `@supabase/supabase-js`; add `src/lib/api-client.ts` (fetch+JWT) and TanStack
  Query hooks. **Overview**: stat tiles + recharts trend from `/stats/overview`, top-4 jobs, top-5 recently
  enriched, global log SSE. **AppShell header**: "New crawl" quick-launch modal (type+location+radius →
  `POST /jobs`, same call Discover uses) on every screen. **Discover**: click-to-pin (marker + `L.circle` sized
  by the radius slider), location box → geocode, category chips → config-driven business-type list, "Launch" →
  `POST /jobs`. **Jobs**: live counters + streamed `crawl_logs` (per-job SSE) + **pause/resume/retry/delete**
  actions per job. **Businesses**: filterable master-DB table + detail drawer (`—` for empty); per-row + bulk
  **"Fetch rating" button** → `POST /businesses/:id/enrich-google` (populates rating/reviews/photos live; hidden
  if no `GOOGLE_API_KEY`). **Fields**: `dynamic_fields` CRUD. **Settings**: `crawl_settings` + users/roles.
  **Exports**: xlsx/CSV/**JSON** generation + a persisted "Recent exports" history list with re-download.
- **N2/N3 API (standalone Express/Fastify app under `backend/api/`, JWT + role-gated, versioned `/api/v1`)**:
  `POST /auth/login`, `GET /auth/me` · `POST /jobs` (validate → **geocode here if the user typed a place, so the
  worker always gets lat/lng** → insert `crawl_jobs` → `NOTIFY crawl_jobs, '<id>'`) · `GET /jobs`,`/jobs/:id` ·
  `POST /jobs/:id/pause`,`/resume` (set/clear `pause_requested`) · `POST /jobs/:id/retry` (re-queue with the
  original params) · `POST /jobs/:id/cancel` (set `cancel_requested`) · `DELETE /jobs/:id` ·
  `GET /jobs/:id/stream` (**SSE**, per-job counters+logs) · `GET /logs/stream` (**SSE**, global recent-activity
  feed across all jobs — powers Overview + the Jobs list's console panel) ·
  `GET /businesses` (filter/paginate), `/businesses/:id`, `DELETE` · **`POST /businesses/:id/enrich-google`**
  (manual Google rating/reviews/photos — Find Place → Details; sets `google_enriched_at`) · `dynamic-fields` CRUD ·
  `GET/PATCH /settings` · `GET /stats/overview` (dashboard tiles + 7-day trend) ·
  `POST /exports` (generate xlsx/csv/json → writes an `exports` row + file), `GET /exports` (history),
  `GET /exports/:id/download` · `GET /geocode?q=` (Nominatim proxy for the UI) · public
  `GET /api/v1/businesses` (API-key). **Geocoding lives entirely in Node** (job-creation + the UI box), so the
  Python worker never geocodes — it always receives coordinates.
- **N4 Schema/migrations**: Node owns `db/migrations/*.sql` via `node-pg-migrate`. Any schema change goes through
  here; Python reads the schema, never alters it. This prevents two migration tools fighting over one DB.

### Python side — detail (the "crawler tier")
- **P1 Daemon** (`worker/main.py`): connect psycopg; `LISTEN crawl_jobs`; also poll `pending` on startup +
  every N seconds (NOTIFY is lost if the worker was down). Claim atomically:
  `UPDATE crawl_jobs SET status='discovering' WHERE id=%s AND status='pending' RETURNING *`. Between businesses,
  re-check **both** `cancel_requested` (→ clean `cancelled` stop) **and `pause_requested`** (→ status `paused`,
  idle-poll until cleared, then resume from where it left off — the per-business upsert loop is naturally
  resumable since already-processed rows are skipped). Write `crawl_logs` + counters throughout. (The
  pause/resume/retry/delete **endpoints** are scaffolded in Phase 2; this is where the worker actually honors them.)
- **P2 Discovery** (`discovery/overpass.py`): seed a real business-type→OSM-tag map (gym→`leisure=fitness_centre`
  /`sport=fitness`; library→`amenity=library`; coaching→`amenity=training`/`office=educational_institution`
  ⚠️weak coverage). Union tags in one QL block; `out center tags;` for way/relation centroids. Tile very large radii.
- **P3 Enrichment** (`enrich/`): **Tier-1** `httpx` fetch homepage + contact/about/team/impressum links found in
  the nav (don't blind-guess `/contact`), parse with `selectolax`; extract emails (`mailto:`+regex), phones
  (`tel:`+regex), socials, `og:image`/logo/hero, about-text; denylist junk (`sentry.io`,`@2x.png`,`noreply@`).
  **Tier-2** escalate a page to `playwright` only when Tier-1 looks JS-shelled (tiny body / empty `#root`), with
  image/font/css blocking; tiny browser pool. Best-effort; OSM-only rows are still valid.
- **P4 Parsing** (`parse/`): `phonenumbers.parse(num, region)` where **region comes from the OSM country** (else
  national numbers silently drop); `postal` (libpostal) to split the OSM/Google-style "name on map" string into
  line1/line2/city/state/postcode.
- **P5 Dedup** (`dedupe.py`): upsert `ON CONFLICT (osm_type, osm_id) DO UPDATE`, email as secondary override;
  then a `rapidfuzz` pass over name+address within a geo radius to merge node-vs-way duplicates.
- **P6 LLM** (`llm.py`, optional): provider-agnostic via `LLM_BASE_URL`. **The design names Gemini 2.5 Flash** —
  a good default, and **Google AI Studio has a free tier** for it (so AI extraction can be free within quota, a
  second free option alongside **Ollama**). Feed cleaned page **text** (not HTML); run only enabled
  `dynamic_fields.prompt`s + ambiguous cases; request **structured JSON output**, `pydantic`-validate, one retry
  (mirrors the design's "JSON schema · retries on 429"); cache per `(domain, field-set)`; gated by `use_ai_extraction`.
  Each field's value lands in `businesses.extras.{key}` — exactly what the Fields screen shows.

---

## Coverage matrix — every requirement + every design screen accounted for

**Your 10 data requirements → how they're served:**
| # | Requirement | Source | Status |
|---|-------------|--------|--------|
| 1 | Business name + subname | OSM `name` / `alt_name`·`brand`·`operator` | ✅ full |
| 2 | Address (line1/2·state·city·pincode) + lat/lng + "name on map" | OSM `addr:*` + `pypostal` parse; coords; formatted string constructed | ✅ full |
| 3 | Email + **duplicate override** | enrichment + email-override dedupe | ✅ full |
| 4 | Website → about/contact → **all** emails, **all** phones, business image | Tier-1/2 site scrape | ✅ full (best-effort per site) |
| 5 | **Google rating** | **on-demand** "Fetch rating" button → Google Places Details (per selected business) | ✅ on click |
| 6 | **Google review count** | same on-demand button (same Details call) | ✅ on click |
| 7 | Google Maps link | constructed from coordinates | ✅ full |
| 8 | "About" tags | OSM tags (`wheelchair`,`payment:*`,`internet_access`,`sport`,…) | ◐ partial (OSM tags, not Google's exact chips) |
| 9 | ≥3 gym photos (separate columns) | website images (auto) + Google photos via the same on-demand button | ◐ auto website images; Google photos on click |
| 10 | Weekday timings | OSM `opening_hours` → weekday JSONB | ✅ full (when the business is tagged) |
| + | Configurable radius (km), pin-on-map, open-source map, dynamic add/remove field + per-field instruction | Leaflet + `crawl_settings` + `dynamic_fields` | ✅ full |

**Your 7 design screens → how they're powered:**
| Screen | Powered by |
|---|---|
| **Overview** (dashboard) | `GET /stats/overview` (aggregate tiles + 7-day trend) + jobs/businesses list endpoints (top-N) + global log SSE |
| Discover | N1 Leaflet pin + radius + config-driven category → `POST /jobs`; header's "New crawl" quick-launch modal is the same call |
| Jobs | `crawl_jobs` state machine + `crawl_logs`, streamed via SSE (counters, current_business); pause/resume/retry/delete |
| Businesses | master table + **`enrichment_status` per-row badge** + filters + xlsx/CSV/**JSON** export |
| Fields | `dynamic_fields` CRUD (prompt→JSON schema→extraction); model = Gemini 2.5 Flash **or** Ollama |
| Exports | Node xlsx/CSV/JSON generation + persisted `exports` history + retention cleanup |
| Settings | `crawl_settings` (concurrency/delay/robots/timeout/`use_ai_extraction`) + users/roles |

### Requirements 5, 6, 9 (Google rating / reviews / photos) = manual, on-demand button (DECIDED)
These live only inside Google's data. Rather than a pipeline tier, they're a **manual per-business action** — you
fetch them only for the few businesses you care about, by clicking a button. Never automatic.
- **UI**: a "Fetch rating" (Google) button on each Businesses row + a bulk action on selected rows. Disabled/hidden
  when `GOOGLE_API_KEY` is absent.
- **Endpoint (Node)**: `POST /businesses/:id/enrich-google` — because OSM gives no Google `place_id`, it first
  resolves one via a Places **Find Place / Text Search** (business `name` + stored lat/lng → `place_id`), then a
  **Place Details** call for `rating` + `userRatingCount` + `photos` (+ a Google review URL). Writes those onto the
  row and sets a `google_enriched_at` timestamp so repeat clicks are cheap/skippable. This lives in the **Node API**
  (user-triggered request/response), not the Python worker.
- **Cost**: ~1–2 Google calls per clicked business; at "only a few," effectively free under Google's ~$200/mo
  credit. The automatic crawl **never** touches Google — discovery + reqs 1–4,7,8,10 stay 100% free.
- **Env**: `GOOGLE_API_KEY` (optional; absent = button off, everything else works).

With this, the plan serves **all ten** requirements: 1–4·7·8·10 automatically & free, 5·6·9 on-demand per business.

---

## Design-spec alignment — full re-read findings & the features they add

A complete pass over every remaining route/component (`index.tsx`, `jobs.tsx`, `exports.tsx`, `app-shell.tsx`,
`app-sidebar.tsx`, `status-badge.tsx`) surfaced real functional requirements the earlier partial read missed.
All are now folded into the plan below — nothing in the design is left unaccounted for.

1. **A 7th screen: Overview (`index.tsx`, the `/` route) — the dashboard landing page.** Not previously counted.
   Ships: 4 stat tiles (businesses in master DB, crawls this week, AI extractions count, active jobs count), a
   **recharts** area chart of discovered-vs-enriched volume over the last 7 days, a live crawl-log panel, an
   "Active jobs" list (top 4, reusing the Jobs list), and a "Recently enriched" list (top 5 businesses).
   **Added:** `GET /stats/overview` (Node) aggregating counts + a 7-day discovered/enriched trend (grouped by day
   from `crawl_jobs`/`businesses`); reuses the existing jobs/businesses list endpoints with `limit` for the two
   sub-lists. No new DB tables — pure aggregation queries, cached briefly (e.g. 30–60s) since exact real-time
   precision isn't needed for a dashboard tile.
2. **Job control is richer than "cancel": the design has Play/Pause, Retry, and Delete per job**, plus a
   **`paused`** status the schema's `job_status` enum didn't have. **Added:** extend `job_status` to
   `pending|discovering|crawling|paused|completed|failed|cancelled`; new endpoints `POST /jobs/:id/pause`,
   `POST /jobs/:id/resume`, `POST /jobs/:id/retry` (re-queues a `failed`/`completed` job, reusing its original
   center/radius/type), `DELETE /jobs/:id`. Worker checks a `pause_requested` flag (mirrors `cancel_requested`)
   between businesses and idles until resumed, rather than only supporting a one-way cancel.
3. **Exports need 3 formats, not 2 — the design explicitly lists Excel, CSV, *and JSON*.** **Added:** a JSON export
   endpoint alongside xlsx/csv (structured, nested, includes `extras`).
4. **Exports are persisted with history, not just streamed on-demand** — the design shows a "Recent exports" list
   (filename, size, row count, relative time, re-download) with a stated retention window. **Added:** an `exports`
   table (`id, format, filename, row_count, size_bytes, filter_snapshot jsonb, created_by, created_at,
   expires_at`), files written to a mounted volume (or later S3/MinIO — see Phase 8's image-rehosting note, same
   pattern), `GET /exports` (history list), `GET /exports/:id/download`, and a retention cleanup job (cron in the
   Python worker or a lightweight Node scheduled task) deleting expired export files + rows.
5. **A global "New crawl" button lives in the app header (`AppShell`) on every screen, not just Discover** —
   plus a decorative ⌘K search bar with no functional spec attached in the design (search businesses/jobs/fields).
   **Added:** the header button opens a lightweight "quick launch" modal (type + location + radius) that posts to
   the same `POST /jobs` used by Discover, rather than forcing navigation. **The ⌘K search stays out of scope** —
   it's visually present but functionally unspecified in the design; not blocking, easy to add later as a thin
   layer over the existing `businesses`/`jobs`/`dynamic-fields` list endpoints if ever prioritized.
6. **Branding is Lovable's generic placeholder ("Prospera", "v0.14 · beta", "Anna Kowalski" avatar)** — cosmetic,
   not functional. **Added to Phase 2:** rename to the real product identity (`business-scout-ai` or your chosen
   name), wire the footer to the real logged-in user instead of a hardcoded name.
7. **The Jobs screen's "Live console" and the Overview's "Live crawl log"** both stream `crawl_logs` — confirms
   the SSE design needs to support **both** a per-job stream (`GET /jobs/:id/stream`, used on Jobs when a job is
   open) and a **global recent-activity stream** across all jobs (used on Overview and the Jobs list's console
   panel). **Added:** `GET /logs/stream` (global SSE, all jobs, most-recent-first) alongside the existing per-job one.
8. **`StatusBadge` is a single shared component styling both job statuses and business `enrichment_status`** —
   confirms the two vocabularies were already chosen compatibly (`queued|crawling|enriched|failed` for businesses)
   and validates reusing one badge component/style-map in the frontend rather than building two.

Reuse the Lovable schema's tables/enums/triggers/indexes; strip Supabase-isms:
- **Remove** all RLS policies, `GRANT`s, and `auth.users` FKs. **Add** a `users` table (id/email/password_hash/
  full_name) + keep `user_roles` (`admin|operator|viewer`); authz is app-enforced in the Node API (JWT), not RLS.
- **Keep + extend**: `job_status` — **add `paused`**:
  `pending|discovering|crawling|paused|completed|failed|cancelled`; `log_level` enum unchanged.
  `crawl_jobs` (state machine + counters + `cancel_requested` **+ `pause_requested`**), `crawl_logs`, `businesses`
  (master), `business_images`, `dynamic_fields` (`key/label/prompt/field_type/enabled`), `crawl_settings`,
  `set_updated_at()` trigger.
- **New `exports` table** (design-spec finding — persisted export history, not just on-demand streaming):
  `id, format ('xlsx'|'csv'|'json'), filename, row_count, size_bytes, filter_snapshot jsonb, storage_path,
  created_by uuid, created_at, expires_at`. Backs the Exports screen's "Recent exports" list + retention cleanup.
- **Master-DB = GLOBAL**: dedupe on `(osm_type, osm_id)` + `lower(email)` **without `user_id`**; keep `created_by`
  for audit. Add `osm_type text` + `CREATE UNIQUE INDEX … ON businesses(osm_type, osm_id) WHERE osm_id IS NOT NULL`.
- **Add `enrichment_status`** to `businesses` (`queued|crawling|enriched|failed`) — drives the Businesses screen's
  per-row Status badge (a design element the Lovable schema omitted). The worker sets it as each row moves through
  the cascade.
- **Add `google_enriched_at timestamptz`** — set by the manual `/enrich-google` endpoint so repeat clicks are
  cheap/skippable. Reuse the Lovable schema's existing `google_rating`/`review_count`/`review_url` columns for reqs 5/6.
- **Generic-B2B design leftovers**: the Businesses screen has a `Size/employees` column and the mock uses generic
  categories — vestiges of a general B2B skin. For the gym/library use-case, either populate `employees` via the
  LLM tier (best-effort guess) or hide the column. Don't block on it.
- **Queue mechanics**: channel `crawl_jobs` (`NOTIFY` from Node, `LISTEN` in Python) + `FOR UPDATE SKIP LOCKED` /
  atomic status-claim. **No Redis/Bull.** Optional `cube`/`earthdistance` (or PostGIS) for geo queries on stored rows.
- Migrations: `db/migrations/*.sql` via `node-pg-migrate` (`DATABASE_URL`). **Fill only the columns backing the 10
  requirements** — the Lovable `businesses` table has ~80 columns; leave the technical/ai/people extras nullable.

---

## Repo layout (monorepo, two runtimes, two images)

**Execution-time adjustment (documented, low-risk):** the existing Lovable-generated frontend scaffold has its
build tooling (`vite.config.ts`'s `@lovable.dev/vite-tanstack-config`, `tsconfig.json`'s `@/*` path alias,
`routeTree.gen.ts`) wired assuming the app lives at the **repo root**. Moving it into a `frontend/` subfolder would
mean reconstructing that TanStack Start/Vite/Nitro wiring by hand for zero functional benefit — pure risk. So:
**the frontend stays at the repo root** (image 1 = root `Dockerfile`), and `backend/` + `db/` are added as new
top-level siblings (image 2 = `backend/Dockerfile`). Still exactly 2 images, as required — only the frontend's
*location* differs from the original diagram.

```
business-scout-ai/  (repo root = IMAGE 1, the existing TanStack Start frontend, kept in place)
├─ src/{routes,components,lib,integrations→removed}/   # existing Lovable scaffold, rewired to the backend API
├─ Dockerfile                      # IMAGE 1 — frontend
├─ backend/                        # IMAGE 2 — Node API + Python worker, run as sibling processes
│  ├─ api/                         # Node: Express/Fastify app          [N2/N3]
│  │  ├─ src/{config,routes,middleware,db,lib}.ts …
│  │  └─ package.json
│  ├─ worker/                      # Python: crawler daemon             [P1-P6]
│  │  ├─ pyproject.toml
│  │  └─ business_scout_worker/{main,db,settings}.py, discovery/, enrich/, parse/, dedupe.py, llm.py, google.py
│  ├─ supervisord.conf             # starts `node api/dist/server.js` + `python -m business_scout_worker.main`
│  └─ Dockerfile                   # multi-stage: node build stage + python(+Chromium) stage → one final image
├─ db/migrations/*.sql             # N4 schema — single source of truth (node-pg-migrate)   [Node owns]
├─ md/plans/                       # approved-plan archive (see convention above)
├─ .claude/skills/                 # skill files (see "Skills & docs" below)
├─ docker-compose.yml              # postgres (new/dedicated) + backend + frontend (+ optional ollama)
└─ .env.example
```
**Frontend and API share TypeScript types** via a small `packages/shared-types` (or a published-locally path
alias) so the API contract can't silently drift between the two Node codebases — still zero HTTP between Node
and Python, this is Node-to-Node type sharing only.

## Dependencies
- **Node (frontend):** TanStack Start (present), leaflet + TanStack Query + xlsx + zod (present). Remove `@supabase/supabase-js`.
- **Node (backend/api):** Express or Fastify, `pg`, `node-pg-migrate`, `jsonwebtoken`, `bcrypt`, `zod`, `pino`.
- **Python (backend/worker):** `httpx`, `selectolax` (or `beautifulsoup4`+`lxml`), `psycopg[binary]`, `phonenumbers`, `postal`
  (libpostal — needs the system `libpostal` lib in the image), `rapidfuzz`, `tenacity`, `pydantic`, `structlog`; **Tier-2**:
  `playwright`; **Tier-3 (optional)**: `openai`-compatible client (Ollama by default).

## Local Postgres — new, dedicated instance (isolated from every other project)
Per requirement: a **brand-new** Postgres container for this project only — never the myhub `portal-postgres` or
any other existing instance/network/volume.
- **`docker-compose.yml` service name:** `postgres` — but the **container name, volume, and Compose project are
  all namespaced to this repo** so they can never collide with another project's containers even on the same host:
  - `container_name: business-scout-postgres`
  - volume: `business_scout_postgres_data` (named volume, own persistence — never touches another project's data)
  - top-level `name: business-scout-ai` in `docker-compose.yml` (Compose project name — fully isolates the network/
    volume/container namespace from any other `docker compose` project on the same machine, including myhub's)
  - host port mapping: `5433:5432` (avoids colliding with a default local Postgres or myhub's own mapping on 5432)
- **Credentials (per requirement — dev defaults, documented as such):**
  `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=1234`, `POSTGRES_DB=master_db_crawler`.
  `.env.example` ships these as the default `DATABASE_URL=postgresql://postgres:1234@postgres:5432/master_db_crawler`
  (in-network hostname `postgres`; from the host machine use `localhost:5433`). ⚠️ Flagged once, not blocked on:
  `1234` is a dev-only placeholder — rotate it before any non-local/shared deployment (Phase 8's security pass
  double-checks this isn't still the value at prod time).
- Healthcheck (`pg_isready`) gates both `backend` and any migration step — nothing starts against a not-yet-ready DB.

## Deployment (all free to run)
`docker-compose.yml`: `postgres` (new dedicated instance, above), `backend` (one image, Node API + Python worker via
supervisord, runs migrations on start before the API listens; mounts a named volume `business_scout_exports` for
generated export files), `frontend` (Node, SSR, calls `backend` over the compose network), optional `ollama` (free
local LLM). One `.env`. Runs on any single box / cheap VPS — 3 containers total.

## Cost = $0 (confirmed — no paid API on the critical path)
| Piece | Free path |
|---|---|
| Discovery | Overpass public (~10k/day) or self-host `wiktorn/overpass-api` |
| Geocoding | Nominatim public (1 req/s) — or skip when the user pins the map |
| Map UI | Leaflet + OSM tiles |
| Tier-1/2 scrape | httpx + selectolax / Playwright (free software) |
| AI (P6) | **Ollama, kept optional** — free/local; off entirely also fine |
| DB / hosting | self-hosted Postgres (new dedicated instance, above), run on your own box |
Paid only if you *choose* a hosted LLM/Google-button usage or managed hosting. MVP (Phases 1–3) costs nothing but electricity.

## Engineering standards — rock-solid from day 1 (non-negotiable, enforced every phase)

These are set up in Phase 0 **before any feature code** and gate every commit thereafter. No phase is "done" until
its code meets all of these and its Definition-of-Done tests pass in CI.

- **Strict typing both runtimes.** Node: TS `strict: true`, no `any` (lint-enforced). Python: `mypy --strict`,
  full type hints, `pydantic` models for all external/DB shapes. Types are the contract.
- **One quality-gate command per runtime, wired into CI + pre-commit.** Node: `lint` (ESLint) + `format` (Prettier)
  + `typecheck` (tsc) + `test` (Vitest). Python: `ruff check` + `ruff format` + `mypy` + `pytest`. A push that fails
  any gate cannot merge.
- **Tests are written with the feature, not after.** Every endpoint, every worker stage, every parser ships with
  unit tests; every phase adds/extends an integration test. Target ≥80% line coverage on business logic (parsers,
  dedup, mappers, auth, job lifecycle) — the deterministic core must be near-exhaustively tested.
- **Config validated at boot, fail-fast.** Node: `zod`-parse `process.env` once in `src/config.ts`; Python:
  `pydantic-settings`. Missing/invalid env → process exits with a clear message, never a half-booted service.
- **Structured logging + correlation from the first line.** Node `pino`, Python `structlog`, JSON logs, every log
  carries `job_id`/`business_id` where relevant. No `console.log`/`print`.
- **Consistent error handling.** Node: one error-envelope middleware (`{error:{code,message}}`), typed error classes,
  every async route wrapped. Python: typed exceptions, tenacity retries with backoff on all network calls, every
  worker stage try/except → `crawl_logs` + status, never a silent swallow or an unhandled crash of the daemon.
- **Migrations are the only schema authority.** Every DB change is a reversible `node-pg-migrate` migration with an
  up/down test. Python never DDLs. No schema drift, ever.
- **Idempotency + safety by construction.** Upserts (`ON CONFLICT`), atomic job claim (`FOR UPDATE SKIP LOCKED`),
  re-crawl skips recently-updated rows, graceful worker shutdown (finish current business, mark job, release claim).
- **Containerized from day 1.** Everything runs via `docker-compose up` from Phase 0 — no "works on my machine."
  Healthchecks on every service; the `backend` image blocks on migrations before its API starts serving.
- **CI green from commit #1.** GitHub Actions runs both runtimes' gates + builds both images (`frontend`, `backend`)
  on every push. `main` is always deployable.
- **Two-runtime hygiene.** Node↔Python share only the Postgres schema — **no HTTP between them**. Seam changes are
  reviewed as contract changes.
- **Security baseline from the start.** Bcrypt passwords, JWT with short expiry + refresh, authz middleware on every
  route (deny-by-default), parameterized SQL only, input validated at the edge, secrets only via env (`.env` gitignored,
  `.env.example` committed), dependency audit in CI.

---

## Project convention — approved-plan archival & referencing (REQUIREMENT)

Final, **approved** plans are durable project history so every later plan builds on the last.

- **Location:** `md/plans/` in the repo. Naming: zero-padded sequence + slug, `md/plans/NNNN-<slug>.md`.
  An index `md/plans/README.md` lists every plan (number · title · date · status) newest-first.
- **Only APPROVED/FINAL plans are committed here** — never intermediate/working drafts. Working drafts stay in
  the agent scratch location; a plan is copied into `md/plans/` **only** once the user has approved it.
  Superseded plans are kept (history), marked `Superseded by NNNN` in the index, not deleted.
- **Every new plan must reference relevant prior plans** by number in a "Builds on / supersedes" line at its top,
  so the lineage is explicit and a new plan starts from the last approved reality.
- **Documented as a rule in the repo's `CLAUDE.md` AND `AGENTS.md`** — the rule states the above + "before
  planning new work, read the latest `md/plans/` entry."
- **Ownership:** whoever finalizes a plan updates `md/plans/README.md` in the same commit. Stale index = a bug.

---

## Project convention — file authorship (REQUIREMENT)

**Every source file authored in this project carries a header attributing Mohit Singh**, and **all Lovable
branding/attribution is removed** from the repo's docs.

- **Header format** — a short comment block at the top of every new/rewritten source file:
  - TS/JS: `/** Authored by: Mohit Singh */`
  - Python: `"""Authored by: Mohit Singh"""` (module docstring) or a `# Authored by: Mohit Singh` comment.
  - SQL migrations, YAML, Dockerfiles: `-- Authored by: Mohit Singh` / `# Authored by: Mohit Singh` as the first line.
- **Scope**: applies to files created/substantially authored during this build (backend, frontend, migrations,
  infra, skills, docs). Third-party/vendor/generated files (`routeTree.gen.ts`, `node_modules`, lockfiles, shadcn
  `components/ui/*` primitives kept as-is) are exempt — attribution goes on code we write, not on generated or
  vendored code.
- **Lovable removal**: strip the `<!-- LOVABLE:BEGIN -->…<!-- LOVABLE:END -->` banner from `AGENTS.md`, replace the
  "Prospera"/"v0.14 · beta" placeholder branding in the sidebar (`app-sidebar.tsx`) with the real product identity,
  and ensure `CLAUDE.md`/`AGENTS.md` make no mention of Lovable as the tool/author of record. The `.lovable/`
  config directory, if present, is left untouched unless it causes build issues — it's tooling metadata, not
  attribution. Functional build-tooling dependencies (`@lovable.dev/vite-tanstack-config` in `vite.config.ts`)
  are kept as-is where removing them would add risk for no functional benefit — a deliberate, documented choice.
- **Enforcement**: a lightweight pre-commit/CI check flags a new file missing the header — a soft warning, not a
  hard CI failure, so it doesn't block legitimate generated/config files.

---

## Testing policy — no browser automation against our own app

**Do not use Chrome/browser automation (Playwright-as-a-test-runner, Chrome DevTools MCP, computer-use) to test
this app's own UI or API**, per requirement. Verification of our own code uses:
- **Node:** Vitest for unit + component tests (React Testing Library, JSDOM — no real browser); `supertest`/`undici`
  for API integration tests (real HTTP calls to the running Express/Fastify app, no browser involved).
- **Python:** `pytest` + `pytest-asyncio` for unit/integration; `httpx`'s test client for any internal HTTP mocking.
- **Cross-language seam & E2E:** driven via `docker compose` + scripted API calls (`curl`/`httpx`/Vitest hitting the
  live compose stack) — verifying state through the database and API responses, never by driving a browser against
  our frontend.
- **Manual verification** of the actual UI (if ever needed) is done by the user, not by an automated browser-driving tool.

**Important distinction — this does NOT forbid Playwright as a *product dependency*.** Phase 4's Tier-2 enrichment
*uses* Playwright (headless Chromium) as part of the crawler itself, to render **other businesses' websites** so
their contact info can be scraped. That is core product functionality, not "testing our app with Chrome," and
stays in the plan exactly as designed. The restriction is specifically: don't drive *our own* frontend/API with a
browser-automation tool as a verification method.

---

## Skills & documentation — created in Phase 0, one per layer, token-optimized

Living, per-layer engineering guides that load before touching that layer's code, so conventions are followed
instead of reinvented each session. Created as part of Phase 0, before feature code:

| File | Covers |
|---|---|
| `.claude/skills/README.md` | Index — maps task→skill (SSOT) |
| `.claude/skills/skills_frontend.md` | TanStack Start/React conventions, Leaflet patterns, TanStack Query, component structure |
| `.claude/skills/skills_backend_node.md` | Express/Fastify conventions, route→middleware→handler pattern, zod validation, error envelope, JWT/authz, SSE |
| `.claude/skills/skills_backend_python.md` | Worker daemon conventions, the tiered-cascade pattern, psycopg usage, pydantic models, tenacity retry conventions |
| `.claude/skills/skills_db.md` | Migration workflow (node-pg-migrate up/down), schema-ownership rule (Node-only DDL), dedupe/upsert patterns, indexing |
| `.claude/skills/skills_devops.md` | Docker/compose conventions, the new-dedicated-Postgres rule (never reuse another project's DB), CI gates, secrets handling |
| `.claude/skills/skills_security.md` | Authz-everywhere, PII handling (scraped emails/phones), secrets-in-env, rate limiting, dependency audit |
| `.claude/skills/skills_efficiency.md` | **Token-optimization technique** — how to work this codebase without burning context |

### `skills_efficiency.md` — token optimization technique
- **Search before you read.** `Grep`/`Glob` to locate the exact symbol/file first; never open a file "to look
  around." Read targeted line ranges, not whole files, once the location is known.
- **Prefer Edit over Write.** For existing files, send only the diff, never a full-file rewrite.
- **Delegate wide exploration, not narrow lookups.** A dedicated Explore agent for "find every place X pattern is
  used" keeps the *raw* search transcript out of the main context.
- **Batch independent tool calls in one turn.** Parallel `Read`/`Grep` calls when results don't depend on each other.
- **Never re-read what you just wrote.** The harness confirms Edit/Write success.
- **Summarize large outputs before they enter context.** Test/build/log output over ~50 lines gets `grep`'d for
  the failure/signal, not pasted whole.
- **Terse docs, linked not duplicated.** State a rule once and link to the file that proves it.
- **One skill per concern, loaded on demand.**
- **Small, focused commits/PRs.**
- **Prefer structural checks over full-file diffs for verification.** `tsc`/`mypy`/`pytest`/`ruff` exit codes and
  targeted `grep` prove correctness far more cheaply than re-reading files.

---

## Phased delivery plan (each phase ends deployable, tested, CI-green)

### Phase 0 — Foundations & scaffolding *(no features; establishes the quality bar)*
**Goal:** a running 2-image + DB skeleton where every gate above is already enforced, so all later code is born tested.
**Build:**
- Finalize the monorepo layout (see "Repo layout"): frontend at repo root, `backend/api/` (Node), `backend/worker/`
  (Python), `db/migrations/`. Init both Node package.jsons and the Python `pyproject.toml`.
- **Skills & docs (per the section above):** create all 8 `.claude/skills/*.md` files with real (not placeholder)
  starting content; create the repo `CLAUDE.md` + update `AGENTS.md`, referencing the skills index, the
  plan-archival rule, **and the file-authorship rule (Mohit Singh; no Lovable attribution)**.
- **Plan archival:** create `md/plans/`, save this approved plan as `md/plans/0001-business-scout-ai-crawler.md`,
  add `md/plans/README.md` (index).
- **Provenance cleanup:** strip the Lovable banner from `AGENTS.md`; add the authorship header to every file
  created from this point on. **Skills + archival + provenance cleanup are the very first execution steps, before
  any feature code.**
- Node (frontend): TS strict, ESLint + Prettier, Vitest, React Testing Library. Node (backend/api): TS strict,
  ESLint + Prettier, Vitest + supertest, `src/config.ts` (zod env), `pino` logger, error-envelope middleware,
  `GET /health` (checks DB). Python (backend/worker): `ruff` + `mypy --strict` + `pytest`, `settings.py`
  (pydantic-settings), `structlog`, a `healthcheck()` + `db.ping()`.
- `backend/supervisord.conf`: two programs — the Node API (`node api/dist/server.js`) and the Python worker
  (`python -m business_scout_worker.main`) — `autorestart=true` on both, logs to stdout/stderr (captured by Docker).
- `backend/Dockerfile`: multi-stage — Node build stage (compiles the API) + Python stage (installs deps; base image
  `mcr.microsoft.com/playwright/python` even though Playwright isn't exercised until Phase 4, to retire the
  Chromium-in-container risk early) → final stage copies both outputs + `supervisord`, `CMD supervisord`.
- `Dockerfile` (repo root): standard Node build → SSR serve for the frontend.
- `docker-compose.yml` (project `name: business-scout-ai`): **`postgres`** (new dedicated instance — see the
  "Local Postgres" section for exact container name/volume/port/credentials; healthcheck `pg_isready`), `backend`
  (waits on postgres healthy, runs migrations, then `supervisord` starts both processes), `frontend` (waits on
  backend healthy), optional `ollama`.
- CI (GitHub Actions): matrix job running Node(frontend) gates + Node(backend/api) gates + Python(backend/worker)
  gates + `docker compose build` for both images; pre-commit hooks running the same gates locally.
- `.env.example` with every var (incl. the Postgres dev credentials, documented as dev-only); config refuses to
  boot if required vars missing.
**Rigor / tests:** a trivial passing test in each of the 3 codebases; CI green; `docker compose up` → all 3
containers healthy (own, dedicated Postgres — confirm via `docker ps` that no other project's containers are
touched); `GET /health` 200 from the backend, reachable through the frontend. **Definition of Done:** fresh clone →
`docker compose up` → postgres+backend+frontend all healthy + CI passing on the first PR + all 8 skill files present
+ this plan archived at `md/plans/0001-*.md`.

### Phase 1 — Data foundation *(schema, migrations, typed access, seed)*
**Goal:** the complete DB contract, migration-managed, readable/writable from both runtimes, with fixtures.
**Build:**
- Port the Lovable schema → plain Postgres migrations (strip RLS/`auth.users`/grants); add `users`+`user_roles`,
  the **global** dedupe indexes (`(osm_type,osm_id)` + `lower(email)`), `enrichment_status`, `google_enriched_at`,
  the `crawl_jobs` (**with `paused` status + `pause_requested`**)/`crawl_logs`/`dynamic_fields`/`crawl_settings`/
  **`exports`** tables, enums, `set_updated_at` trigger, `pg_trgm`.
- Node data-access modules (typed query functions per table) + shared TS types.
- Python `db.py` (psycopg pool) + `pydantic` row models mirroring the tables.
- Seed script: one admin user (bcrypt), default `crawl_settings`, the business-type→OSM-tag map, a couple sample
  `dynamic_fields`.
**Rigor / tests:** every migration up **and down** tested; constraint tests (dedupe uniqueness collides as expected,
enum rejects bad values); CRUD smoke from both Node and Python against a real (compose) Postgres. **DoD:** migrations
apply forward+back cleanly; seed runs; both runtimes read/write every table under test.

### Phase 2 — Web tier: auth + Node API + frontend rewired to real (empty) data *(no crawler yet)*
**Goal:** the whole app works against the real DB — you can log in, manage fields/settings, and create a job row —
with zero mock data left.
**Build:**
- Auth: `POST /auth/login`, `GET /auth/me`, refresh; bcrypt; JWT; role middleware (deny-by-default).
- Endpoints (all zod-validated, error-enveloped, logged): `jobs` create/list/get/cancel/**pause/resume/retry/delete**;
  `businesses` list(filter/paginate)/get/delete; `dynamic-fields` CRUD; `settings` GET/PATCH; `geocode` (Nominatim
  proxy); `stats/overview` (aggregate tiles + trend); `POST /jobs` geocodes when given a place name and inserts
  `crawl_jobs` (pending) + `NOTIFY` (worker consumer added P3); SSE `GET /jobs/:id/stream` **and** `GET /logs/stream`
  (global) scaffolds. Schema gains `paused` job status + `pause_requested` column (Phase 1 migration).
- Frontend: delete `src/integrations/supabase/*` + dep; add `api-client.ts` (JWT) + TanStack Query hooks; rewire all
  **7 screens** (incl. Overview); rebrand away from the Lovable "Prospera" placeholder; **Discover** click-to-pin +
  `L.circle` radius + geocoded location box + config-driven categories; header "New crawl" quick-launch modal;
  Fields/Settings functional; Businesses/Jobs/Overview render real (empty) data.
**Rigor / tests:** API integration tests for every endpoint incl. authz (401/403 paths); frontend hook/component
tests for auth + job-create + fields CRUD; **grep proves no `mock-data` import remains.** **DoD:** log in → create a
job (lands as `pending` in DB) → see it listed; manage fields/settings live; all against real Postgres.

### Phase 3 — Crawler MVP: the free end-to-end *(Python worker + the seam)* — **the milestone**
**Goal:** a real, zero-cost crawl: pin → discover via OSM → Tier-1 enrich → master DB, with live progress in the UI.
**Build:**
- Worker daemon (`main.py`): `LISTEN crawl_jobs` **and** a startup + periodic `pending` sweep (NOTIFY is lost if the
  worker was down); atomic claim (`UPDATE … WHERE status='pending' RETURNING`); status machine
  (`discovering→crawling→paused→completed/failed`); `cancel_requested` **and `pause_requested`** checks between
  businesses; graceful shutdown. (Full pause/resume UX lands with Phase 6's job-control endpoints — the worker's
  pause-loop capability is built here since it's core to the daemon's per-business loop.)
- Discovery (`overpass.py`): concrete type→tag seed map (gym/library/coaching — flag coaching's weak OSM coverage);
  `around` query; `out center tags`; tile large radii; retries/backoff; endpoint-configurable; tag→field mapping.
- Tier-1 enrichment: `httpx` fetch with full hygiene (UA, timeout, redirect cap, content-type + size guards, relative-URL
  resolution), contact-page discovery **from nav links** (+ `impressum`), `selectolax` parse, email/phone/social/`og:image`
  extraction, false-positive denylist, emails lowercased.
- Upsert + exact dedupe; `enrichment_status` transitions; `crawl_logs`; counters; idempotent re-crawl (skip fresh rows).
- Node: `POST /jobs` `NOTIFY` consumer live; SSE streams counters + logs; Discover "Launch" + Jobs live view + cancel.
**Rigor / tests:** unit — Overpass tag→field mapping, extraction from HTML fixtures, denylist, dedupe upsert; **the seam
integration test** (Node inserts job → worker claims + processes → Node SSE shows progress → rows land); a CI-gated
**live smoke** against real Overpass + 2 real sites. **DoD:** pin a real location, launch, watch progress live,
businesses appear with OSM + Tier-1 data, `—` where OSM lacks it. **No paid API. This is the shippable MVP.**

### Phase 4 — Enrichment depth *(Tier-2 browser + parsing + fuzzy dedup)*
**Goal:** production-grade enrichment quality and coverage.
**Build:**
- Tier-2 Playwright fallback: escalate a page **only** on a JS-shell heuristic (tiny body / empty root); resource-blocking
  (abort image/font/css/media); one reused browser, tiny pool, hard timeouts; verify Chromium launches in-container.
- `phonenumbers` with `region` derived from the OSM country (else national numbers silently drop); `pypostal`
  (libpostal in image) to split the "name on map" string into components; `opening_hours` → weekday JSONB.
- `rapidfuzz` secondary dedup (name+address within a geo radius) to merge node-vs-way duplicates.
- Per-domain rate limiting + robots.txt + retry caps (from `crawl_settings`); optional `proxy_url`.
**Rigor / tests:** browser-launch + resource-block test; phone (region), address-split, opening-hours, fuzzy-merge units;
robots/rate-limit tests; enrich a known JS-rendered fixture site. **DoD:** JS sites enriched; phones/addresses normalized;
duplicates merged; robots honored; Chromium proven in Docker.

### Phase 5 — AI extraction tier *(dynamic fields — optional, gated)*
**Goal:** the Fields feature — prompt-driven structured extraction into `extras.{key}`.
**Build:**
- Provider-agnostic `llm.py` (one OpenAI-compatible `/v1/chat/completions` client → Gemini / OpenAI / **Ollama**);
  send cleaned page **text** not HTML; **structured JSON output** + `pydantic` validation + one retry (mirrors the
  design's "JSON schema · retries on 429"); per-`(domain,field-set)` cache; token caps; `use_ai_extraction` gate.
- Wire enabled `dynamic_fields.prompt`s → worker → `extras`/AI columns; Fields screen drives it end-to-end.
- **Claude Max token — DECIDED: not used here.** A Max subscription is not an API key; the only programmatic path
  is Claude Code headless / the Agent SDK (subscription auth). That's an *interactive coding* tool with rolling
  usage caps and isn't meant as a bulk backend — at crawler volume it would hit limits and is outside intended use.
  Since the LLM tier is optional and only handles the few dynamic/ambiguous fields (Tiers 1–2 do the rest), default
  to **Ollama (free/local)** or **Gemini 2.5 Flash free tier**; a metered API key only if top quality is wanted.
  The provider-agnostic client means swapping any of these is an env change, not a code change.
**Rigor / tests:** prompt assembly, JSON-schema validation, cache hit/miss, gating, field-type coercion — all with a
**mocked LLM**; one CI-gated live smoke against Ollama. **DoD:** create a dynamic field with a prompt → run a crawl →
`extras.{key}` populated and visible in Businesses/exports.

### Phase 6 — Manual Google enrichment *(reqs 5/6/9, on-demand button)*
**Goal:** rating/reviews/photos for hand-picked businesses, never automatic.
**Build:**
- Node `POST /businesses/:id/enrich-google`: resolve `place_id` via Places **Find Place / Text Search** (name + stored
  lat/lng) → **Place Details** for `rating` + `userRatingCount` + `photos` (+ review URL); write columns + `google_enriched_at`;
  skip if recently enriched; clear errors on quota/no-match.
- Frontend: per-row + bulk "Fetch rating" button in Businesses; hidden/disabled without `GOOGLE_API_KEY`; live row update.
**Rigor / tests:** endpoint tests with a **mocked Google client** (found / not-found / quota-error); button interaction +
hidden-without-key test. **DoD:** click a business → real rating/reviews/photos populate; nothing calls Google automatically.

### Phase 7 — Exports (xlsx/csv/json + history) + public API + consumer bridge
**Goal:** get data out, for humans and machines, matching the design's Exports screen exactly.
**Build:**
- Exports: generate **xlsx, csv, and json** from the master DB (streamed for large sets), explicit column mapping,
  respects current filters; each generation writes a row to the new `exports` table (filename/format/row_count/
  size/filter_snapshot) + a file to a mounted volume; `GET /exports` powers the "Recent exports" list,
  `GET /exports/:id/download` re-serves a past export; a retention cleanup (cron) deletes expired rows+files past
  the configured window.
- Public `GET /api/v1/businesses`: API-key auth, pagination, filtering; publish an OpenAPI spec for consumers.
- Documented category-map/filter spec for downstream onboarding (e.g. myhub maps → its gym/library/coaching, imports
  as unpublished for review — that endpoint is **myhub's** future work, out of scope here).
**Rigor / tests:** export correctness for all 3 formats (columns/rows/encoding) + large-set streaming; history
list + re-download + retention-cleanup tests; api-key gate (200/401); pagination + filter tests. **DoD:** export a
filtered set to xlsx/csv/json; see it in "Recent exports" and re-download it; hit `/api/v1/businesses` with a key
→ correct paginated JSON.

### Phase 8 — Hardening, observability, deployment & docs *(production readiness)*
**Goal:** operable, secure, documented, backed-up.
**Build:**
- Observability: metrics (jobs/hr, success rate, tier-hit ratios, LLM/Google call counts), a status surface, error
  aggregation; alarms on failure spikes.
- Security pass: authz audit on every route, rate limiting on auth + public API, input sanitization review, dependency
  scan, secrets audit.
- Performance: pool sizing, index EXPLAIN review, worker concurrency tuning, a large-crawl load test; self-host Overpass/
  Nominatim guidance for volume.
- Compliance: robots.txt honored, **ODbL attribution** surfaced, PII/outreach note (GDPR/DPDP/CAN-SPAM/PECR), optional
  image re-hosting to S3/MinIO.
- Deployment: prod `docker-compose` (or target host), migrations-on-deploy gate, DB backups + restore drill, restart
  policies + healthchecks; a runbook.
- Docs: README, architecture doc (this plan), API/OpenAPI doc, ops runbook, `.env` reference.
**Rigor / tests:** load test passes at target volume; restore drill succeeds; security checklist signed off; full
`docker compose up` cold-start E2E (migrations → crawl → enrich → export) green in CI. **DoD:** a monitored, backed-up,
documented deployment; one command from clean host to running system.

### Cross-phase testing pyramid (applied continuously)
- **Unit** (fast, mocked I/O): parsers, mappers, dedup, auth, validation, prompt assembly, Google client.
- **Integration** (real compose Postgres, mocked external HTTP): every endpoint, worker stages, the **Node↔Python seam**.
- **Live smoke** (CI-gated, few real requests): Overpass, a couple of real sites, Ollama, Google (mock by default).
- **E2E** (compose cold start): pin → discover → enrich → (AI) → export, asserting `—` where OSM lacks data.

## Research basis
Overpass/OSM for free POI-by-category (mainstream lead-gen pattern); Cheerio/selectolax + fetch handles most
(server-rendered) business sites at hundreds/min with no browser; progressive HTTP-first→headless→LLM tiering is
the documented cost-minimizing production pattern; regex+mailto/tel+denylist+libphonenumber is the standard
deterministic contact-extraction method (LLM only for unstructured/classification).
