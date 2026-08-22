-- Authored by: Mohit Singh
--
-- Three fields, all confirmed live 2026-08-22:
-- - property_jobs.property_status — job-level ready/off-plan/any preference. No confirmed
--   server-side URL param for either platform, so this is enforced client-side at capture time
--   (see backend/worker/business_scout_worker/property/capture.py) against each listing's own
--   is_offplan flag below. Defaults to 'ready' — the confirmed user preference.
-- - property_listings.is_offplan — per-listing flag, read from dubizzle's real
--   `[data-testid="offplan-badge"]` card element (presence = off-plan, absence = ready/resale).
-- - property_listings.listed_date — detail-page-only (same scope as phone_number/age_years/
--   average_rent), dubizzle's own `[data-testid="posted-on"]` field, stored as the raw text
--   (e.g. "4th June 2026") rather than a fragile string->date parse.

-- Up Migration

ALTER TABLE property_jobs ADD COLUMN property_status TEXT NOT NULL DEFAULT 'ready'
  CHECK (property_status IN ('ready', 'offplan', 'any'));

ALTER TABLE property_listings ADD COLUMN is_offplan BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE property_listings ADD COLUMN listed_date TEXT;

-- Down Migration

ALTER TABLE property_listings DROP COLUMN IF EXISTS listed_date;
ALTER TABLE property_listings DROP COLUMN IF EXISTS is_offplan;
ALTER TABLE property_jobs DROP COLUMN IF EXISTS property_status;
