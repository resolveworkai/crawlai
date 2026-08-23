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

export async function listHostRunnerStatuses(): Promise<HostRunnerStatus[]> {
  const { rows } = await pool.query<HostRunnerStatus>(
    "SELECT * FROM host_runner_status ORDER BY runner_name",
  );
  return rows;
}
