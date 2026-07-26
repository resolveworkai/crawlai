/** Authored by: Mohit Singh */
//
// Crawl-OCR job store — mirrors db/crawlJobs.ts's shape/conventions. The Node API owns creation
// and reads; the Python worker (business_scout_worker/ocr/) claims + drives the job and writes
// progress/results back. Communication is the shared DB + a pg_notify channel, never HTTP —
// same seam rule as the main crawler (see .claude/skills/skills_db.md).
import { pool } from "./pool.js";
import type { OcrJob } from "../types/db.js";

export async function createOcrJob(input: {
  createdBy: string;
  query: string;
  location: string;
  maxResults: number;
  expandHours: boolean;
  langs: string;
  centerLat?: number | undefined;
  centerLng?: number | undefined;
  radiusKm?: number | undefined;
}): Promise<OcrJob> {
  const { rows } = await pool.query<OcrJob>(
    `INSERT INTO ocr_jobs (
       created_by, query, location, max_results, expand_hours, langs,
       center_lat, center_lng, radius_km
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      input.createdBy,
      input.query,
      input.location,
      input.maxResults,
      input.expandHours,
      input.langs,
      input.centerLat ?? null,
      input.centerLng ?? null,
      input.radiusKm ?? null,
    ],
  );
  const job = rows[0];
  if (!job) throw new Error("createOcrJob: insert returned no row");
  return job;
}

// At most one job may actively run a Chromium/Maps session at a time — the DB also enforces
// this via a partial unique index (ux_ocr_jobs_single_running) as the hard guarantee against a
// race. Multiple jobs MAY sit 'queued' simultaneously (see migration 1784500000000): a new job
// is never rejected, just appended to the queue — claim_pending_ocr_job() (Python) already
// claims 'queued' rows oldest-first, so they auto-run in submission order.
export async function countQueuedOcrJobs(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ocr_jobs WHERE status = 'queued'`,
  );
  return Number(rows[0]?.n ?? 0);
}

export async function listOcrJobs(limit = 50): Promise<OcrJob[]> {
  const { rows } = await pool.query<OcrJob>(
    "SELECT * FROM ocr_jobs ORDER BY created_at DESC LIMIT $1",
    [limit],
  );
  return rows;
}

export async function findOcrJobById(id: string): Promise<OcrJob | null> {
  const { rows } = await pool.query<OcrJob>("SELECT * FROM ocr_jobs WHERE id = $1", [id]);
  return rows[0] ?? null;
}

// Max 3 retries per job (mirrors the frontend's disabled-at-3 button and the error message
// below — keep all three in sync if this ever changes).
export const MAX_OCR_RETRIES = 3;

// Resets a failed/blocked job back to 'queued' so the worker's claim loop picks it up again —
// see business_scout_worker/ocr/pipeline.py's manifest-reload-on-claim, which is what makes this
// an actual RESUME (skips already-captured businesses) rather than a plain restart. The WHERE
// clause is the atomic guard: status must still be failed/blocked and under the retry cap, so two
// concurrent retry clicks (or a retry racing a fresh worker pickup) can't double-increment or
// resurrect an already-retried job. Returns null if that guard didn't hold — the caller
// distinguishes "not found" vs "wrong state" vs "limit reached" by re-reading the row first.
export async function retryOcrJob(id: string): Promise<OcrJob | null> {
  const { rows } = await pool.query<OcrJob>(
    `UPDATE ocr_jobs
     SET status = 'queued', error_message = NULL, end_reason = NULL,
         started_at = NULL, finished_at = NULL, retry_count = retry_count + 1
     WHERE id = $1 AND status IN ('failed', 'blocked') AND retry_count < $2
     RETURNING *`,
    [id, MAX_OCR_RETRIES],
  );
  return rows[0] ?? null;
}

export async function deleteOcrJob(id: string): Promise<OcrJob | null> {
  // Returns the row (incl. storage_dir) so the caller can delete the on-disk job folder too;
  // ocr_businesses cascade-delete via the FK.
  const { rows } = await pool.query<OcrJob>("DELETE FROM ocr_jobs WHERE id = $1 RETURNING *", [id]);
  return rows[0] ?? null;
}

// Wakes the Python worker's LISTEN ocr_crawl_jobs (business_scout_worker/main.py). Payload is
// informational only — the worker re-claims via an oldest-queued query on wake.
export async function notifyOcrJobs(id: string): Promise<void> {
  await pool.query("SELECT pg_notify('ocr_crawl_jobs', $1)", [id]);
}
