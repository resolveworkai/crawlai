-- Authored by: Mohit Singh
--
-- Host-runner heartbeat (2026-08-23, chrome_health.py) — both the property and noon/aliexpress
-- host runners attach to the SAME physical operator Chrome window on the same CDP port, so Chrome
-- dying takes every CDP-required platform down at once, silently, until a human notices a job
-- failed and manually re-runs the launcher .bat. Each host runner UPSERTs its own row here every
-- poll cycle regardless of whether there was any queued work — a stale `last_heartbeat_at` means
-- the PROCESS itself has died; a fresh heartbeat with `cdp_reachable = false` means the process is
-- alive but Chrome is down. The Node API reads this to show a "runner not responding" banner.

-- Up Migration

CREATE TABLE host_runner_status (
    runner_name TEXT PRIMARY KEY,
    cdp_reachable BOOLEAN NOT NULL DEFAULT FALSE,
    last_error TEXT,
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS host_runner_status;
