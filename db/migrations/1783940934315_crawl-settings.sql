-- Authored by: Mohit Singh
--
-- GLOBAL SINGLETON (deviates from the Lovable schema's per-user PRIMARY KEY user_id):
-- concurrency/retry/timeout/etc. govern the ONE shared worker daemon, not a per-operator
-- preference — there's exactly one crawler process for the whole workspace. The classic
-- Postgres singleton-table pattern (`id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1)`)
-- guarantees at most one row can ever exist. Same "global, not per-user" reasoning as
-- dynamic_fields — see that migration's comment.

-- Up Migration

CREATE TABLE crawl_settings (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  concurrency INTEGER NOT NULL DEFAULT 3,
  retry_count INTEGER NOT NULL DEFAULT 2,
  timeout_ms INTEGER NOT NULL DEFAULT 15000,
  user_agent TEXT NOT NULL DEFAULT 'BusinessScoutAI/1.0',
  map_provider TEXT NOT NULL DEFAULT 'osm',
  discovery_source TEXT NOT NULL DEFAULT 'osm',
  max_businesses_per_job INTEGER NOT NULL DEFAULT 200,
  crawl_website BOOLEAN NOT NULL DEFAULT true,
  respect_robots_txt BOOLEAN NOT NULL DEFAULT true,
  follow_sitemaps BOOLEAN NOT NULL DEFAULT true,
  request_delay_ms INTEGER NOT NULL DEFAULT 450,
  -- Kept optional and off by default, per the plan's cost model — the pipeline runs fully
  -- without AI extraction; enabling it is an explicit choice, not a default-on assumption.
  use_ai_extraction BOOLEAN NOT NULL DEFAULT false,
  proxy_url TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_crawl_settings_updated
  BEFORE UPDATE ON crawl_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed the single row now so the app never has to special-case "no settings row exists yet".
INSERT INTO crawl_settings (id) VALUES (1);

-- Down Migration

DROP TABLE IF EXISTS crawl_settings;
