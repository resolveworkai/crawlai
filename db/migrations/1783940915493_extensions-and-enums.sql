-- Authored by: Mohit Singh
--
-- Ported from the Lovable/Supabase scaffold (supabase/migrations/) — schema is now owned
-- entirely here (backend/api via node-pg-migrate), never by Supabase/RLS. See
-- md/plans/0001-business-scout-ai-crawler.md and .claude/skills/skills_db.md.

-- Up Migration

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TYPE app_role AS ENUM ('admin', 'operator', 'viewer');

-- 'paused' added vs. the original Lovable enum — the design's Jobs screen has Play/Pause,
-- not just cancel (see md/plans/0001-*.md "Design-spec alignment" finding #2).
CREATE TYPE job_status AS ENUM (
  'pending', 'discovering', 'crawling', 'paused', 'completed', 'failed', 'cancelled'
);

CREATE TYPE log_level AS ENUM ('info', 'warn', 'error', 'debug');

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- Down Migration

DROP FUNCTION IF EXISTS set_updated_at();
DROP TYPE IF EXISTS log_level;
DROP TYPE IF EXISTS job_status;
DROP TYPE IF EXISTS app_role;
DROP EXTENSION IF EXISTS pg_trgm;
