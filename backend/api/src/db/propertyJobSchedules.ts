/** Authored by: Mohit Singh */
//
// Recurring-search store — see db/migrations/1786000000000_property-job-schedules.sql. Node owns
// this end-to-end (creation, listing, the scheduler tick that materializes a due schedule into a
// real property_jobs row) — the Python host runner never knows a schedule exists.
import { pool } from "./pool.js";
import type {
  PropertyJobSchedule,
  PropertyPlatform,
  PropertyPurpose,
  PropertyScoreWeights,
  PropertySortOrder,
  PropertyStatus,
  PropertyType,
} from "../types/db.js";

export interface CreatePropertyJobScheduleInput {
  createdBy: string;
  platform: PropertyPlatform;
  location: string;
  bedrooms?: number | undefined;
  bathrooms?: number | undefined;
  propertyType: PropertyType;
  purpose: PropertyPurpose;
  propertyStatus: PropertyStatus;
  sortOrder?: PropertySortOrder | undefined;
  maxPages: number;
  maxListings: number;
  detailScrapeTopN: number;
  whatsappMessageTemplate?: string | undefined;
  scoreWeights?: PropertyScoreWeights | undefined;
  intervalHours: number;
}

export async function createPropertyJobSchedule(
  input: CreatePropertyJobScheduleInput,
): Promise<PropertyJobSchedule> {
  const { rows } = await pool.query<PropertyJobSchedule>(
    `INSERT INTO property_job_schedules (
       created_by, platform, location, bedrooms, bathrooms, property_type, purpose,
       property_status, sort_order, max_pages, max_listings, detail_scrape_top_n,
       whatsapp_message_template, score_weights, interval_hours
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
      input.sortOrder ?? "default",
      input.maxPages,
      input.maxListings,
      input.detailScrapeTopN,
      input.whatsappMessageTemplate ?? null,
      input.scoreWeights ? JSON.stringify(input.scoreWeights) : null,
      input.intervalHours,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("createPropertyJobSchedule: insert returned no row");
  return row;
}

export async function listPropertyJobSchedules(): Promise<PropertyJobSchedule[]> {
  const { rows } = await pool.query<PropertyJobSchedule>(
    "SELECT * FROM property_job_schedules ORDER BY created_at DESC",
  );
  return rows;
}

export async function findPropertyJobScheduleById(
  id: string,
): Promise<PropertyJobSchedule | null> {
  const { rows } = await pool.query<PropertyJobSchedule>(
    "SELECT * FROM property_job_schedules WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}

export async function setPropertyJobScheduleEnabled(
  id: string,
  enabled: boolean,
): Promise<PropertyJobSchedule | null> {
  const { rows } = await pool.query<PropertyJobSchedule>(
    // Re-arming a re-enabled schedule to "due now" rather than leaving a stale next_run_at from
    // before it was paused — an operator flipping a schedule back on almost certainly wants it to
    // run again promptly, not silently wait out whatever time was left on its old interval.
    `UPDATE property_job_schedules
     SET enabled = $2, next_run_at = CASE WHEN $2 THEN now() ELSE next_run_at END
     WHERE id = $1
     RETURNING *`,
    [id, enabled],
  );
  return rows[0] ?? null;
}

export async function deletePropertyJobSchedule(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM property_job_schedules WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

// Every DUE schedule (enabled AND next_run_at <= now). No row locking here — this deploy runs a
// single Node process with a single setInterval scheduler tick (services/propertyScheduler.ts),
// which guards against a slow tick overlapping the next one with its own in-process flag; there's
// no real multi-process race to protect against with a DB-level lock in this architecture. The
// caller is responsible for creating the property_jobs row and calling markPropertyJobScheduleRun
// for each — that UPDATE's own WHERE-scoped write is what actually prevents a double-fire from
// producing two jobs for the same schedule.
export async function listDuePropertyJobSchedules(): Promise<PropertyJobSchedule[]> {
  const { rows } = await pool.query<PropertyJobSchedule>(
    `SELECT * FROM property_job_schedules
     WHERE enabled AND next_run_at <= now()
     ORDER BY next_run_at ASC`,
  );
  return rows;
}

export async function markPropertyJobScheduleRun(
  id: string,
  jobId: string | null,
  intervalHours: number,
): Promise<void> {
  await pool.query(
    `UPDATE property_job_schedules
     SET next_run_at = now() + ($2 || ' hours')::interval,
         last_run_at = now(),
         last_run_job_id = $3
     WHERE id = $1`,
    [id, intervalHours, jobId],
  );
}
