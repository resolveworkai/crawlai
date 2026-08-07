-- Authored by: Mohit Singh
--
-- "Product Research (OCR)" module — e-commerce search-results capture (noon.com, amazon.ae;
-- AliExpress reserved for later) -> DOM-first extraction with Tesseract OCR fallback -> parsed
-- product fields -> opportunity scoring. Deliberately SEPARATE from the "Crawl (OCR)" Google Maps
-- module: own tables (ecom_jobs/ecom_products/ecom_logs), own pg_notify channel
-- ('ecom_crawl_jobs'), own worker package (business_scout_worker/ecom/), own API routes
-- (/ecom-crawl/*) and own storage dir (storage/ecom_captures). Only site-agnostic worker
-- utilities (ocr_engine, preprocess, humanize, settings, db pool) are shared; nothing in the
-- ocr/ package or the ocr_* tables is touched by this module.
--
-- Single-flight policy mirrors the CURRENT ocr_jobs policy (post 1784500000000): unlimited rows
-- may sit 'queued', but at most one job may be actively running a browser session
-- (capturing/ocr/parsing/detail) at a time. The worker daemon is sequential across job types
-- too (one main.py, one browser session total, ecom and ocr claims interleave), so this index
-- only needs to prevent two *ecom* jobs racing each other.

-- Up Migration

CREATE TABLE ecom_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('noon', 'amazon', 'aliexpress')),
  query TEXT NOT NULL,
  sort_mode TEXT NOT NULL DEFAULT 'rating_desc'
    CHECK (sort_mode IN ('rating_desc', 'price_asc', 'price_desc', 'relevance')),
  max_pages INTEGER NOT NULL DEFAULT 3 CHECK (max_pages BETWEEN 1 AND 10),
  max_products INTEGER NOT NULL DEFAULT 90 CHECK (max_products > 0),
  -- Phase 2b: optional detail-page deep scrape (usage/description, breadcrumb category, seller).
  -- 0 = disabled (default) — no extra per-product navigation, lowest bot-detection surface.
  detail_scrape_top_n INTEGER NOT NULL DEFAULT 0 CHECK (detail_scrape_top_n BETWEEN 0 AND 10),
  -- null => worker applies its own defaults (see ecom/analysis.py DEFAULT_WEIGHTS)
  score_weights JSONB,
  -- queued -> capturing -> ocr -> parsing -> [detail ->] ready ; terminal failures: failed | blocked
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'capturing', 'ocr', 'parsing', 'detail', 'ready', 'failed', 'blocked')),
  end_reason TEXT
    CHECK (end_reason IN ('end_of_results', 'max_pages', 'max_products', 'stagnation', 'blocked', 'error')),
  total_count INTEGER NOT NULL DEFAULT 0,
  captured_count INTEGER NOT NULL DEFAULT 0,
  ocr_done_count INTEGER NOT NULL DEFAULT 0,
  detail_done_count INTEGER NOT NULL DEFAULT 0,
  current_product TEXT,
  error_message TEXT,
  storage_dir TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX idx_ecom_jobs_created_at ON ecom_jobs(created_at DESC);
CREATE UNIQUE INDEX ux_ecom_jobs_single_running
  ON ecom_jobs((TRUE))
  WHERE status IN ('capturing', 'ocr', 'parsing', 'detail');

CREATE TABLE ecom_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES ecom_jobs(id) ON DELETE CASCADE,
  -- overall rank position across pages/scroll-rounds (1-based), authoritative sort order
  idx INTEGER NOT NULL,
  page_num INTEGER NOT NULL DEFAULT 1,
  -- title + product_url + image_url come from the DOM anchor/img at capture time (authoritative).
  title TEXT NOT NULL,
  product_url TEXT,
  image_url TEXT,
  -- everything below is DOM-extracted with OCR fallback for whatever DOM missed.
  price NUMERIC(12, 2),
  list_price NUMERIC(12, 2),
  currency TEXT NOT NULL DEFAULT 'AED',
  discount_pct REAL,
  rating REAL CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
  review_count INTEGER,
  bought_past_month INTEGER,
  bought_past_month_raw TEXT,
  free_delivery BOOLEAN NOT NULL DEFAULT FALSE,
  delivery_date TEXT,
  category TEXT,
  badges JSONB NOT NULL DEFAULT '[]'::jsonb,
  rank_in_category INTEGER,
  sponsored BOOLEAN NOT NULL DEFAULT FALSE,
  opportunity_score REAL,
  extraction_source TEXT NOT NULL DEFAULT 'dom'
    CHECK (extraction_source IN ('dom', 'dom+ocr', 'ocr')),
  ocr_confidence REAL,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  raw_text TEXT,
  source_images JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Phase 2b detail-page fields (populated only when the job's detail_scrape_top_n > 0 and this
  -- product was in the top-N; NULL/false otherwise, never fabricated).
  description TEXT,
  about_bullets JSONB NOT NULL DEFAULT '[]'::jsonb,
  breadcrumb_category TEXT,
  seller_name TEXT,
  detail_scraped BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, idx)
);

CREATE INDEX idx_ecom_products_job ON ecom_products(job_id);
CREATE INDEX idx_ecom_products_job_score ON ecom_products(job_id, opportunity_score DESC NULLS LAST);
CREATE INDEX idx_ecom_products_needs_review ON ecom_products(job_id) WHERE needs_review;

CREATE TABLE ecom_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES ecom_jobs(id) ON DELETE CASCADE,
  level log_level NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ecom_logs_job_ts ON ecom_logs(job_id, ts DESC);
CREATE INDEX idx_ecom_logs_ts ON ecom_logs(ts DESC);

-- Down Migration

DROP TABLE IF EXISTS ecom_logs;
DROP TABLE IF EXISTS ecom_products;
DROP TABLE IF EXISTS ecom_jobs;
