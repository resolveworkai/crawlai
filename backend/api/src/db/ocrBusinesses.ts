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

// Used only by a "refresh" retry (routes/ocrCrawl.ts) on an already-`ready` job — a full
// re-capture is about to overwrite everything at the same (job_id, idx) via
// insert_ocr_business's ON CONFLICT, but a fresh walk could legitimately find FEWER businesses
// than the prior attempt (one closed, delisted, etc.); without this, those now-stale extra rows
// would survive untouched, so "retry" wouldn't actually mean "overwrite with current reality".
export async function deleteOcrBusinessesForJob(jobId: string): Promise<void> {
  await pool.query("DELETE FROM ocr_businesses WHERE job_id = $1", [jobId]);
}
