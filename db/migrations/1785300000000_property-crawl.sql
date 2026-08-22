-- Authored by: Mohit Singh
--
-- Property Research module — a THIRD parallel job type alongside the main Overpass crawler and
-- Crawl (OCR), and deliberately SEPARATE from the e-commerce Product Research module (own tables,
-- own worker package `property/`, own API routes, own frontend route — same hard-separation
-- convention as ecom_jobs/ecom_products vs ocr_jobs/ocr_businesses).
--
-- Given a platform (dubizzle | propertyfinder), a location, and optional bedrooms/bathrooms/
-- property-type filters, walks the search-results pages, captures each listing card (price, area,
-- beds/baths, community, "listed N days ago", badges), then for the top-N ranked listings (by
-- distress_score, computed after all cards are captured) visits the detail page to reveal the
-- phone number and build a wa.me WhatsApp link with a custom message.
--
-- Both dubizzle.com and propertyfinder.ae block plain headless Chromium (confirmed 2026-08-22:
-- dubizzle returns an empty-body 200, propertyfinder returns a bare 403) while loading fine
-- through the operator's real Chrome via CDP — same REQUIRES_CDP pattern as noon.com/AliExpress in
-- the ecom module (see backend/worker/run_property_host.py). Since EVERY platform this module
-- supports needs CDP, the single-running lock is a plain global lock (not per-group like ecom's) —
-- there is only one runner (the host runner) for this whole module, never a container daemon claim.

-- Up Migration

CREATE TABLE property_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  platform TEXT NOT NULL CHECK (platform IN ('dubizzle', 'propertyfinder')),
  location TEXT NOT NULL,
  -- NULL = any. 0 = studio. A dedicated 'studio' property_type value also exists for platforms
  -- that filter by unit-type rather than bedroom count — adapters map whichever the site needs.
  bedrooms INTEGER CHECK (bedrooms IS NULL OR bedrooms BETWEEN 0 AND 10),
  bathrooms INTEGER CHECK (bathrooms IS NULL OR bathrooms BETWEEN 0 AND 10),
  property_type TEXT NOT NULL DEFAULT 'apartment'
    CHECK (property_type IN ('apartment', 'villa', 'townhouse', 'penthouse', 'studio')),
  purpose TEXT NOT NULL DEFAULT 'buy' CHECK (purpose IN ('buy', 'rent')),
  max_pages INTEGER NOT NULL DEFAULT 3 CHECK (max_pages BETWEEN 1 AND 20),
  max_listings INTEGER NOT NULL DEFAULT 100 CHECK (max_listings > 0),
  -- How many of the top-ranked (by distress_score) listings get a detail-page visit to reveal a
  -- phone number + build a WhatsApp link. Bounded the same way ecom_jobs.detail_scrape_top_n is.
  detail_scrape_top_n INTEGER NOT NULL DEFAULT 10 CHECK (detail_scrape_top_n BETWEEN 0 AND 20),
  -- NULL => service default template (see property/whatsapp.py). May reference {title}/{price}/
  -- {url}/{community} placeholders, filled in per-listing at generation time.
  whatsapp_message_template TEXT,
  -- NULL => worker defaults (property/analysis.py DEFAULT_WEIGHTS).
  score_weights JSONB,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'capturing', 'parsing', 'detail', 'scoring', 'ready', 'failed', 'blocked')),
  end_reason TEXT
    CHECK (end_reason IN ('end_of_results', 'max_pages', 'max_listings', 'stagnation', 'blocked', 'error')),
  total_count INTEGER NOT NULL DEFAULT 0,
  captured_count INTEGER NOT NULL DEFAULT 0,
  detail_done_count INTEGER NOT NULL DEFAULT 0,
  current_listing TEXT,
  error_message TEXT,
  storage_dir TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);

CREATE INDEX idx_property_jobs_created_at ON property_jobs(created_at DESC);
CREATE UNIQUE INDEX ux_property_jobs_single_running
  ON property_jobs((TRUE))
  WHERE status IN ('capturing', 'parsing', 'detail', 'scoring');

CREATE TABLE property_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES property_jobs(id) ON DELETE CASCADE,
  -- overall rank position across pages (1-based), authoritative capture order
  idx INTEGER NOT NULL,
  page_num INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL,
  listing_url TEXT,
  -- The SITE's own photo URLs — links only, never downloaded/proxied. Distinct from
  -- source_images below (our own screenshot audit trail on disk).
  image_urls JSONB NOT NULL DEFAULT '[]'::jsonb,
  price NUMERIC(14, 2),
  currency TEXT DEFAULT 'AED',
  area_sqft NUMERIC(10, 2),
  -- Computed in the scoring pass (price / area_sqft), not at capture time — needs both fields
  -- present, and normalizing it there keeps the value/keyword/freshness scoring pass in one place.
  price_per_sqft NUMERIC(10, 2),
  bedrooms INTEGER,
  bathrooms INTEGER,
  property_type TEXT,
  location_text TEXT,
  community TEXT,
  listed_days_ago INTEGER,
  verified BOOLEAN NOT NULL DEFAULT FALSE,
  badges JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Distress-sale language detected in the title/description ("motivated seller", "urgent",
  -- "below market", "reduced", "quick sale", ...) — see property/analysis.py DISTRESS_KEYWORDS.
  distress_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  agent_name TEXT,
  -- Only populated for the detail_scrape_top_n listings that got a detail-page visit.
  phone_number TEXT,
  whatsapp_link TEXT,
  description TEXT,
  distress_score REAL,
  extraction_source TEXT NOT NULL DEFAULT 'dom' CHECK (extraction_source IN ('dom', 'dom+ocr', 'ocr')),
  ocr_confidence REAL,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  raw_text TEXT,
  source_images JSONB NOT NULL DEFAULT '[]'::jsonb,
  detail_scraped BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, idx)
);

CREATE INDEX idx_property_listings_job ON property_listings(job_id);
CREATE INDEX idx_property_listings_job_score ON property_listings(job_id, distress_score DESC NULLS LAST);
CREATE INDEX idx_property_listings_needs_review ON property_listings(job_id) WHERE needs_review;

CREATE TABLE property_logs (
  id BIGSERIAL PRIMARY KEY,
  job_id UUID NOT NULL REFERENCES property_jobs(id) ON DELETE CASCADE,
  level log_level NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_property_logs_job_ts ON property_logs(job_id, ts DESC);
CREATE INDEX idx_property_logs_ts ON property_logs(ts DESC);

-- Down Migration

DROP TABLE IF EXISTS property_logs;
DROP TABLE IF EXISTS property_listings;
DROP TABLE IF EXISTS property_jobs;
