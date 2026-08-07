/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type { EcomProduct } from "../types/db.js";

export async function listEcomProducts(jobId: string): Promise<EcomProduct[]> {
  const { rows } = await pool.query<EcomProduct>(
    "SELECT * FROM ecom_products WHERE job_id = $1 ORDER BY idx ASC",
    [jobId],
  );
  return rows;
}
