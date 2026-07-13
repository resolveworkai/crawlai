-- Authored by: Mohit Singh
--
-- The master database. Ported from the Lovable schema's `businesses` table with the changes
-- decided in md/plans/0001-business-scout-ai-crawler.md:
--   - GLOBAL, not per-user: dedupe keys carry no user_id. `created_by` is audit-only.
--   - `osm_type` (new) + `osm_id` are the PRIMARY dedupe key (OSM's element id is stable);
--     `lower(email)` is the SECONDARY override key. Both unique indexes are global.
--   - `enrichment_status` (new) drives the Businesses screen's per-row status badge.
--   - `google_enriched_at` (new) backs the manual, on-demand "Fetch rating" button (Phase 6) —
--     `google_rating`/`review_count`/`review_url` already existed in the Lovable schema and are
--     reused for reqs 5/6, populated ONLY by that manual endpoint, never by the automated crawl.
-- Only the columns backing the 10 requirements are actively populated by the pipeline; the
-- remaining technical/ai/people columns (inherited from the Lovable design) stay nullable —
-- see .claude/skills/skills_db.md "Column discipline".

-- Up Migration

CREATE TABLE businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  crawl_job_id UUID REFERENCES crawl_jobs(id) ON DELETE SET NULL,

  -- identity (req 1)
  name TEXT NOT NULL,
  sub_name TEXT,
  category TEXT,
  tags TEXT[],
  description TEXT,

  -- map / dedupe (req 2, req 7)
  google_map_name TEXT,
  google_map_url TEXT,
  osm_type TEXT,
  osm_id TEXT,
  latitude DOUBLE PRECISION,
  longitude DOUBLE PRECISION,

  -- web
  website_url TEXT,
  website_title TEXT,
  meta_description TEXT,
  meta_keywords TEXT,
  about_text TEXT,
  contact_url TEXT,

  -- contact (req 3, req 4)
  email TEXT,
  emails TEXT[],
  phone TEXT,
  phones TEXT[],
  whatsapp TEXT,

  -- socials
  facebook TEXT,
  instagram TEXT,
  linkedin TEXT,
  youtube TEXT,
  twitter TEXT,

  -- address (req 2)
  address_line1 TEXT,
  address_line2 TEXT,
  area TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  postal_code TEXT,

  -- google business profile (req 5, req 6 — manual button only, Phase 6)
  google_rating NUMERIC(3, 2),
  review_count INTEGER,
  review_url TEXT,
  business_status TEXT,
  opening_date DATE,
  claimed BOOLEAN,
  price_level TEXT,
  google_enriched_at TIMESTAMPTZ,

  -- hours (req 10 — JSONB keyed by weekday)
  opening_hours JSONB,

  -- images (req 9 — website images auto; Google photos via the manual button land in
  -- business_images / dedicated columns, see below)
  logo_url TEXT,
  cover_image_url TEXT,
  hero_image_url TEXT,

  -- ai / enrichment extras (Phase 5, optional — not populated when AI extraction is off)
  ai_summary TEXT,
  services TEXT[],
  products TEXT[],
  amenities TEXT[],
  keywords TEXT[],
  languages TEXT[],
  target_audience TEXT,
  industry TEXT,

  -- people / technical (inherited from the Lovable design; not backed by a current requirement)
  owner_name TEXT,
  manager_name TEXT,
  reception_number TEXT,
  support_email TEXT,
  sales_email TEXT,
  general_email TEXT,
  ssl_enabled BOOLEAN,
  cms TEXT,
  hosting_provider TEXT,
  google_analytics BOOLEAN,
  facebook_pixel BOOLEAN,

  -- enrichment pipeline status — drives the Businesses screen's per-row badge
  enrichment_status TEXT NOT NULL DEFAULT 'queued'
    CHECK (enrichment_status IN ('queued', 'crawling', 'enriched', 'failed')),

  -- user-defined dynamic fields (Fields screen — Phase 5)
  extras JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_businesses_updated
  BEFORE UPDATE ON businesses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Primary dedupe key: OSM's own element id (always present when discovered via Overpass).
CREATE UNIQUE INDEX ux_businesses_osm ON businesses(osm_type, osm_id) WHERE osm_id IS NOT NULL;

-- Secondary override key: a business found again by matching email merges into the existing
-- row even if osm_id/osm_type differ (see .claude/skills/skills_db.md "Dedupe").
CREATE UNIQUE INDEX ux_businesses_email ON businesses(lower(email)) WHERE email IS NOT NULL;

CREATE INDEX idx_businesses_name_trgm ON businesses USING gin (name gin_trgm_ops);
CREATE INDEX idx_businesses_city ON businesses(city);
CREATE INDEX idx_businesses_crawl_job ON businesses(crawl_job_id);
CREATE INDEX idx_businesses_category ON businesses(category);
CREATE INDEX idx_businesses_enrichment_status ON businesses(enrichment_status);

CREATE TABLE business_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_business_images_business ON business_images(business_id);

-- Down Migration

DROP TABLE IF EXISTS business_images;
DROP TABLE IF EXISTS businesses;
