/** Authored by: Mohit Singh */
//
// Signed, unguessable unsubscribe tokens for the public /unsubscribe endpoint. Each marketing
// email's footer carries `?email=<addr>&token=<hmac>`; the endpoint recomputes the HMAC to verify
// the pair before adding the address to email_suppressions — so the link needs no login and can't
// be forged or enumerated. HMAC-SHA256 keyed on JWT_SECRET (already the app's server secret).
import crypto from "node:crypto";
import { config } from "../config.js";

export function makeUnsubscribeToken(email: string): string {
  return crypto
    .createHmac("sha256", config.JWT_SECRET)
    .update(email.trim().toLowerCase())
    .digest("hex");
}

/** Constant-time compare so token verification can't be timing-probed. */
export function verifyUnsubscribeToken(email: string, token: string): boolean {
  const expected = makeUnsubscribeToken(email);
  const a = Buffer.from(expected, "hex");
  let b: Buffer;
  try {
    b = Buffer.from(token, "hex");
  } catch {
    return false;
  }
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Absolute unsubscribe URL for the email footer — APP_PUBLIC_URL if set, else FRONTEND_ORIGIN. */
export function unsubscribeUrl(email: string): string {
  const base = (config.APP_PUBLIC_URL ?? config.FRONTEND_ORIGIN).replace(/\/+$/, "");
  const params = new URLSearchParams({ email, token: makeUnsubscribeToken(email) });
  return `${base}/unsubscribe?${params.toString()}`;
}
