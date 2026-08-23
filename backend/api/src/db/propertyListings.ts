/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type {
  PropertyListing,
  PropertyListingRefresh,
  PropertyListingWithHistory,
  PropertyPlatform,
  PropertyPossibleDuplicate,
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
//
// `possible_duplicate` — cross-platform dedup (2026-08-23): flags a listing that LIKELY represents
// the same physical unit already captured on the OTHER platform (dubizzle vs propertyfinder), so
// the same unit isn't scored/messaged/compared as two independent deals. No shared external ID
// exists across the two sites, so this is a HEURISTIC match, never an exact one — surfaced in the
// UI as "possible", never asserted as certain. Matching signals, all required together:
//   - different platform, same purpose (buy vs rent never cross-matches)
//   - same community (case-insensitive exact — the strongest single signal available)
//   - same bedroom count (both sides must have a known value — an unknown-bedroom listing never
//     participates in dedup at all, since "unknown" isn't a safe basis for a match)
//   - same bathroom count IF both sides have one recorded (skipped, not required, when either is
//     missing — bathroom count is inconsistently captured across listings)
//   - price within 8% of each other (or AED 5,000, whichever is larger — a flat percentage alone
//     would be too tight at low price points and too loose at high ones)
//   - area within 6% of each other IF both sides have an area recorded (skipped when either is
//     missing, same reasoning as bathrooms)
// When multiple candidates satisfy all of the above, the closest by price wins. This intentionally
// runs on every read (correlated subquery, same style as previous_price above) rather than being
// precomputed/stored — a listing's "possible duplicate" can change as new jobs capture new data on
// the other platform, and re-deriving it live means it's never stale.
export async function listPropertyListingsWithHistory(
  jobId: string,
): Promise<PropertyListingWithHistory[]> {
  const { rows } = await pool.query<
    PropertyListing & {
      previous_price: string | null;
      latest_refresh: PropertyListingRefresh | null;
      possible_duplicate: PropertyPossibleDuplicate | null;
    }
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
       ) AS latest_refresh,
       (
         SELECT jsonb_build_object(
           'platform', cand_job.platform,
           'listingUrl', cand.listing_url,
           'title', cand.title,
           'price', cand.price
         )
         FROM property_listings cand
         JOIN property_jobs cand_job ON cand_job.id = cand.job_id
         WHERE cand_job.platform <> cur_job.platform
           AND cand_job.purpose = cur_job.purpose
           AND cand.community IS NOT NULL AND pl.community IS NOT NULL
           AND lower(cand.community) = lower(pl.community)
           AND pl.bedrooms IS NOT NULL AND cand.bedrooms = pl.bedrooms
           AND (pl.bathrooms IS NULL OR cand.bathrooms IS NULL OR cand.bathrooms = pl.bathrooms)
           AND pl.price IS NOT NULL AND cand.price IS NOT NULL
           AND ABS(cand.price - pl.price) <= GREATEST(pl.price * 0.08, 5000)
           AND (
             pl.area_sqft IS NULL OR cand.area_sqft IS NULL
             OR ABS(cand.area_sqft - pl.area_sqft) <= GREATEST(pl.area_sqft * 0.06, 50)
           )
         ORDER BY ABS(cand.price - pl.price) ASC
         LIMIT 1
       ) AS possible_duplicate
     FROM property_listings pl
     JOIN property_jobs cur_job ON cur_job.id = pl.job_id
     WHERE pl.job_id = $1
     ORDER BY pl.distress_score DESC NULLS LAST, pl.idx ASC`,
    [jobId],
  );
  return rows.map((row) => {
    const { previous_price, latest_refresh, possible_duplicate, ...listing } = row;
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
      possible_duplicate,
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
