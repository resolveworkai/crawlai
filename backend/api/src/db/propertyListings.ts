/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type {
  PropertyListing,
  PropertyListingRefresh,
  PropertyListingWithHistory,
  PropertyPlatform,
} from "../types/db.js";

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

// Same as listPropertyListings, enriched with the cross-job/day price-drop signal: for each row,
// `previous_price` is the price the SAME listing_url (the real site URL — the one stable identity
// a listing has across separate job runs on different days) was captured at in the most recent
// EARLIER job, if any; `price_dropped` is true when the current price is strictly lower than that.
// Also carries the most recent COMPLETED manual refresh for the row (see propertyListingRefreshes.ts)
// so a just-refreshed row can be highlighted the same way without a second round-trip.
export async function listPropertyListingsWithHistory(
  jobId: string,
): Promise<PropertyListingWithHistory[]> {
  const { rows } = await pool.query<
    PropertyListing & { previous_price: string | null; latest_refresh: PropertyListingRefresh | null }
  >(
    `SELECT pl.*,
       (
         SELECT prior.price FROM property_listings prior
         WHERE prior.listing_url = pl.listing_url
           AND pl.listing_url IS NOT NULL
           AND prior.created_at < pl.created_at
         ORDER BY prior.created_at DESC
         LIMIT 1
       ) AS previous_price,
       (
         SELECT row_to_json(r) FROM (
           SELECT * FROM property_listing_refreshes plr
           WHERE plr.listing_id = pl.id AND plr.status = 'done'
           ORDER BY plr.completed_at DESC
           LIMIT 1
         ) r
       ) AS latest_refresh
     FROM property_listings pl
     WHERE pl.job_id = $1
     ORDER BY pl.distress_score DESC NULLS LAST, pl.idx ASC`,
    [jobId],
  );
  return rows.map((row) => {
    const { previous_price, latest_refresh, ...listing } = row;
    const currentPrice = listing.price === null ? null : Number(listing.price);
    const priorPrice = previous_price === null ? null : Number(previous_price);
    const refreshDropped =
      latest_refresh !== null &&
      latest_refresh.old_price !== null &&
      latest_refresh.new_price !== null &&
      Number(latest_refresh.new_price) < Number(latest_refresh.old_price) &&
      // Only counts if nothing has overwritten the row's price since that refresh completed.
      currentPrice !== null &&
      Number(latest_refresh.new_price) === currentPrice;
    const priceDropped =
      refreshDropped ||
      (currentPrice !== null && priorPrice !== null && currentPrice < priorPrice);
    return {
      ...listing,
      previous_price,
      price_dropped: priceDropped,
      latest_refresh,
    };
  });
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

// Joined to the parent job's platform — property_listings itself carries no platform column (see
// migrations/1785300000000_property-crawl.sql), and the wishlist snapshot (propertyWishlist.ts)
// needs it to render a per-platform badge/link without a second round-trip.
export async function findPropertyListingWithPlatform(
  listingId: string,
): Promise<{ listing: PropertyListing; platform: PropertyPlatform } | null> {
  const { rows } = await pool.query<PropertyListing & { platform: PropertyPlatform }>(
    `SELECT pl.*, pj.platform AS platform
     FROM property_listings pl
     JOIN property_jobs pj ON pj.id = pl.job_id
     WHERE pl.id = $1`,
    [listingId],
  );
  const row = rows[0];
  if (!row) return null;
  const { platform, ...listing } = row;
  return { listing, platform };
}
