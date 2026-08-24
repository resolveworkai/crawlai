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

// Shared enrichment subqueries — the cross-job/day price-drop signal (previous_price: the price
// the SAME listing_url, the site's own stable identity, was captured at in the most recent EARLIER
// job, if any), the most recent COMPLETED manual refresh (see propertyListingRefreshes.ts), and
// `possible_duplicate` (cross-platform dedup, 2026-08-23 — a HEURISTIC match, never certain: a
// listing on the OTHER platform with the same purpose, same community (case-insensitive), same
// bedroom count (required on both sides), same bathroom count when both sides have one, price
// within 8% (or AED 5,000, whichever is larger), and area within 6% when both sides have one; the
// closest by price wins when several qualify). Both `listPropertyListingsWithHistory` (scoped to
// one job) and `searchPropertyListingsGlobally` (scoped to a text query across every job) share
// this exact SQL fragment via string interpolation so the two can never quietly diverge on what
// "previous price"/"possible duplicate" means — it references only the `pl`/`cur_job` aliases,
// which both callers' FROM/JOIN establish identically. Recomputed live on every read rather than
// stored — these signals change as new jobs capture new data, and re-deriving them means they can
// never go stale.
const HISTORY_ENRICHMENT_SQL = `
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
`;

interface HistoryEnrichedRow extends PropertyListing {
  previous_price: string | null;
  latest_refresh: PropertyListingRefresh | null;
  possible_duplicate: PropertyPossibleDuplicate | null;
}

function toListingWithHistory(row: HistoryEnrichedRow): PropertyListingWithHistory {
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
    refreshDropped || (currentPrice !== null && priorPrice !== null && currentPrice < priorPrice);
  return {
    ...listing,
    previous_price,
    price_dropped: priceDropped,
    latest_refresh,
    possible_duplicate,
  };
}

// Same as listPropertyListings, enriched via HISTORY_ENRICHMENT_SQL above.
export async function listPropertyListingsWithHistory(
  jobId: string,
): Promise<PropertyListingWithHistory[]> {
  const { rows } = await pool.query<HistoryEnrichedRow>(
    `SELECT pl.*, ${HISTORY_ENRICHMENT_SQL}
     FROM property_listings pl
     JOIN property_jobs cur_job ON cur_job.id = pl.job_id
     WHERE pl.job_id = $1
     ORDER BY pl.distress_score DESC NULLS LAST, pl.idx ASC`,
    [jobId],
  );
  return rows.map(toListingWithHistory);
}

// A listing enriched exactly like PropertyListingWithHistory, PLUS which job/platform/search it
// was captured under — needed here (and nowhere else) because results span MULTIPLE jobs, so the
// caller can't infer platform/location from "whichever job is currently open" the way the rest of
// the UI does.
export interface PropertySearchResult extends PropertyListingWithHistory {
  platform: PropertyPlatform;
  job_location: string;
}

// Global search across EVERY captured listing (not scoped to one job) — the "search by tower/
// building name" feature (2026-08-24): a tower name usually shows up in a listing's own title
// (e.g. "2BR in Marina Gate 2, Dubai Marina") or its community/location_text, so all three are
// matched, case-insensitive substring. Ordered by recency (not distress_score — there's no shared
// "batch" to rank a percentile against across different searches, and a caller hunting for a
// specific tower cares about "what's out there right now" more than which one scores best on an
// unrelated job's own price distribution). Reuses the exact same HISTORY_ENRICHMENT_SQL fragment
// as the per-job view, so a global-search result shows identical price-drop/duplicate signals to
// what the same listing would show inside its own job's results table.
export async function searchPropertyListingsGlobally(
  query: string,
  limit = 50,
): Promise<PropertySearchResult[]> {
  const { rows } = await pool.query<
    HistoryEnrichedRow & { platform: PropertyPlatform; job_location: string }
  >(
    `SELECT pl.*, cur_job.platform AS platform, cur_job.location AS job_location,
       ${HISTORY_ENRICHMENT_SQL}
     FROM property_listings pl
     JOIN property_jobs cur_job ON cur_job.id = pl.job_id
     WHERE pl.title ILIKE $1 OR pl.community ILIKE $1 OR pl.location_text ILIKE $1
     ORDER BY pl.created_at DESC
     LIMIT $2`,
    [`%${query}%`, limit],
  );
  return rows.map((row) => {
    const { platform, job_location, ...historyRow } = row;
    return { ...toListingWithHistory(historyRow), platform, job_location };
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
