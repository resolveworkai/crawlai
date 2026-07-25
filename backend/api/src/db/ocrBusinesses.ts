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
