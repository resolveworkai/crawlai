/** Authored by: Mohit Singh */
//
// Read-only from Node — the Python worker (business_scout_worker/ocr/jobs.py write_log) is the
// only writer, mirroring how db/crawlLogs.ts's listRecentLogs works for the main crawler.
import { pool } from "./pool.js";
import type { OcrLog } from "../types/db.js";

export async function listLogsForOcrJob(jobId: string, limit = 100): Promise<OcrLog[]> {
  const { rows } = await pool.query<OcrLog>(
    "SELECT * FROM ocr_logs WHERE job_id = $1 ORDER BY ts DESC LIMIT $2",
    [jobId, limit],
  );
  return rows;
}

// Backs the global recent-activity SSE stream (GET /logs/stream), merged with the main crawler's
// listRecentLogs() there.
export async function listRecentOcrLogs(limit = 100): Promise<OcrLog[]> {
  const { rows } = await pool.query<OcrLog>("SELECT * FROM ocr_logs ORDER BY ts DESC LIMIT $1", [
    limit,
  ]);
  return rows;
}
