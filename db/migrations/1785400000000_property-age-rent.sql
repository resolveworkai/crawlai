-- Authored by: Mohit Singh
--
-- Two new detail-page-only fields, confirmed live 2026-08-22 via real dubizzle DOM inspection:
-- the detail page's own "Property Age" (e.g. "15 Years") and "Average Rent" (e.g.
-- "AED 87,751 Yearly") fields, both read via stable data-testid selectors. Same scope as
-- phone_number/whatsapp_link — populated ONLY for the job's detail_scrape_top_n highest-scoring
-- listings (visiting every captured listing's detail page for these two fields alone would be
-- much slower, matching the existing deliberate phone-reveal tradeoff), never fabricated when the
-- site doesn't show them (e.g. a brand-new/off-plan listing may have no "Property Age" at all).

-- Up Migration

ALTER TABLE property_listings ADD COLUMN age_years INTEGER;
ALTER TABLE property_listings ADD COLUMN average_rent NUMERIC(12, 2);

-- Down Migration

ALTER TABLE property_listings DROP COLUMN IF EXISTS average_rent;
ALTER TABLE property_listings DROP COLUMN IF EXISTS age_years;
