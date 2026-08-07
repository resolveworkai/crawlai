-- Authored by: Mohit Singh
--
-- Scope the ecom single-running lock PER RUNNER GROUP instead of globally.
--
-- The original ux_ecom_jobs_single_running (migration 1785000000000) indexed ON ((TRUE)), capping
-- the WHOLE system at one job in a running state (capturing/ocr/parsing/detail). That was correct
-- when a single containerized daemon handled every platform. It broke once noon.com forced a
-- SECOND runner: noon can only be captured by attaching (CDP) to the operator's real Chrome, which
-- runs on the HOST (run_noon_host.py), while every other platform still runs headless in the
-- container. Those are independent browser sessions on different machines and may safely run at the
-- same time — but the global index made the container's claim collide with a live host job,
-- crashing the daemon mid-claim (2026-08-07).
--
-- Re-key the partial unique index on whether the platform is CDP-required (host-run) so AT MOST one
-- CDP job (host) AND one non-CDP job (container) can run concurrently — never two of either. The
-- expression hardcodes 'noon' because it must be immutable for an index; keep it in sync with
-- ecom/adapters.cdp_required_platforms() (the Python source of truth) if another CDP platform is
-- added.

-- Up Migration

DROP INDEX IF EXISTS ux_ecom_jobs_single_running;
CREATE UNIQUE INDEX ux_ecom_jobs_single_running
  ON ecom_jobs ((platform = ANY (ARRAY['noon'])))
  WHERE status IN ('capturing', 'ocr', 'parsing', 'detail');

-- Down Migration

DROP INDEX IF EXISTS ux_ecom_jobs_single_running;
CREATE UNIQUE INDEX ux_ecom_jobs_single_running
  ON ecom_jobs ((TRUE))
  WHERE status IN ('capturing', 'ocr', 'parsing', 'detail');
