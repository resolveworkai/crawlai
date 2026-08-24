-- Authored by: Mohit Singh
--
-- sort_order (2026-08-24) — the SOURCE SITE's own sort order, applied BEFORE scraping begins
-- (distinct from the frontend's post-capture SortKey, which only re-orders what's already been
-- captured). Empirically confirmed live against both real sites' own "Sort"/"Sort by" UI — see
-- backend/worker/business_scout_worker/property/adapters/{dubizzle,propertyfinder}.py's own
-- _SORT_PARAM maps for the real per-platform query-param values this maps to. "default" is each
-- platform's own out-of-the-box ordering (dubizzle: "Popular"; propertyfinder: "Featured").
-- Applied to both property_jobs (a launched search) and property_job_schedules (a saved recurring
-- search — its own choice is carried into every job it fires, same as every other criteria field).

-- Up Migration

ALTER TABLE property_jobs
  ADD COLUMN sort_order TEXT NOT NULL DEFAULT 'default'
    CHECK (sort_order IN ('default', 'newest', 'price_low_high', 'price_high_low'));

ALTER TABLE property_job_schedules
  ADD COLUMN sort_order TEXT NOT NULL DEFAULT 'default'
    CHECK (sort_order IN ('default', 'newest', 'price_low_high', 'price_high_low'));

-- Down Migration

ALTER TABLE property_job_schedules DROP COLUMN IF EXISTS sort_order;
ALTER TABLE property_jobs DROP COLUMN IF EXISTS sort_order;
