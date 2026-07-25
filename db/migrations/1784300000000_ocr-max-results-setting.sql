-- Authored by: Mohit Singh
--
-- Raises the OCR job's hard result cap from 200 to a DB-configurable value (default 1000, the
-- max allowed), living on the same crawl_settings singleton the main crawler's Settings screen
-- already edits (concurrency, max_businesses_per_job, ...). ocrCrawl.ts's job-creation route
-- enforces this at request time via getCrawlSettings() — the per-request zod schema only bounds
-- the type/shape (positive int, ceiling 1000), not the operator-configured limit. Default is the
-- ceiling itself (not a conservative starting value) so raising the old 200 cap doesn't require a
-- separate Settings visit first; an operator can still lower it via Settings if desired.

-- Up Migration

ALTER TABLE crawl_settings
  ADD COLUMN ocr_max_results INTEGER NOT NULL DEFAULT 1000
    CHECK (ocr_max_results BETWEEN 1 AND 1000);

-- Down Migration

ALTER TABLE crawl_settings DROP COLUMN IF EXISTS ocr_max_results;
