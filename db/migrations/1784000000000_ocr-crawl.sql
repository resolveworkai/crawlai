-- Authored by: Mohit Singh
--
-- "Crawl (OCR)" module — Google Maps screenshot capture → Tesseract OCR → parsed fields.
-- Parallel job type to crawl_jobs, driven through the same DB-as-queue seam (Node inserts +
-- pg_notify('ocr_crawl_jobs'), the Python worker LISTENs/claims). See the module README and
-- .claude/skills/skills_backend_python.md. Images live on disk (storage/ocr_captures) and are
-- purged after a retention window; these DB rows persist so old jobs stay viewable/exportable.

-- Up Migration

CREATE TABLE ocr_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  query TEXT NOT NULL,
  location TEXT NOT NULL,
  max_results INTEGER NOT NULL DEFAULT 25,
  expand_hours BOOLEAN NOT NULL DEFAULT FALSE,
  langs TEXT NOT NULL DEFAULT 'eng',
  -- queued -> capturing -> ocr -> parsing -> ready ; terminal failures: failed | blocked
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'capturing', 'ocr', 'parsing', 'ready', 'failed', 'blocked')),
  end_reason TEXT
    CHECK (end_reason IN ('end_of_list', 'max_results', 'stagnation', 'blocked', 'error')),
  total_count INTEGER NOT NULL DEFAULT 0,
  captured_count INTEGER NOT NULL DEFAULT 0,
  ocr_done_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  storage_dir TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX idx_ocr_jobs_created_at ON ocr_jobs(created_at DESC);
-- Single-flight lock (§6): at most one job may be in a non-terminal state at a time. A partial
-- unique index on a constant expression enforces this at the DB level — a second concurrent
-- insert of an active job violates it, so the API's 409 check can't be raced past.
CREATE UNIQUE INDEX ux_ocr_jobs_single_active
  ON ocr_jobs((TRUE))
  WHERE status IN ('queued', 'capturing', 'ocr', 'parsing');

CREATE TABLE ocr_businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES ocr_jobs(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  -- name + maps_url come from the DOM aria-label/href at capture time (authoritative), not OCR.
  name TEXT NOT NULL,
  maps_url TEXT,
  -- everything below is OCR-derived (best-effort; see needs_review).
  rating REAL,
  review_count INTEGER,
  category TEXT,
  address TEXT,
  phone TEXT,
  website TEXT,
  plus_code TEXT,
  hours_summary TEXT,
  hours_weekly JSONB,
  email TEXT,
  ocr_confidence REAL,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  raw_text TEXT,
  source_images JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, idx)
);

CREATE INDEX idx_ocr_businesses_job ON ocr_businesses(job_id);
CREATE INDEX idx_ocr_businesses_needs_review ON ocr_businesses(job_id) WHERE needs_review;

-- Down Migration

DROP TABLE IF EXISTS ocr_businesses;
DROP TABLE IF EXISTS ocr_jobs;
