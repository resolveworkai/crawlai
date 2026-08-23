/** Authored by: Mohit Singh */
//
// Property Research job store — mirrors db/ecomJobs.ts's shape/conventions. The Node API owns
// creation and reads; the Python host runner (business_scout_worker/property/,
// run_property_host.py) claims + drives the job and writes progress/results back via the shared
// DB. UNLIKE ecom_jobs, there is no pg_notify wake here — every property platform requires CDP
// (see propertyJobs' schema comment), so there is no container daemon to wake at all; the host
// runner picks up a new 'queued' row on its own poll loop instead. Don't add a notify call here
// unless a future property platform is genuinely headless-capable and gets a container claimant.
import { pool } from "./pool.js";
import type {
  PropertyJob,
  PropertyPlatform,
  PropertyPurpose,
  PropertyScoreWeights,
  PropertyStatus,
  PropertyType,
} from "../types/db.js";

export async function createPropertyJob(input: {
  // Nullable so a scheduled job (services/propertyScheduler.ts) can still fire correctly even if
  // the schedule's own creator was since deleted (property_job_schedules.created_by is
  // ON DELETE SET NULL) — the DB column itself is nullable, this type now matches it exactly.
  createdBy: string | null;
  platform: PropertyPlatform;
  location: string;
  bedrooms?: number | undefined;
  bathrooms?: number | undefined;
  propertyType: PropertyType;
  purpose: PropertyPurpose;
  propertyStatus: PropertyStatus;
  maxPages: number;
  maxListings: number;
  detailScrapeTopN: number;
  whatsappMessageTemplate?: string | undefined;
  scoreWeights?: PropertyScoreWeights | undefined;
}): Promise<PropertyJob> {
  const { rows } = await pool.query<PropertyJob>(
    `INSERT INTO property_jobs (
       created_by, platform, location, bedrooms, bathrooms, property_type, purpose,
       property_status, max_pages, max_listings, detail_scrape_top_n,
       whatsapp_message_template, score_weights
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [
      input.createdBy,
      input.platform,
      input.location,
      input.bedrooms ?? null,
      input.bathrooms ?? null,
      input.propertyType,
      input.purpose,
      input.propertyStatus,
      input.maxPages,
      input.maxListings,
      input.detailScrapeTopN,
      input.whatsappMessageTemplate ?? null,
      input.scoreWeights ? JSON.stringify(input.scoreWeights) : null,
    ],
  );
  const job = rows[0];
  if (!job) throw new Error("createPropertyJob: insert returned no row");
  return job;
}

// At most one job PER PLATFORM may actively run a browser session (capturing/parsing/detail/
// scoring) at a time — enforced by the partial unique index
// ux_property_jobs_single_running_per_platform (2026-08-23: narrowed from a GLOBAL lock to a
// per-platform one, since dubizzle and propertyfinder are independent sites captured through
// independent Playwright Pages within the same Chrome — see the migration's header comment and
// run_property_host.py's per-platform claim loops). Multiple jobs MAY sit 'queued' simultaneously
// on the SAME platform: a new job is never rejected, just appended to that platform's queue.
// countQueuedPropertyJobs is scoped to `platform` for the same reason — a queued propertyfinder
// job no longer sits "ahead of" a dubizzle job in any real sense, so reporting a global count
// would overstate the actual wait.
export async function countQueuedPropertyJobs(platform: PropertyPlatform): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM property_jobs WHERE status = 'queued' AND platform = $1`,
    [platform],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function listPropertyJobs(options?: {
  limit?: number;
  offset?: number;
}): Promise<PropertyJob[]> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const { rows } = await pool.query<PropertyJob>(
    "SELECT * FROM property_jobs ORDER BY created_at DESC LIMIT $1 OFFSET $2",
    [limit, offset],
  );
  return rows;
}

export async function findPropertyJobById(id: string): Promise<PropertyJob | null> {
  const { rows } = await pool.query<PropertyJob>("SELECT * FROM property_jobs WHERE id = $1", [id]);
  return rows[0] ?? null;
}

// Max 3 retries per job — same cap as MAX_ECOM_RETRIES (db/ecomJobs.ts); keep the frontend's
// disabled-at-3 button and any error copy in sync if this ever changes.
export const MAX_PROPERTY_RETRIES = 3;

// Resets a failed/blocked job back to 'queued' so the host runner's poll loop picks it up again.
// The WHERE clause is the atomic guard: status must still be failed/blocked and under the retry
// cap, so two concurrent retry clicks can't double-increment or resurrect an already-retried job.
export async function retryPropertyJob(id: string): Promise<PropertyJob | null> {
  const { rows } = await pool.query<PropertyJob>(
    `UPDATE property_jobs
     SET status = 'queued', error_message = NULL, end_reason = NULL,
         started_at = NULL, finished_at = NULL, retry_count = retry_count + 1
     WHERE id = $1 AND status IN ('failed', 'blocked') AND retry_count < $2
     RETURNING *`,
    [id, MAX_PROPERTY_RETRIES],
  );
  return rows[0] ?? null;
}

export async function deletePropertyJob(id: string): Promise<PropertyJob | null> {
  // Returns the row (incl. storage_dir) so the caller can delete the on-disk job folder too;
  // property_listings/property_logs cascade-delete via the FK.
  const { rows } = await pool.query<PropertyJob>(
    "DELETE FROM property_jobs WHERE id = $1 RETURNING *",
    [id],
  );
  return rows[0] ?? null;
}
