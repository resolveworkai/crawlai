/** Authored by: Mohit Singh */
//
// Email opt-out / hard-bounce list. Checked before every email send (services/emailService.ts);
// the public /unsubscribe endpoint inserts here. Emails are always stored lowercased.
import { pool } from "./pool.js";
import type { EmailSuppression, SuppressionReason } from "../types/db.js";

export async function addSuppression(
  email: string,
  reason: SuppressionReason = "unsubscribed",
): Promise<void> {
  await pool.query(
    `INSERT INTO email_suppressions (email, reason) VALUES (lower($1), $2)
     ON CONFLICT (email) DO NOTHING`,
    [email, reason],
  );
}

export async function isSuppressed(email: string): Promise<boolean> {
  const { rowCount } = await pool.query("SELECT 1 FROM email_suppressions WHERE email = lower($1)", [
    email,
  ]);
  return (rowCount ?? 0) > 0;
}

/** All suppressed addresses as a lowercased Set — one query for a whole campaign send. */
export async function getSuppressedSet(): Promise<Set<string>> {
  const { rows } = await pool.query<{ email: string }>("SELECT email FROM email_suppressions");
  return new Set(rows.map((r) => r.email));
}

export async function listSuppressions(): Promise<EmailSuppression[]> {
  const { rows } = await pool.query<EmailSuppression>(
    "SELECT * FROM email_suppressions ORDER BY created_at DESC",
  );
  return rows;
}

export async function removeSuppression(email: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM email_suppressions WHERE email = lower($1)", [
    email,
  ]);
  return (rowCount ?? 0) > 0;
}
