/** Authored by: Mohit Singh */
//
// Reads the heartbeat rows Python's chrome_health.py writes (see
// db/migrations/1785900000000_host-runner-status.sql). Node never writes to this table — it's a
// pure read-only status surface for the frontend's "runner not responding" banner.
import { pool } from "./pool.js";

export interface HostRunnerStatus {
  runner_name: string;
  cdp_reachable: boolean;
  last_error: string | null;
  last_heartbeat_at: Date;
}

// A runner heartbeats every poll cycle (default 15s) regardless of whether there was work to do
// — 90s (6 cycles) is a generous buffer for one slow cycle before treating the PROCESS itself as
// dead, not just Chrome being briefly down (which cdp_reachable reports separately).
export const STALE_THRESHOLD_MS = 90_000;

export interface RunnerHealth {
  stale: boolean;
  healthy: boolean;
  // Human-readable "why not" for an error message; null when healthy.
  reason: string | null;
}

// Single definition of "is this host runner usable right now" — shared by the dashboard banner
// (routes/runnerStatus.ts) and the strict real-browser guard on job creation, so the two can never
// disagree about whether the runner is up.
export function evaluateRunnerHealth(
  row: HostRunnerStatus | undefined,
  now: number = Date.now(),
): RunnerHealth {
  if (!row) {
    return { stale: true, healthy: false, reason: "it has never started (no heartbeat recorded)" };
  }
  const ageMs = now - row.last_heartbeat_at.getTime();
  if (ageMs > STALE_THRESHOLD_MS) {
    return {
      stale: true,
      healthy: false,
      reason: `it stopped responding (last heartbeat ${Math.round(ageMs / 1000)}s ago)`,
    };
  }
  if (!row.cdp_reachable) {
    const detail = row.last_error ? `: ${row.last_error}` : "";
    return { stale: false, healthy: false, reason: `its Chrome is not reachable${detail}` };
  }
  return { stale: false, healthy: true, reason: null };
}

export async function getHostRunnerHealth(runnerName: string): Promise<RunnerHealth> {
  const { rows } = await pool.query<HostRunnerStatus>(
    "SELECT * FROM host_runner_status WHERE runner_name = $1",
    [runnerName],
  );
  return evaluateRunnerHealth(rows[0]);
}

export async function listHostRunnerStatuses(): Promise<HostRunnerStatus[]> {
  const { rows } = await pool.query<HostRunnerStatus>(
    "SELECT * FROM host_runner_status ORDER BY runner_name",
  );
  return rows;
}
