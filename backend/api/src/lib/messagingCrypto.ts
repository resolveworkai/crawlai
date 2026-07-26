/** Authored by: Mohit Singh */
//
// Encryption-at-rest for the operator's SMTP password (the only reversible secret this app
// stores — everything else is bcrypt-hashed or non-secret). AES-256-GCM (authenticated
// encryption) with a random per-record IV; the master key is MESSAGING_ENCRYPTION_KEY (env) as
// 64 hex chars = 32 bytes. Mirrors myhub's upi/upiCrypto.ts pattern, but persists the whole
// envelope in ONE text column as `v1:<ivHex>:<authTagHex>:<ciphertextHex>` (the DB column is a
// single TEXT, not a JSON blob).
//
// SECURITY: the plaintext password only ever exists transiently — here and at the nodemailer
// transport call site (services/emailService.ts). It is never logged; only the envelope is
// persisted. If the key is unset/invalid the email-credential save/test refuse rather than
// storing a secret in the clear (isEncryptionAvailable() === false) — wa.me/vCard need no secret
// and keep working. See config.ts's MESSAGING_ENCRYPTION_KEY note.
import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

function loadMasterKey(): Buffer | null {
  const hex = process.env.MESSAGING_ENCRYPTION_KEY ?? "";
  if (!hex) return null;
  let key: Buffer;
  try {
    key = Buffer.from(hex, "hex");
  } catch {
    return null;
  }
  return key.length === 32 ? key : null;
}

/** True when a valid 64-hex-char MESSAGING_ENCRYPTION_KEY is present (email sending can run). */
export function isEncryptionAvailable(): boolean {
  return loadMasterKey() !== null;
}

const KEY_MISSING_MESSAGE =
  "MESSAGING_ENCRYPTION_KEY is not configured (must be 64 hex chars / 32 bytes) — " +
  "email credentials cannot be saved. Generate one with: " +
  "node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"";

/** Encrypt a secret into the persistable `v1:iv:tag:ciphertext` string. Throws if key missing. */
export function encryptSecret(plaintext: string): string {
  const key = loadMasterKey();
  if (!key) throw new Error(KEY_MISSING_MESSAGE);
  const iv = crypto.randomBytes(12); // 96-bit nonce recommended for GCM
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${VERSION}:${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

/** Decrypt a `v1:iv:tag:ciphertext` string back to plaintext. Throws on tamper/missing key. */
export function decryptSecret(envelope: string): string {
  const key = loadMasterKey();
  if (!key) {
    throw new Error("MESSAGING_ENCRYPTION_KEY is not configured — cannot decrypt the SMTP password.");
  }
  const parts = envelope.split(":");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed encrypted secret envelope.");
  }
  const [, ivHex, tagHex, dataHex] = parts as [string, string, string, string];
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return Buffer.concat([
      decipher.update(Buffer.from(dataHex, "hex")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // Never log the secret or key material — only that decryption failed.
    throw new Error("Failed to decrypt the SMTP password (tampered data or wrong key).");
  }
}
