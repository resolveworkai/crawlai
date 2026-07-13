/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type { CrawlLog, LogLevel } from "../types/db.js";

export async function createCrawlLog(input: {
  jobId: string;
  level?: LogLevel;
  message: string;
}): Promise<CrawlLog> {
  const { rows } = await pool.query<CrawlLog>(
    `INSERT INTO crawl_logs (job_id, level, message)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.jobId, input.level ?? "info", input.message],
  );
  const log = rows[0];
  if (!log) throw new Error("createCrawlLog: insert returned no row");
  return log;
}

export async function listLogsForJob(jobId: string, limit = 100): Promise<CrawlLog[]> {
  const { rows } = await pool.query<CrawlLog>(
    "SELECT * FROM crawl_logs WHERE job_id = $1 ORDER BY ts DESC LIMIT $2",
    [jobId, limit],
  );
  return rows;
}

// Backs the global recent-activity SSE stream (GET /logs/stream) across all jobs.
export async function listRecentLogs(limit = 100): Promise<CrawlLog[]> {
  const { rows } = await pool.query<CrawlLog>(
    "SELECT * FROM crawl_logs ORDER BY ts DESC LIMIT $1",
    [limit],
  );
  return rows;
}
