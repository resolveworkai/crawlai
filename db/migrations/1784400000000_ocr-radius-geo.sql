-- Authored by: Mohit Singh
--
-- Radius-bounded OCR search: the job optionally carries a center point + a real km radius,
-- enforced by the worker via haversine distance on each business's OWN lat/lng (parsed exactly
-- from its Maps place URL, not estimated) — a hard filter, not just a Maps-viewport bias.

-- Up Migration

ALTER TABLE ocr_jobs ADD COLUMN center_lat DOUBLE PRECISION;
ALTER TABLE ocr_jobs ADD COLUMN center_lng DOUBLE PRECISION;
ALTER TABLE ocr_jobs ADD COLUMN radius_km REAL CHECK (radius_km IS NULL OR radius_km > 0);

ALTER TABLE ocr_businesses ADD COLUMN lat DOUBLE PRECISION;
ALTER TABLE ocr_businesses ADD COLUMN lng DOUBLE PRECISION;
ALTER TABLE ocr_businesses ADD COLUMN distance_km REAL;

-- Down Migration

ALTER TABLE ocr_businesses DROP COLUMN IF EXISTS distance_km;
ALTER TABLE ocr_businesses DROP COLUMN IF EXISTS lng;
ALTER TABLE ocr_businesses DROP COLUMN IF EXISTS lat;

ALTER TABLE ocr_jobs DROP COLUMN IF EXISTS radius_km;
ALTER TABLE ocr_jobs DROP COLUMN IF EXISTS center_lng;
ALTER TABLE ocr_jobs DROP COLUMN IF EXISTS center_lat;
