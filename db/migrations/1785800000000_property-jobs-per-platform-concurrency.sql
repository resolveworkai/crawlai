-- Authored by: Mohit Singh
--
-- dubizzle.com and propertyfinder.ae are independent sites, captured by independent Playwright
-- Page objects within the SAME operator Chrome (see run_property_host.py) — there is no real
-- reason a running dubizzle job should block a queued propertyfinder job (or vice versa) from
-- starting. The old GLOBAL single-running lock (`UNIQUE ((true)) WHERE status IN (...)`) was
-- correct for the single-Chrome constraint in general but over-serialized two DIFFERENT platforms
-- that don't actually contend for anything. Narrowed to per-platform: at most one job PER PLATFORM
-- may be actively running (capturing/parsing/detail/scoring) at a time, but one of EACH platform
-- may run concurrently. Two jobs on the SAME platform still can't run concurrently (that would be
-- two Pages fighting over the same site's pagination/rate-limit posture).

-- Up Migration

DROP INDEX IF EXISTS ux_property_jobs_single_running;

CREATE UNIQUE INDEX ux_property_jobs_single_running_per_platform
    ON property_jobs (platform)
    WHERE status IN ('capturing', 'parsing', 'detail', 'scoring');

-- Down Migration

DROP INDEX IF EXISTS ux_property_jobs_single_running_per_platform;

CREATE UNIQUE INDEX ux_property_jobs_single_running
    ON property_jobs ((true))
    WHERE status IN ('capturing', 'parsing', 'detail', 'scoring');
