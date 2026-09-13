/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type { OcrBusiness } from "../types/db.js";

export async function listOcrBusinesses(jobId: string): Promise<OcrBusiness[]> {
  const { rows } = await pool.query<OcrBusiness>(
    "SELECT * FROM ocr_businesses WHERE job_id = $1 ORDER BY idx ASC",
    [jobId],
  );
  return rows;
}

// Backs the row-level export button (routes/ocrCrawl.ts) — scoped to (job_id, id) so a business
// id from one job can never be exported under a different job's URL.
export async function findOcrBusinessById(
  jobId: string,
  id: string,
): Promise<OcrBusiness | null> {
  const { rows } = await pool.query<OcrBusiness>(
    "SELECT * FROM ocr_businesses WHERE job_id = $1 AND id = $2",
    [jobId, id],
  );
  return rows[0] ?? null;
}

// Used only by a "refresh" retry (routes/ocrCrawl.ts) on an already-`ready` job — a full
// re-capture is about to overwrite everything at the same (job_id, idx) via
// insert_ocr_business's ON CONFLICT, but a fresh walk could legitimately find FEWER businesses
// than the prior attempt (one closed, delisted, etc.); without this, those now-stale extra rows
// would survive untouched, so "retry" wouldn't actually mean "overwrite with current reality".
export async function deleteOcrBusinessesForJob(jobId: string): Promise<void> {
  await pool.query("DELETE FROM ocr_businesses WHERE job_id = $1", [jobId]);
}
