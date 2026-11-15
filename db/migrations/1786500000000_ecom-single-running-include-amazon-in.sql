-- Authored by: Mohit Singh
--
-- amazon_in (amazon.in) became a REQUIRES_CDP platform: the headless container browser got HTTP 503
-- from amazon.in on every attempt, so it now runs on the host runner over the operator's real
-- Chrome, same as noon/aliexpress. ux_ecom_jobs_single_running buckets jobs by "is this a CDP
-- platform?" (see 1785200000000) and its array MUST match ecom/adapters/*.py's REQUIRES_CDP flags
-- (cdp_required_platforms() is the Python source of truth) — otherwise an amazon_in job would be
-- bucketed with the container's amazon.ae jobs, and a running amazon.ae job would block the host
-- runner from claiming amazon_in (the claim would hit this index and silently back off).
--
-- Effect: amazon_in now shares the CDP slot with noon/aliexpress (one CDP-group job at a time, all
-- claimed by the single host runner anyway) and runs concurrently with amazon.ae in the container.

-- Up Migration

DROP INDEX IF EXISTS ux_ecom_jobs_single_running;
CREATE UNIQUE INDEX ux_ecom_jobs_single_running
  ON ecom_jobs ((platform = ANY (ARRAY['noon', 'aliexpress', 'amazon_in'])))
  WHERE status IN ('capturing', 'ocr', 'parsing', 'detail');

-- Down Migration

DROP INDEX IF EXISTS ux_ecom_jobs_single_running;
CREATE UNIQUE INDEX ux_ecom_jobs_single_running
  ON ecom_jobs ((platform = ANY (ARRAY['noon', 'aliexpress'])))
  WHERE status IN ('capturing', 'ocr', 'parsing', 'detail');
