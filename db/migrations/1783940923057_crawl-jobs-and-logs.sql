-- Authored by: Mohit Singh
--
-- Ported from the Lovable schema's crawl_jobs/crawl_logs. `pause_requested` is new (design-spec
-- alignment finding #2 — the Jobs screen supports pause/resume, not just cancel). `created_by`
-- replaces `user_id` (renamed for clarity: it's audit provenance, not a visibility scope — see
-- users_and_roles migration).

-- Up Migration

CREATE TABLE crawl_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_type TEXT NOT NULL,
  location_label TEXT,
  center_lat DOUBLE PRECISION NOT NULL,
  center_lng DOUBLE PRECISION NOT NULL,
  radius_km NUMERIC(6, 2) NOT NULL,
  status job_status NOT NULL DEFAULT 'pending',
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  pause_requested BOOLEAN NOT NULL DEFAULT false,
  found_count INTEGER NOT NULL DEFAULT 0,
  crawled_count INTEGER NOT NULL DEFAULT 0,
  website_crawled_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  current_business TEXT,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_crawl_jobs_updated
  BEFORE UPDATE ON crawl_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_crawl_jobs_created_at ON crawl_jobs(created_at DESC);
CREATE INDEX idx_crawl_jobs_status ON crawl_jobs(status);

-- Atomic claim pattern (backend/worker's P1 daemon):
--   UPDATE crawl_jobs SET status='discovering' WHERE id=$1 AND status='pending' RETURNING *;
-- and the startup/periodic pending-sweep both rely on this index.
CREATE INDEX idx_crawl_jobs_pending ON crawl_jobs(created_at) WHERE status = 'pending';

CREATE TABLE crawl_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES crawl_jobs(id) ON DELETE CASCADE,
  level log_level NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_crawl_logs_job_ts ON crawl_logs(job_id, ts DESC);
-- Backs the global recent-activity SSE stream (GET /logs/stream) across all jobs.
CREATE INDEX idx_crawl_logs_ts ON crawl_logs(ts DESC);

-- Down Migration

DROP TABLE IF EXISTS crawl_logs;
DROP TABLE IF EXISTS crawl_jobs;
