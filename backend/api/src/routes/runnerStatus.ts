/** Authored by: Mohit Singh */
//
// Host-runner heartbeat surface (2026-08-23) — reads what Python's chrome_health.py writes (see
// db/hostRunnerStatus.ts). Both the property and noon/aliexpress host runners attach to the SAME
// physical operator Chrome window, so Chrome dying takes every CDP-required platform down at
// once, silently, until this endpoint's frontend consumer (a banner on property-crawl.tsx /
// ecom-crawl.tsx) surfaces it. A runner that has never started at all (no row yet) is reported as
// unknown/stale rather than omitted, so a job silently queuing forever with zero explanation is
// no longer possible.
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { evaluateRunnerHealth, listHostRunnerStatuses } from "../db/hostRunnerStatus.js";

export const runnerStatusRouter = Router();

// The runner names this deployment expects to see — used only to report a NEVER-STARTED runner
// honestly (as unknown/stale) rather than silently omitting it, matching the two host-runner
// scripts this project actually ships (scripts/start-property-host.bat,
// scripts/start-noon-host.bat). Not a hard-coded platform list anywhere else — just what this one
// endpoint needs to fill a gap for a runner that has no row at all yet.
const EXPECTED_RUNNERS = ["property", "noon"] as const;

export interface RunnerStatusView {
  runnerName: string;
  cdpReachable: boolean;
  lastError: string | null;
  lastHeartbeatAt: string | null;
  stale: boolean;
  healthy: boolean;
}

runnerStatusRouter.get("/system/runner-status", requireAuth, async (_req, res) => {
  const rows = await listHostRunnerStatuses();
  const byName = new Map(rows.map((r) => [r.runner_name, r]));
  const runners: RunnerStatusView[] = EXPECTED_RUNNERS.map((name) => {
    const row = byName.get(name);
    if (!row) {
      return {
        runnerName: name,
        cdpReachable: false,
        lastError: null,
        lastHeartbeatAt: null,
        stale: true,
        healthy: false,
      };
    }
    const health = evaluateRunnerHealth(row);
    return {
      runnerName: row.runner_name,
      cdpReachable: row.cdp_reachable,
      lastError: row.last_error,
      lastHeartbeatAt: row.last_heartbeat_at.toISOString(),
      stale: health.stale,
      healthy: health.healthy,
    };
  });

  res.json({ runners });
});
