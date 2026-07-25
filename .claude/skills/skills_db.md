<!-- Authored by: Mohit Singh -->

# Database Skills — PostgreSQL

> Read before touching `db/migrations/` or making any schema change.

## Ownership (non-negotiable)

`db/migrations/*.sql`, run via `node-pg-migrate` from `backend/api`, is the **single source of truth** for the
schema. The Node API is the only thing that runs migrations. The Python worker (`backend/worker`) reads the
schema through typed `pydantic` models but **never** issues DDL. This prevents two migration tools fighting over
one database. A schema change without a migration is a bug.

- Every migration has a tested **up and down**.
- `set_updated_at()` trigger pattern is applied to every mutable table (`crawl_jobs`, `businesses`,
  `dynamic_fields`, `crawl_settings`, `users`, `exports`, ...) — don't hand-roll `updated_at` maintenance.

## Master DB is global (not per-user)

`businesses` is one shared table across the whole workspace — dedupe keys are **not** scoped by `user_id`.
`created_by` records who ran the crawl that first created a row, for audit only, never for filtering identity.

## Dedupe (the pattern to reuse everywhere) — as actually built (Phase 3/4)

- **Primary (exact)**: `UNIQUE(osm_type, osm_id) WHERE osm_id IS NOT NULL` — OSM's element id is the stable key.
  Upsert: `INSERT ... ON CONFLICT (osm_type, osm_id) DO UPDATE ...` (`dedupe.upsert_discovered`).
- **Secondary (exact) override**: `lower(email)` uniqueness — a business found again by matching email
  overrides/merges into the existing row even if the OSM id differs. Since this is an UPDATE (not an INSERT),
  a collision can't use `ON CONFLICT` — `dedupe._set_fields_tolerating_email_conflict` catches the
  `UniqueViolation` and retries the same UPDATE with `email` dropped from the field set, leaving the
  existing email-holder canonical for that one field.
- **Fuzzy pass** (`dedupe.merge_fuzzy_duplicate_if_found`, called right after every exact upsert): **not**
  `pg_trgm` — a small lat/lng bounding-box pre-filter in SQL (`FUZZY_MATCH_RADIUS_METERS`, currently 150m).
  followed by `rapidfuzz.fuzz.token_sort_ratio` name comparison **in Python** against each candidate
  (`FUZZY_NAME_SIMILARITY_THRESHOLD`, currently 88). Catches the same node-vs-way OSM duplicate the exact
  keys can't (most duplicate pairs don't share an email tag). **Soft merge, never a DELETE**: the older row
  (by `created_at`) is canonical; the newer row's non-null fields fill any gap the canonical has
  (`COALESCE` per column — never overwrites an existing non-null value), its images move over, then it's
  flagged `merged_into_id = <canonical id>` and its own `email`/`phone` are cleared (required — leaving them
  set on both rows post-copy would collide with the still-live UNIQUE(email) index). `merged_into_id` is
  fully reversible (null it to "unmerge") and is the column every public listing query
  (`listBusinessesFiltered`, `countBusinesses`, `listRecentlyEnriched`, `getOverviewStats`,
  `getSevenDayTrend` in `backend/api/src/db/{businesses,stats}.ts`) filters on
  (`WHERE merged_into_id IS NULL`) so a merged-away duplicate never appears as a separate row. If you add a
  new businesses list/count/aggregate query, add this filter too — it's easy to forget since nothing before
  Phase 4 needed it.
- `pg_trgm` (the extension, already enabled) backs `idx_businesses_name_trgm` for the Businesses screen's
  `search` filter (`name ILIKE`) — a different, unrelated use from the fuzzy-dedupe pass above.

## Queue mechanics — Postgres is the queue, not Redis

`crawl_jobs` is a state machine (`pending → discovering → crawling → paused → completed/failed/cancelled`).
The Node API `NOTIFY`s on `crawl_jobs` after insert; the Python worker `LISTEN`s **and** does a periodic
`pending` sweep (a `NOTIFY` sent while the worker was down is lost — never rely on `LISTEN` alone). Claim a job
with `UPDATE ... WHERE status='pending' RETURNING *` (atomic — never `SELECT` then separately `UPDATE`).
`FOR UPDATE SKIP LOCKED` if/when multiple workers are ever run.

## Column discipline

The ported Lovable `businesses` table has ~80 columns (AI/technical/people extras). **Only populate the columns
that back an actual requirement or feature** — leave the rest nullable rather than guessing values to fill them.
Never fabricate data to make a column non-null (empty/`NULL` renders as `—` in the UI, which is correct).

## Indexes to keep in mind

- `idx_businesses_user_city`, `idx_businesses_job` style indexes on any column used in a list/filter query.
- GiST/geo index if radius queries are ever run against stored rows (discovery itself is Overpass's job, not a
  DB query — this is only relevant for UI-side filtering of already-crawled data).
- `pg_trgm` GIN index to make the fuzzy-dedupe similarity queries fast at scale.

## Local dev database

A **new, dedicated** Postgres instance for this project only — see `skills_devops.md` for the exact container
name/volume/port/credentials. Never point this project at another project's Postgres container.

## Phase 8 — `system_metrics` table (cross-runtime counters)

A tiny generic table (`metric_key TEXT PRIMARY KEY, count BIGINT, updated_at`) for call-volume counters that
don't belong on any one row (LLM extraction attempts, Google Places API calls) — see
`backend/api/src/db/systemMetrics.ts` and `backend/worker/business_scout_worker/metrics.py`. **Both runtimes
write to it** via the same `INSERT ... ON CONFLICT (metric_key) DO UPDATE SET count = count + EXCLUDED.count`
upsert — this doesn't violate the "Node owns the schema" rule above (Python still never runs a migration or
`ALTER`/`CREATE`, only plain `INSERT`/`UPDATE`, same as it already does against `businesses`/`crawl_logs`).
Every increment call site (Python: `pipeline.py`'s two call sites; Node: `googleEnrichmentService.ts`) wraps the
call in its own try/except — a metrics-write failure must never retroactively fail an otherwise-successful
business/job. `businesses.enrichment_tier` (`'tier1'|'tier2'|null`, set by `dedupe.apply_enrichment`) is the
per-business classification the "tier-hit ratio" system metric is computed from — a SQL aggregate over that
column (see `backend/api/src/db/stats.ts` `getSystemHealth`), not a `system_metrics` counter, since it's
naturally per-row rather than a running total.
