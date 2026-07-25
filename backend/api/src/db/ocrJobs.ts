/** Authored by: Mohit Singh */
//
// Crawl-OCR job store — mirrors db/crawlJobs.ts's shape/conventions. The Node API owns creation
// and reads; the Python worker (business_scout_worker/ocr/) claims + drives the job and writes
// progress/results back. Communication is the shared DB + a pg_notify channel, never HTTP —
// same seam rule as the main crawler (see .claude/skills/skills_db.md).
import { pool } from "./pool.js";
import type { OcrJob } from "../types/db.js";

const ACTIVE_STATUSES = ["queued", "capturing", "ocr", "parsing"];

export async function createOcrJob(input: {
  createdBy: string;
  query: string;
  location: string;
  maxResults: number;
  expandHours: boolean;
  langs: string;
}): Promise<OcrJob> {
  const { rows } = await pool.query<OcrJob>(
    `INSERT INTO ocr_jobs (created_by, query, location, max_results, expand_hours, langs)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.createdBy,
      input.query,
      input.location,
      input.maxResults,
      input.expandHours,
      input.langs,
    ],
  );
  const job = rows[0];
  if (!job) throw new Error("createOcrJob: insert returned no row");
  return job;
}

// Single-flight lock (§6). The DB also enforces this via a partial unique index, so this is the
// friendly 409 path — the index is the hard guarantee against a race.
export async function hasActiveOcrJob(): Promise<boolean> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM ocr_jobs WHERE status = ANY($1)`,
    [ACTIVE_STATUSES],
  );
  return Number(rows[0]?.n ?? 0) > 0;
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
