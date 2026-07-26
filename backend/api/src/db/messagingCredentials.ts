/** Authored by: Mohit Singh */
//
// SMTP credentials singleton (email_credentials id=1). The password is stored AES-256-GCM-encrypted
// and is NEVER returned to the client — `getPublicEmailCredentials` omits it; only the send service
// calls `getDecryptedSmtpPassword`. Mirrors db/crawlSettings.ts's singleton pattern.
import { pool } from "./pool.js";
import type { EmailCredentials } from "../types/db.js";
import { decryptSecret, encryptSecret } from "../lib/messagingCrypto.js";

// What the client is allowed to see — everything except the encrypted password.
export interface PublicEmailCredentials {
  configured: boolean; // host + user + from_email + a stored password all present
  verified: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  orgAddress: string | null;
  updatedAt: Date;
}

async function getRow(): Promise<EmailCredentials> {
  const { rows } = await pool.query<EmailCredentials>(
    "SELECT * FROM email_credentials WHERE id = 1",
  );
  const row = rows[0];
  if (!row) throw new Error("email_credentials singleton row missing — did migrations run?");
  return row;
}

export async function getPublicEmailCredentials(): Promise<PublicEmailCredentials> {
  const r = await getRow();
  return {
    configured: Boolean(r.smtp_host && r.smtp_user && r.from_email && r.smtp_password_encrypted),
    verified: r.verified,
    smtpHost: r.smtp_host,
    smtpPort: r.smtp_port,
    smtpSecure: r.smtp_secure,
    smtpUser: r.smtp_user,
    fromName: r.from_name,
    fromEmail: r.from_email,
    replyTo: r.reply_to,
    orgAddress: r.org_address,
    updatedAt: r.updated_at,
  };
}

export interface UpdateEmailCredentialsInput {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassword?: string | undefined; // omitted on edit = keep the existing encrypted password
  fromName: string;
  fromEmail: string;
  replyTo?: string | undefined;
  orgAddress?: string | undefined;
}

// Writing new credentials resets `verified` to false (they must pass a fresh test send). The
// password is encrypted here; if the caller omitted it (editing other fields), the stored
// ciphertext is left untouched via COALESCE.
export async function updateEmailCredentials(
  input: UpdateEmailCredentialsInput,
): Promise<PublicEmailCredentials> {
  const encrypted = input.smtpPassword ? encryptSecret(input.smtpPassword) : null;
  await pool.query(
    `UPDATE email_credentials SET
        smtp_host = $1, smtp_port = $2, smtp_secure = $3, smtp_user = $4,
        smtp_password_encrypted = COALESCE($5, smtp_password_encrypted),
        from_name = $6, from_email = $7, reply_to = $8, org_address = $9,
        verified = FALSE, updated_at = now()
      WHERE id = 1`,
    [
      input.smtpHost,
      input.smtpPort,
      input.smtpSecure,
      input.smtpUser,
      encrypted,
      input.fromName,
      input.fromEmail,
      input.replyTo ?? null,
      input.orgAddress ?? null,
    ],
  );
  return getPublicEmailCredentials();
}

export async function markEmailCredentialsVerified(): Promise<void> {
  await pool.query("UPDATE email_credentials SET verified = TRUE WHERE id = 1");
}

// Internal only — used by services/emailService.ts to build the nodemailer transport. Returns the
// full config INCLUDING the decrypted password. Never expose this over HTTP.
export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  orgAddress: string | null;
}

export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  const r = await getRow();
  if (!r.smtp_host || !r.smtp_port || !r.smtp_user || !r.smtp_password_encrypted || !r.from_email) {
    return null;
  }
  return {
    host: r.smtp_host,
    port: r.smtp_port,
    secure: r.smtp_secure,
    user: r.smtp_user,
    password: decryptSecret(r.smtp_password_encrypted),
    fromName: r.from_name ?? r.from_email,
    fromEmail: r.from_email,
    replyTo: r.reply_to,
    orgAddress: r.org_address,
  };
}
