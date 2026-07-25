-- Authored by: Mohit Singh
--
-- Adds live "what is it working on right now" visibility to Crawl-OCR jobs. Without this the
-- progress bar could only show counts (and a stalled count looked identical to a stalled job);
-- the business name updates on every item so the status bar proves the capture is still moving.
-- Mirrors crawl_jobs.current_business, which the main crawler already has for the same reason.

-- Up Migration

ALTER TABLE ocr_jobs ADD COLUMN current_business TEXT;

-- Down Migration

ALTER TABLE ocr_jobs DROP COLUMN IF EXISTS current_business;
