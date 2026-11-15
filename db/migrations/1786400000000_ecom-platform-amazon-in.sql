-- Authored by: Mohit Singh
--
-- Adds `amazon_in` (amazon.in) as a fourth Product Research platform alongside noon, amazon
-- (amazon.ae — its key is unchanged so every existing row stays valid), and aliexpress.
--
-- Only the CHECK constraint changes here. (amazon_in was first assumed to be a headless container
-- platform and the single-running index was left alone; it then turned out amazon.in 503s the
-- headless browser and was made REQUIRES_CDP — that index is re-keyed in 1786500000000.)

-- Up Migration

ALTER TABLE ecom_jobs DROP CONSTRAINT IF EXISTS ecom_jobs_platform_check;
ALTER TABLE ecom_jobs
  ADD CONSTRAINT ecom_jobs_platform_check
  CHECK (platform IN ('noon', 'amazon', 'amazon_in', 'aliexpress'));

-- Down Migration

DELETE FROM ecom_jobs WHERE platform = 'amazon_in';
ALTER TABLE ecom_jobs DROP CONSTRAINT IF EXISTS ecom_jobs_platform_check;
ALTER TABLE ecom_jobs
  ADD CONSTRAINT ecom_jobs_platform_check
  CHECK (platform IN ('noon', 'amazon', 'aliexpress'));
