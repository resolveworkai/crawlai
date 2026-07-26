-- Authored by: Mohit Singh
--
-- Live activity log for Crawl (OCR) jobs — mirrors crawl_logs' shape exactly (same log_level
-- enum), so the Node API's global /logs/stream SSE can merge both sources into one dashboard
-- panel with a `source` discriminator, rather than the OCR module being invisible there.

-- Up Migration

CREATE TABLE ocr_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES ocr_jobs(id) ON DELETE CASCADE,
  level log_level NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ocr_logs_job_ts ON ocr_logs(job_id, ts DESC);
-- Backs the global recent-activity SSE stream (GET /logs/stream) across all jobs.
CREATE INDEX idx_ocr_logs_ts ON ocr_logs(ts DESC);

-- Down Migration

DROP TABLE IF EXISTS ocr_logs;
