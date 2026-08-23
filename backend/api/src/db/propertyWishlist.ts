/** Authored by: Mohit Singh */
//
// Property Research wishlist store — see db/migrations/1785600000000_property-wishlist.sql for why
// this is a SNAPSHOT table (copies a listing's fields at save-time) rather than a live FK to
// property_listings: a job (and its listings) can be deleted/re-run at any point, but a saved
// listing should keep showing what the operator saved, with a link back to the real site either
// way.
import { pool } from "./pool.js";
import type { PropertyListing, PropertyWishlistItem } from "../types/db.js";

export async function addToWishlist(
  listing: PropertyListing,
  platform: string,
  createdBy: string | null,
): Promise<{ item: PropertyWishlistItem; alreadySaved: boolean }> {
  const inserted = await pool.query<PropertyWishlistItem>(
    `INSERT INTO property_wishlist (
       created_by, source_listing_id, platform, title, listing_url, image_url, price, currency,
       area_sqft, price_per_sqft, bedrooms, bathrooms, property_type, location_text, community,
       is_offplan, age_years, average_rent, listed_date, distress_score
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
     ON CONFLICT (listing_url) WHERE listing_url IS NOT NULL DO NOTHING
     RETURNING *`,
    [
      createdBy,
      listing.id,
      platform,
      listing.title,
      listing.listing_url,
      listing.image_urls[0] ?? null,
      listing.price,
      listing.currency,
      listing.area_sqft,
      listing.price_per_sqft,
      listing.bedrooms,
      listing.bathrooms,
      listing.property_type,
      listing.location_text,
      listing.community,
      listing.is_offplan,
      listing.age_years,
      listing.average_rent,
      listing.listed_date,
      listing.distress_score,
    ],
  );
  const freshRow = inserted.rows[0];
  if (freshRow) return { item: freshRow, alreadySaved: false };

  // Only reachable when listing_url is non-null AND it already collided with an existing saved
  // row (the partial unique index means a null listing_url can never conflict, so DO NOTHING would
  // never have suppressed a fresh insert's RETURNING in that case).
  const existing = await pool.query<PropertyWishlistItem>(
    "SELECT * FROM property_wishlist WHERE listing_url = $1 LIMIT 1",
    [listing.listing_url],
  );
  const item = existing.rows[0];
  if (!item) throw new Error("addToWishlist: conflicted insert but no existing row found");
  return { item, alreadySaved: true };
}

export async function listWishlist(): Promise<PropertyWishlistItem[]> {
  const { rows } = await pool.query<PropertyWishlistItem>(
    "SELECT * FROM property_wishlist ORDER BY created_at DESC",
  );
  return rows;
}

export async function removeFromWishlist(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM property_wishlist WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}
