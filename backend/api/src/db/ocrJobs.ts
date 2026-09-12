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

// Every job is retryable, not just failed/blocked ones (2026-09-12) — see routes/ocrCrawl.ts's
// handler, which decides RESUME vs REFRESH based on the job's status before calling this:
//   - failed/blocked -> RESUME: business_scout_worker/ocr/pipeline.py finds its own manifest.json
//     still on disk and skips already-captured businesses, same as before this change.
//   - ready -> REFRESH: the route deletes manifest.json + every ocr_businesses row for this job
//     FIRST, so pipeline.py sees no manifest and walks fresh — a full re-capture that reflects
//     current reality rather than replaying stale results.
// Resets captured/ocr-done counts/current_business to 0/NULL either way — safe for a resumed
// retry too, since pipeline.py immediately recomputes them from the resumed manifest/DB on claim
// (ocr_jobs.py's get_ocr_done_indices), it doesn't trust whatever was last written here.
// The WHERE clause is the atomic guard: status must still be in an allowed state and under the
// retry cap, so two concurrent retry clicks (or a retry racing a fresh worker pickup) can't
// double-increment or resurrect an already-retried job. Returns null if that guard didn't hold —
// the caller distinguishes "not found" vs "wrong state" vs "limit reached" by re-reading the row
// first.
export async function retryOcrJob(id: string): Promise<OcrJob | null> {
  const { rows } = await pool.query<OcrJob>(
    `UPDATE ocr_jobs
     SET status = 'queued', error_message = NULL, end_reason = NULL,
         started_at = NULL, finished_at = NULL, retry_count = retry_count + 1,
         total_count = 0, captured_count = 0, ocr_done_count = 0, current_business = NULL
     WHERE id = $1 AND status IN ('failed', 'blocked', 'ready') AND retry_count < $2
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
