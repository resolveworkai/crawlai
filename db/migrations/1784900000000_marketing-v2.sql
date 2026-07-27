-- Authored by: Mohit Singh
--
-- Marketing tool v2: reusable manual contacts, business-type-aware templates, and non-inline email
-- attachments. See md/MARKETING.md.

-- Up Migration

-- A lightweight, reusable address book for manually-added businesses — deliberately separate from
-- the crawler's `businesses`/`ocr_businesses` tables (different lifecycle: hand-entered, not
-- crawled/OCR'd). Phone/email are normalized the same way as recipientParse.ts on write.
CREATE TABLE marketing_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name TEXT NOT NULL,
  business_type TEXT,
  location TEXT,
  phone TEXT,
  email TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_marketing_contacts_created_at ON marketing_contacts(created_at DESC);

-- Curated templates can be scoped to a business type (gym/library/coaching) so the composer can
-- recommend the most relevant one first; NULL = generic, shown for every business type.
ALTER TABLE message_templates ADD COLUMN business_type TEXT;

-- Inline (cid) vs. a plain attachment (e.g. a PDF brochure) — same underlying bytes storage, just a
-- different Content-Disposition at send time. Existing rows are all inline (that's all v1 supported).
ALTER TABLE message_template_images ADD COLUMN is_inline BOOLEAN NOT NULL DEFAULT TRUE;

-- Down Migration

ALTER TABLE message_template_images DROP COLUMN IF EXISTS is_inline;
ALTER TABLE message_templates DROP COLUMN IF EXISTS business_type;
DROP TABLE IF EXISTS marketing_contacts;
