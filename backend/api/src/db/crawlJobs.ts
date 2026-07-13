/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type { CrawlJob, JobStatus } from "../types/db.js";

export async function createCrawlJob(input: {
  createdBy: string;
  businessType: string;
  locationLabel?: string | null;
  centerLat: number;
  centerLng: number;
  radiusKm: number;
}): Promise<CrawlJob> {
  const { rows } = await pool.query<CrawlJob>(
    `INSERT INTO crawl_jobs (created_by, business_type, location_label, center_lat, center_lng, radius_km)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.createdBy,
      input.businessType,
      input.locationLabel ?? null,
      input.centerLat,
      input.centerLng,
      input.radiusKm,
    ],
  );
  const job = rows[0];
  if (!job) throw new Error("createCrawlJob: insert returned no row");
  return job;
}

export async function findCrawlJobById(id: string): Promise<CrawlJob | null> {
  const { rows } = await pool.query<CrawlJob>("SELECT * FROM crawl_jobs WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listCrawlJobs(limit = 50): Promise<CrawlJob[]> {
  const { rows } = await pool.query<CrawlJob>(
    "SELECT * FROM crawl_jobs ORDER BY created_at DESC LIMIT $1",
    [limit],
  );
  return rows;
}

export async function updateCrawlJobStatus(id: string, status: JobStatus): Promise<CrawlJob | null> {
  const { rows } = await pool.query<CrawlJob>(
    "UPDATE crawl_jobs SET status = $2 WHERE id = $1 RETURNING *",
    [id, status],
  );
  return rows[0] ?? null;
}

export async function deleteCrawlJob(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM crawl_jobs WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

const ACTIVE_STATUSES: JobStatus[] = ["pending", "discovering", "crawling"];
const TERMINAL_STATUSES: JobStatus[] = ["completed", "failed", "cancelled"];

// Only a running/queued job can be paused/resumed/cancelled — the worker (Phase 3) checks
// these flags between businesses; see .claude/skills/skills_backend_python.md.
export async function requestPause(id: string): Promise<CrawlJob | null> {
  const { rows } = await pool.query<CrawlJob>(
    `UPDATE crawl_jobs SET pause_requested = true
     WHERE id = $1 AND status = ANY($2) RETURNING *`,
    [id, ACTIVE_STATUSES],
  );
  return rows[0] ?? null;
}

export async function requestResume(id: string): Promise<CrawlJob | null> {
  const { rows } = await pool.query<CrawlJob>(
    `UPDATE crawl_jobs SET pause_requested = false
     WHERE id = $1 AND status = 'paused' RETURNING *`,
    [id],
  );
  return rows[0] ?? null;
}

export async function requestCancel(id: string): Promise<CrawlJob | null> {
  const { rows } = await pool.query<CrawlJob>(
    `UPDATE crawl_jobs SET cancel_requested = true
     WHERE id = $1 AND status = ANY($2) RETURNING *`,
    [id, [...ACTIVE_STATUSES, "paused"]],
  );
  return rows[0] ?? null;
}

// Re-queues a terminal job with its original center/radius/type — the design's "Retry"
// button on the Jobs screen. Resets counters and flags rather than creating a duplicate row,
// so the job's history stays on one entry.
export async function retryCrawlJob(id: string): Promise<CrawlJob | null> {
  const { rows } = await pool.query<CrawlJob>(
    `UPDATE crawl_jobs
     SET status = 'pending', cancel_requested = false, pause_requested = false,
         found_count = 0, crawled_count = 0, website_crawled_count = 0, failed_count = 0,
         current_business = NULL, error_message = NULL, started_at = NULL, finished_at = NULL
     WHERE id = $1 AND status = ANY($2)
     RETURNING *`,
    [id, TERMINAL_STATUSES],
  );
  return rows[0] ?? null;
}

// Wakes the Python worker's LISTEN crawl_jobs (backend/worker/business_scout_worker/main.py's
// _listen_loop). The payload (job id) is informational only — the worker always re-claims via
// a plain "oldest pending" query on wake, so this just needs to fire, never be parsed.
export async function notifyCrawlJobs(id: string): Promise<void> {
  await pool.query("SELECT pg_notify('crawl_jobs', $1)", [id]);
}
