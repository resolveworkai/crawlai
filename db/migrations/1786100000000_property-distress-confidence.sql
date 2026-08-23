-- Authored by: Mohit Singh
--
-- distress_confidence (2026-08-23) — a 0-100 companion figure to distress_score, computed by
-- property/analysis.py's compute_distress_confidence: how much of the score is backed by real
-- data vs. a neutral fallback (e.g. no price/area to rank against, no average_rent captured yet)
-- rather than presenting every listing's score as equally certain. Set alongside distress_score
-- at every scoring pass (pipeline.py's Stage C, and again after Stage D's detail scrape once
-- average_rent may be known for the top-N listings).

-- Up Migration

ALTER TABLE property_listings ADD COLUMN distress_confidence REAL;

-- Down Migration

ALTER TABLE property_listings DROP COLUMN IF EXISTS distress_confidence;
