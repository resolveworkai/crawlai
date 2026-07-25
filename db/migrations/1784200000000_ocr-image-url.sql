-- Authored by: Mohit Singh
--
-- Adds the business's hero photo URL, read straight from the Maps DOM at capture time
-- (authoritative, same as phone/website/address) alongside the existing OCR-derived fields.

-- Up Migration

ALTER TABLE ocr_businesses ADD COLUMN image_url TEXT;

-- Down Migration

ALTER TABLE ocr_businesses DROP COLUMN IF EXISTS image_url;
