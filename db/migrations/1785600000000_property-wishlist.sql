-- Authored by: Mohit Singh
--
-- Property Research wishlist — a save-for-later list of individual listings, independent of
-- whichever job first captured them. Deliberately a SNAPSHOT (title/price/area/etc. copied at
-- save-time), not a live FK to property_listings: a job (and its listings, ON DELETE CASCADE) can
-- be deleted or re-run at any time, but a listing someone saved should stay visible with the data
-- they saw when they saved it, and still link back to the real listing_url either way.
-- `source_listing_id` is kept as a plain UUID (no FK constraint) purely for de-dup/traceability —
-- it may point at a since-deleted row, which is expected and harmless.
--
-- De-duped on listing_url (the real site URL is the true identity of a listing) — a listing with
-- no captured URL can still be saved, just without dedup protection (an edge case, not worth
-- blocking on).

-- Up Migration

CREATE TABLE property_wishlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    source_listing_id UUID,
    platform TEXT NOT NULL,
    title TEXT NOT NULL,
    listing_url TEXT,
    image_url TEXT,
    price NUMERIC(14,2),
    currency TEXT DEFAULT 'AED',
    area_sqft NUMERIC(10,2),
    price_per_sqft NUMERIC(10,2),
    bedrooms INTEGER,
    bathrooms INTEGER,
    property_type TEXT,
    location_text TEXT,
    community TEXT,
    is_offplan BOOLEAN NOT NULL DEFAULT FALSE,
    age_years INTEGER,
    average_rent NUMERIC(12,2),
    listed_date TEXT,
    distress_score REAL,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_property_wishlist_listing_url
    ON property_wishlist (listing_url) WHERE listing_url IS NOT NULL;
CREATE INDEX idx_property_wishlist_created_at ON property_wishlist (created_at DESC);

-- Down Migration

DROP TABLE IF EXISTS property_wishlist;
