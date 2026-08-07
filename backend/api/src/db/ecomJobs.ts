/** Authored by: Mohit Singh */
//
// Product Research (Ecom-Crawl) job store — mirrors db/ocrJobs.ts's shape/conventions. The Node
// API owns creation and reads; the Python worker (business_scout_worker/ecom/) claims + drives
// the job and writes progress/results back via the shared DB + a pg_notify channel, never HTTP.
import { pool } from "./pool.js";
import type { EcomJob, EcomPlatform, EcomScoreWeights, EcomSortMode } from "../types/db.js";

export async function createEcomJob(input: {
  createdBy: string;
  platform: EcomPlatform;
  query: string;
  sortMode: EcomSortMode;
  maxPages: number;
  maxProducts: number;
  detailScrapeTopN: number;
  scoreWeights?: EcomScoreWeights | undefined;
}): Promise<EcomJob> {
  const { rows } = await pool.query<EcomJob>(
    `INSERT INTO ecom_jobs (
       created_by, platform, query, sort_mode, max_pages, max_products,
       detail_scrape_top_n, score_weights
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.createdBy,
      input.platform,
      input.query,
      input.sortMode,
      input.maxPages,
      input.maxProducts,
      input.detailScrapeTopN,
      input.scoreWeights ? JSON.stringify(input.scoreWeights) : null,
    ],
  );
  const job = rows[0];
  if (!job) throw new Error("createEcomJob: insert returned no row");
  return job;
}

// At most one job may actively run a browser session (capturing/ocr/parsing/detail) at a time —
// enforced by the partial unique index ux_ecom_jobs_single_running as the hard guarantee.
// Multiple jobs MAY sit 'queued' simultaneously: a new job is never rejected, just appended to
// the queue — the worker's claim loop (FOR UPDATE SKIP LOCKED, oldest-created first) auto-runs
// them in submission order.
export async function countQueuedEcomJobs(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ecom_jobs WHERE status = 'queued'`,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function listEcomJobs(options?: {
  limit?: number;
  offset?: number;
}): Promise<EcomJob[]> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const { rows } = await pool.query<EcomJob>(
    "SELECT * FROM ecom_jobs ORDER BY created_at DESC LIMIT $1 OFFSET $2",
    [limit, offset],
  );
  return rows;
}

export async function findEcomJobById(id: string): Promise<EcomJob | null> {
  const { rows } = await pool.query<EcomJob>("SELECT * FROM ecom_jobs WHERE id = $1", [id]);
  return rows[0] ?? null;
}

// Max 3 retries per job — mirrors MAX_OCR_RETRIES (db/ocrJobs.ts); keep the frontend's
// disabled-at-3 button and any error copy in sync if this ever changes.
export const MAX_ECOM_RETRIES = 3;

// Resets a failed/blocked job back to 'queued' so the worker's claim loop picks it up again. The
// WHERE clause is the atomic guard: status must still be failed/blocked and under the retry cap,
// so two concurrent retry clicks (or a retry racing a fresh worker pickup) can't
// double-increment or resurrect an already-retried job. Returns null if that guard didn't hold —
// the caller distinguishes "not found" vs "wrong state" vs "limit reached" by re-reading the row
// first.
export async function retryEcomJob(id: string): Promise<EcomJob | null> {
  const { rows } = await pool.query<EcomJob>(
    `UPDATE ecom_jobs
     SET status = 'queued', error_message = NULL, end_reason = NULL,
         started_at = NULL, finished_at = NULL, retry_count = retry_count + 1
     WHERE id = $1 AND status IN ('failed', 'blocked') AND retry_count < $2
     RETURNING *`,
    [id, MAX_ECOM_RETRIES],
  );
  return rows[0] ?? null;
}

export async function deleteEcomJob(id: string): Promise<EcomJob | null> {
  // Returns the row (incl. storage_dir) so the caller can delete the on-disk job folder too;
  // ecom_products/ecom_logs cascade-delete via the FK.
  const { rows } = await pool.query<EcomJob>(
    "DELETE FROM ecom_jobs WHERE id = $1 RETURNING *",
    [id],
  );
  return rows[0] ?? null;
}

// Wakes the Python worker's LISTEN ecom_crawl_jobs (business_scout_worker/main.py). Payload is
// informational only — the worker re-claims via an oldest-queued query on wake.
export async function notifyEcomJobs(id: string): Promise<void> {
  await pool.query("SELECT pg_notify('ecom_crawl_jobs', $1)", [id]);
}
