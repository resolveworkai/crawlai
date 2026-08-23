-- Authored by: Mohit Singh
--
-- On-demand single-listing "refresh" (re-check this exact listing's CURRENT price without
-- re-running a whole search job) — a lightweight queue, same claim pattern as property_jobs but
-- much cheaper (visits ONE known listing_url directly, no search/pagination). Also doubles as the
-- price-drop audit trail for a manually-refreshed row: old_price/new_price together are what the
-- UI highlights green from once a refresh completes and the price came down.
--
-- Separate from property_jobs on purpose — a refresh is a different-shaped unit of work (one URL,
-- not a search) and mixing the two state machines would complicate both.

-- Up Migration

CREATE TABLE property_listing_refreshes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    listing_id UUID NOT NULL REFERENCES property_listings(id) ON DELETE CASCADE,
    listing_url TEXT NOT NULL,
    platform TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'done', 'failed')),
    old_price NUMERIC(14,2),
    new_price NUMERIC(14,2),
    error_message TEXT,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_property_listing_refreshes_listing
    ON property_listing_refreshes (listing_id, requested_at DESC);
CREATE INDEX idx_property_listing_refreshes_queued
    ON property_listing_refreshes (status) WHERE status = 'queued';

-- Down Migration

DROP TABLE IF EXISTS property_listing_refreshes;
