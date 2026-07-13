-- Authored by: Mohit Singh
--
-- GLOBAL, not per-user (deviates from the Lovable schema's per-user UNIQUE(user_id, key)):
-- there is one shared worker daemon processing one shared job queue against one shared master
-- DB, so an enabled dynamic field applies platform-wide to every crawl, not per-operator. See
-- md/plans/0001-business-scout-ai-crawler.md's "Master DB is GLOBAL" decision, extended here
-- to system-wide config for the same reason. `created_by` is audit-only, like on businesses.

-- Up Migration

CREATE TABLE dynamic_fields (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text'
    CHECK (field_type IN ('text', 'number', 'boolean', 'list', 'url')),
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_dynamic_fields_updated
  BEFORE UPDATE ON dynamic_fields
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_dynamic_fields_enabled ON dynamic_fields(enabled) WHERE enabled = true;

-- Down Migration

DROP TABLE IF EXISTS dynamic_fields;
