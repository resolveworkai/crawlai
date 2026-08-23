-- Authored by: Mohit Singh
--
-- Recurring re-run of a saved search (2026-08-23) — "fetch the same area daily" was the explicit
-- use case the price-drop feature (migrations 1785700000000/1785800000000-era work) was built
-- for, but until now that meant manually re-launching the exact same job every day. A schedule
-- holds the same search criteria a one-off job would (see property_jobs), plus a recurrence
-- interval; Node's own scheduler tick (services/propertyScheduler.ts, no external cron dependency
-- needed for a single-box deploy) creates a real property_jobs row when due, so the EXISTING host
-- runner picks it up exactly like any manually-launched job — no new Python code needed to
-- consume a schedule, only to keep producing normal jobs on a timer.

-- Up Migration

CREATE TABLE property_job_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    platform TEXT NOT NULL CHECK (platform IN ('dubizzle', 'propertyfinder')),
    location TEXT NOT NULL,
    bedrooms INTEGER CHECK (bedrooms IS NULL OR (bedrooms >= 0 AND bedrooms <= 10)),
    bathrooms INTEGER CHECK (bathrooms IS NULL OR (bathrooms >= 0 AND bathrooms <= 10)),
    property_type TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('buy', 'rent')),
    property_status TEXT NOT NULL DEFAULT 'ready'
        CHECK (property_status IN ('ready', 'offplan', 'any')),
    max_pages INTEGER NOT NULL DEFAULT 3,
    max_listings INTEGER NOT NULL DEFAULT 100,
    detail_scrape_top_n INTEGER NOT NULL DEFAULT 10,
    whatsapp_message_template TEXT,
    score_weights JSONB,
    interval_hours INTEGER NOT NULL CHECK (interval_hours >= 1),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_run_at TIMESTAMPTZ,
    last_run_job_id UUID REFERENCES property_jobs(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_property_job_schedules_due
    ON property_job_schedules (next_run_at) WHERE enabled;

-- Down Migration

DROP TABLE IF EXISTS property_job_schedules;
