/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type { PropertyListing } from "../types/db.js";

// Ranked by distress_score (best deal first) rather than idx (capture order) — this is the
// buyer-facing "best value" view the whole feature exists for; NULLS LAST so unscored rows (a
// job still mid-pipeline) sort to the end instead of appearing first.
export async function listPropertyListings(jobId: string): Promise<PropertyListing[]> {
  const { rows } = await pool.query<PropertyListing>(
    "SELECT * FROM property_listings WHERE job_id = $1 ORDER BY distress_score DESC NULLS LAST, idx ASC",
    [jobId],
  );
  return rows;
}

export async function listTopPropertyListings(
  jobId: string,
  limit: number,
): Promise<PropertyListing[]> {
  const { rows } = await pool.query<PropertyListing>(
    `SELECT * FROM property_listings
     WHERE job_id = $1
     ORDER BY distress_score DESC NULLS LAST, idx ASC
     LIMIT $2`,
    [jobId, limit],
  );
  return rows;
}
