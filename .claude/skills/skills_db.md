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

## Dedupe (the pattern to reuse everywhere)

- **Primary**: `UNIQUE(osm_type, osm_id) WHERE osm_id IS NOT NULL` — OSM's element id is the stable key.
  Upsert: `INSERT ... ON CONFLICT (osm_type, osm_id) DO UPDATE ...`.
- **Secondary override**: `lower(email)` uniqueness — a business found again by matching email overrides/merges
  into the existing row even if the OSM id differs (re-tagged element, etc.).
- **Fuzzy pass** (after exact upsert): `pg_trgm` similarity on name+address within a geo radius, to merge a
  business that OSM represents as both a `node` and a `way` (two different `osm_id`s, same real business).

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
