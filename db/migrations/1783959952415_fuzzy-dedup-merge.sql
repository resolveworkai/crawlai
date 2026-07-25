-- Authored by: Mohit Singh
--
-- Fuzzy secondary dedup (Phase 4, dedupe.py's rapidfuzz pass — name+address within a geo
-- radius, merging node-vs-way OSM duplicates the exact osm_id/email keys can't catch). A
-- SOFT merge: the duplicate row is never deleted (any missing fields it had are copied onto
-- the canonical row first), just flagged via merged_into_id so public listings can exclude it
-- while the merge stays fully auditable/reversible (null the column to "unmerge"). See
-- .claude/skills/skills_db.md and skills_backend_python.md.

-- Up Migration

ALTER TABLE businesses
  ADD COLUMN merged_into_id UUID REFERENCES businesses(id) ON DELETE SET NULL;

CREATE INDEX idx_businesses_merged_into ON businesses(merged_into_id) WHERE merged_into_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_businesses_merged_into;
ALTER TABLE businesses DROP COLUMN IF EXISTS merged_into_id;
