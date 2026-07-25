/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type { Business, EnrichmentStatus } from "../types/db.js";

export async function findBusinessById(id: string): Promise<Business | null> {
  const { rows } = await pool.query<Business>("SELECT * FROM businesses WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export interface BusinessFilters {
  category?: string;
  city?: string;
  enrichmentStatus?: EnrichmentStatus;
  hasEmail?: boolean;
  search?: string; // matches name via pg_trgm (idx_businesses_name_trgm)
  limit: number;
  offset: number;
}

interface FilteredResult {
  businesses: Business[];
  total: number;
}

export async function listBusinessesFiltered(filters: BusinessFilters): Promise<FilteredResult> {
  const clauses: string[] = [];
  const values: unknown[] = [];

  function addClause(sql: string, value: unknown): void {
    values.push(value);
    clauses.push(sql.replace("?", `$${values.length}`));
  }

  // Fuzzy-dedup merges (Phase 4, worker's dedupe.py) are soft — the row still exists but is
  // folded into a canonical duplicate, so it must never appear as a separate listing.
  clauses.push("merged_into_id IS NULL");
  if (filters.category) addClause("category = ?", filters.category);
  if (filters.city) addClause("city = ?", filters.city);
  if (filters.enrichmentStatus) addClause("enrichment_status = ?", filters.enrichmentStatus);
  if (filters.hasEmail === true) clauses.push("email IS NOT NULL");
  if (filters.hasEmail === false) clauses.push("email IS NULL");
  if (filters.search) addClause("name ILIKE ?", `%${filters.search}%`);

  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const countResult = await pool.query<{ count: string }>(
    `SELECT count(*)::text FROM businesses ${where}`,
    values,
  );
  const total = Number(countResult.rows[0]?.count ?? 0);

  values.push(filters.limit, filters.offset);
  const { rows } = await pool.query<Business>(
    `SELECT * FROM businesses ${where}
     ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );

  return { businesses: rows, total };
}

export async function listBusinesses(limit = 50): Promise<Business[]> {
  const { rows } = await pool.query<Business>(
    "SELECT * FROM businesses WHERE merged_into_id IS NULL ORDER BY created_at DESC LIMIT $1",
    [limit],
  );
  return rows;
}

// Overview screen's "Recently enriched" widget (top 5).
export async function listRecentlyEnriched(limit = 5): Promise<Business[]> {
  const { rows } = await pool.query<Business>(
    `SELECT * FROM businesses
     WHERE enrichment_status = 'enriched' AND merged_into_id IS NULL
     ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
  return rows;
}

export async function countBusinesses(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    "SELECT count(*)::text FROM businesses WHERE merged_into_id IS NULL",
  );
  return Number(rows[0]?.count ?? 0);
}

export async function deleteBusiness(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM businesses WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

// Phase 6 (manual Google enrichment) writes exactly these columns, never automatically — see
// .claude/skills/skills_backend_node.md "The manual Google-enrichment endpoint".
export async function setGoogleEnrichment(
  id: string,
  fields: { googleRating?: number | null; reviewCount?: number | null; reviewUrl?: string | null },
): Promise<Business | null> {
  const { rows } = await pool.query<Business>(
    `UPDATE businesses
     SET google_rating = COALESCE($2, google_rating),
         review_count = COALESCE($3, review_count),
         review_url = COALESCE($4, review_url),
         google_enriched_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, fields.googleRating ?? null, fields.reviewCount ?? null, fields.reviewUrl ?? null],
  );
  return rows[0] ?? null;
}
