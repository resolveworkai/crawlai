-- Authored by: Mohit Singh
--
-- property_building_ages (2026-08-25) — a manually-curated reference table mapping a real
-- building/tower name, scoped to a region (community/area), to its known completion year. Real
-- per-listing age_years only ever exists for the job's detail_scrape_top_n highest-scoring
-- listings (a detail-page-only field) — most captured rows never get one. This table is a
-- fallback: the user supplies real building/age data per region (starting with Dubai Sports City,
-- 107 real buildings), and every listing whose title/community/location_text contains a known
-- building name gets a MAPPED age even when it wasn't individually detail-scraped.
--
-- completion_year is the durable fact (an "age in <year>" figure goes stale every calendar year —
-- age is always derived at READ time as current_year - completion_year, never stored). NULL means
-- genuinely unknown (source table's "N/V" rows). is_estimated is true when the source's own
-- completion year was itself uncertain (marked with a "*" or given as a year range like "2015/16"
-- in the source table) — surfaced in the UI as an approximate "~" age rather than an exact one.

-- Up Migration

CREATE TABLE property_building_ages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    region TEXT NOT NULL,
    building_name TEXT NOT NULL,
    completion_year INTEGER,
    is_estimated BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness per (region, building_name) — re-importing the same region
-- upserts existing rows instead of duplicating them.
CREATE UNIQUE INDEX idx_property_building_ages_region_name
    ON property_building_ages (lower(region), lower(building_name));

CREATE INDEX idx_property_building_ages_region ON property_building_ages (lower(region));

-- Down Migration

DROP TABLE IF EXISTS property_building_ages;
