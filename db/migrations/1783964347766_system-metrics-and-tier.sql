-- Authored by: Mohit Singh
--
-- Phase 8 observability: (1) which enrichment tier a business's contact data actually came from
-- (drives the "tier-hit ratio" metric — how often Tier-2's headless-browser fallback was
-- needed vs. plain Tier-1 HTTP suffices); (2) a tiny generic counters table for call-volume
-- metrics (LLM extraction attempts, Google Places API calls) that don't belong on any one row.
-- See md/plans/0001-*.md "Phase 8" and .claude/skills/skills_backend_node.md.

-- Up Migration

ALTER TABLE businesses ADD COLUMN enrichment_tier TEXT CHECK (enrichment_tier IN ('tier1', 'tier2'));

CREATE TABLE system_metrics (
  metric_key TEXT PRIMARY KEY,
  count BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS system_metrics;
ALTER TABLE businesses DROP COLUMN IF EXISTS enrichment_tier;
