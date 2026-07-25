-- Authored by: Mohit Singh
--
-- Relaxes the OCR single-flight lock: previously AT MOST ONE job could exist in
-- {queued, capturing, ocr, parsing} at a time, which made submitting a second job a hard 409 —
-- you had to wait and manually resubmit. Now multiple jobs may sit 'queued' simultaneously; only
-- ACTIVE work (capturing/ocr/parsing — i.e. an actual Chromium session against Maps) is still
-- capped at one at a time, so there is still never more than one concurrent automated Maps
-- session (no added ToS/detection risk). claim_pending_ocr_job() already claims 'queued' rows
-- oldest-first (FOR UPDATE SKIP LOCKED), so queued jobs auto-run in submission order with zero
-- worker changes needed.

-- Up Migration

DROP INDEX IF EXISTS ux_ocr_jobs_single_active;

CREATE UNIQUE INDEX ux_ocr_jobs_single_running
  ON ocr_jobs((TRUE))
  WHERE status IN ('capturing', 'ocr', 'parsing');

-- Down Migration

DROP INDEX IF EXISTS ux_ocr_jobs_single_running;

CREATE UNIQUE INDEX ux_ocr_jobs_single_active
  ON ocr_jobs((TRUE))
  WHERE status IN ('queued', 'capturing', 'ocr', 'parsing');
