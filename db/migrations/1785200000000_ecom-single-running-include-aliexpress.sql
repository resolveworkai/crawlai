-- Authored by: Mohit Singh
--
-- Fix: 1785100000000 re-keyed ux_ecom_jobs_single_running to bucket the CDP-runner group by
-- `platform = ANY(ARRAY['noon'])` — written when noon was the ONLY CDP platform. AliExpress was
-- added afterward with REQUIRES_CDP = True (runs on the same host runner as noon), but its rows
-- still fell into the OTHER bucket (the `false` partition, shared with amazon/container jobs).
--
-- Confirmed real bug, 2026-08-07: with an amazon job running in the container, a queued
-- aliexpress job on the host runner could never claim — it collided with amazon's slot in the
-- `false` partition instead of noon's slot in the `true` partition, even though aliexpress and
-- amazon run on entirely different machines/browsers and should never contend for the same lock.
--
-- Fix: bucket by the FULL cdp_required_platforms() set. Keep this array in sync with
-- ecom/adapters/*.py's REQUIRES_CDP flags (the Python source of truth) — any new CDP platform
-- needs both updated together.

-- Up Migration

DROP INDEX IF EXISTS ux_ecom_jobs_single_running;
CREATE UNIQUE INDEX ux_ecom_jobs_single_running
  ON ecom_jobs ((platform = ANY (ARRAY['noon', 'aliexpress'])))
  WHERE status IN ('capturing', 'ocr', 'parsing', 'detail');

-- Down Migration

DROP INDEX IF EXISTS ux_ecom_jobs_single_running;
CREATE UNIQUE INDEX ux_ecom_jobs_single_running
  ON ecom_jobs ((platform = ANY (ARRAY['noon'])))
  WHERE status IN ('capturing', 'ocr', 'parsing', 'detail');
