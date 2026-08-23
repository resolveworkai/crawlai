/** Authored by: Mohit Singh */
//
// Per-row "Refresh" request store — see db/migrations/1785700000000_property-listing-refreshes.sql.
// Node creates the request (queued) and reads its status; the Python host runner (property/
// refresh.py) claims + processes it, same claim pattern as property_jobs but far lighter.
import { pool } from "./pool.js";
import type { PropertyListingRefresh, PropertyPlatform } from "../types/db.js";

// At most one outstanding (queued/running) refresh per listing — a second click before the first
// finishes reuses the existing request instead of queuing a duplicate.
export async function findPendingRefreshForListing(
  listingId: string,
): Promise<PropertyListingRefresh | null> {
  const { rows } = await pool.query<PropertyListingRefresh>(
    `SELECT * FROM property_listing_refreshes
     WHERE listing_id = $1 AND status IN ('queued', 'running')
     ORDER BY requested_at DESC
     LIMIT 1`,
    [listingId],
  );
  return rows[0] ?? null;
}

export async function createListingRefresh(
  listingId: string,
  listingUrl: string,
  platform: PropertyPlatform,
): Promise<PropertyListingRefresh> {
  const { rows } = await pool.query<PropertyListingRefresh>(
    `INSERT INTO property_listing_refreshes (listing_id, listing_url, platform)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [listingId, listingUrl, platform],
  );
  const row = rows[0];
  if (!row) throw new Error("createListingRefresh: insert returned no row");
  return row;
}

export async function findListingRefreshById(
  id: string,
): Promise<PropertyListingRefresh | null> {
  const { rows } = await pool.query<PropertyListingRefresh>(
    "SELECT * FROM property_listing_refreshes WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}
