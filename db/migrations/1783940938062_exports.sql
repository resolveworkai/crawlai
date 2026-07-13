-- Authored by: Mohit Singh
--
-- New table, not in the original Lovable schema — the Exports screen shows a persisted
-- "Recent exports" history (filename/size/row-count/re-download) with a retention window,
-- not just on-demand streaming. See md/plans/0001-*.md "Design-spec alignment" finding #4.

-- Up Migration

CREATE TABLE exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  format TEXT NOT NULL CHECK (format IN ('xlsx', 'csv', 'json')),
  filename TEXT NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  filter_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  storage_path TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ
);

CREATE INDEX idx_exports_created_at ON exports(created_at DESC);
-- Backs the Phase 7 retention-cleanup job (delete rows + files past their expiry).
CREATE INDEX idx_exports_expires_at ON exports(expires_at) WHERE expires_at IS NOT NULL;

-- Down Migration

DROP TABLE IF EXISTS exports;
