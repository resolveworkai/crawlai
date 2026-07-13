/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type { BusinessImage } from "../types/db.js";

export async function listImagesForBusiness(businessId: string): Promise<BusinessImage[]> {
  const { rows } = await pool.query<BusinessImage>(
    "SELECT * FROM business_images WHERE business_id = $1 ORDER BY created_at ASC",
    [businessId],
  );
  return rows;
}

export async function addBusinessImage(input: {
  businessId: string;
  kind: string;
  url: string;
}): Promise<BusinessImage> {
  const { rows } = await pool.query<BusinessImage>(
    `INSERT INTO business_images (business_id, kind, url)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.businessId, input.kind, input.url],
  );
  const image = rows[0];
  if (!image) throw new Error("addBusinessImage: insert returned no row");
  return image;
}
