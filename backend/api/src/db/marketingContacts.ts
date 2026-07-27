/** Authored by: Mohit Singh */
//
// CRUD for manually-added, reusable marketing contacts. Mirrors db/messageTemplates.ts conventions.
// Phone/email are normalized by the caller (routes/marketing.ts, via recipientParse.ts's
// normalizePhone/normalizeEmail) before these functions run — this module just persists.
import { pool } from "./pool.js";
import type { MarketingContact } from "../types/db.js";

export async function listContacts(): Promise<MarketingContact[]> {
  const { rows } = await pool.query<MarketingContact>(
    "SELECT * FROM marketing_contacts ORDER BY created_at DESC",
  );
  return rows;
}

export async function createContact(input: {
  businessName: string;
  businessType: string | null;
  location: string | null;
  phone: string | null;
  email: string | null;
  createdBy: string | null;
}): Promise<MarketingContact> {
  const { rows } = await pool.query<MarketingContact>(
    `INSERT INTO marketing_contacts (business_name, business_type, location, phone, email, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [input.businessName, input.businessType, input.location, input.phone, input.email, input.createdBy],
  );
  return rows[0]!;
}

export async function updateContact(
  id: string,
  patch: {
    businessName?: string;
    businessType?: string | null;
    location?: string | null;
    phone?: string | null;
    email?: string | null;
  },
): Promise<MarketingContact | null> {
  const { rows } = await pool.query<MarketingContact>(
    `UPDATE marketing_contacts SET
        business_name = COALESCE($2, business_name),
        business_type = CASE WHEN $3::boolean THEN $4 ELSE business_type END,
        location = CASE WHEN $5::boolean THEN $6 ELSE location END,
        phone = CASE WHEN $7::boolean THEN $8 ELSE phone END,
        email = CASE WHEN $9::boolean THEN $10 ELSE email END,
        updated_at = now()
      WHERE id = $1 RETURNING *`,
    [
      id,
      patch.businessName ?? null,
      patch.businessType !== undefined,
      patch.businessType ?? null,
      patch.location !== undefined,
      patch.location ?? null,
      patch.phone !== undefined,
      patch.phone ?? null,
      patch.email !== undefined,
      patch.email ?? null,
    ],
  );
  return rows[0] ?? null;
}

export async function deleteContact(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM marketing_contacts WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}
