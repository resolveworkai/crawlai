/** Authored by: Mohit Singh */
//
// Phase 8 — generic call-volume counters (LLM extraction attempts, Google Places API calls)
// that don't belong on any one businesses row. Both this runtime AND the Python worker
// (business_scout_worker/metrics.py) write to the same table with the same upsert pattern —
// see .claude/skills/skills_db.md's schema-ownership note: Node owns the migration, but plain
// SQL writes from Python are fine (same as businesses/crawl_logs).
import { pool } from "./pool.js";

export async function incrementMetric(key: string, by = 1): Promise<void> {
  await pool.query(
    `INSERT INTO system_metrics (metric_key, count)
     VALUES ($1, $2)
     ON CONFLICT (metric_key) DO UPDATE
       SET count = system_metrics.count + EXCLUDED.count, updated_at = now()`,
    [key, by],
  );
}

export async function getAllMetrics(): Promise<Record<string, number>> {
  const { rows } = await pool.query<{ metric_key: string; count: string }>(
    "SELECT metric_key, count FROM system_metrics",
  );
  return Object.fromEntries(rows.map((r) => [r.metric_key, Number(r.count)]));
}
