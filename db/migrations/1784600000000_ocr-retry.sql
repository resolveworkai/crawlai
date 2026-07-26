-- Authored by: Mohit Singh
--
-- Resumable retry for failed/blocked OCR jobs: retry_count tracks how many times a job has been
-- resumed (capped at 3 by the API — see routes/ocrCrawl.ts), and the worker resumes from its own
-- on-disk manifest.json rather than starting over, so already-captured businesses are never
-- re-walked or lost.

-- Up Migration

ALTER TABLE ocr_jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0);

-- Down Migration

ALTER TABLE ocr_jobs DROP COLUMN IF EXISTS retry_count;
