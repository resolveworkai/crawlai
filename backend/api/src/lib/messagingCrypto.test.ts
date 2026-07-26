/** Authored by: Mohit Singh */
import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// A valid 32-byte key as 64 hex chars.
const KEY = crypto.randomBytes(32).toString("hex");

// messagingCrypto reads process.env.MESSAGING_ENCRYPTION_KEY at call time, so set it per-test.
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.MESSAGING_ENCRYPTION_KEY;
});
afterEach(() => {
  if (saved === undefined) delete process.env.MESSAGING_ENCRYPTION_KEY;
  else process.env.MESSAGING_ENCRYPTION_KEY = saved;
});

async function load() {
  // Fresh import each time is unnecessary — the module reads env lazily, not at import — so a
  // single import is fine across tests.
  return import("./messagingCrypto.js");
}

describe("messagingCrypto", () => {
  it("round-trips a secret with a valid key", async () => {
    process.env.MESSAGING_ENCRYPTION_KEY = KEY;
    const { encryptSecret, decryptSecret, isEncryptionAvailable } = await load();
    expect(isEncryptionAvailable()).toBe(true);

    const secret = "smtp-app-password-123!";
    const envelope = encryptSecret(secret);
    expect(envelope).toMatch(/^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(envelope).not.toContain(secret); // ciphertext, not plaintext
    expect(decryptSecret(envelope)).toBe(secret);
  });

  it("produces a different envelope each time (random IV) for the same plaintext", async () => {
    process.env.MESSAGING_ENCRYPTION_KEY = KEY;
    const { encryptSecret } = await load();
    expect(encryptSecret("same")).not.toBe(encryptSecret("same"));
  });

  it("reports unavailable and refuses to encrypt without a key", async () => {
    delete process.env.MESSAGING_ENCRYPTION_KEY;
    const { encryptSecret, isEncryptionAvailable } = await load();
    expect(isEncryptionAvailable()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(/MESSAGING_ENCRYPTION_KEY is not configured/);
  });

  it("reports unavailable for a wrong-length key", async () => {
    process.env.MESSAGING_ENCRYPTION_KEY = "abcd"; // 2 bytes, not 32
    const { isEncryptionAvailable } = await load();
    expect(isEncryptionAvailable()).toBe(false);
  });

  it("fails to decrypt a tampered envelope (GCM auth tag)", async () => {
    process.env.MESSAGING_ENCRYPTION_KEY = KEY;
    const { encryptSecret, decryptSecret } = await load();
    const envelope = encryptSecret("secret");
    const parts = envelope.split(":");
    // Flip a byte in the ciphertext.
    const data = parts[3]!;
    parts[3] = (data[0] === "a" ? "b" : "a") + data.slice(1);
    expect(() => decryptSecret(parts.join(":"))).toThrow(/Failed to decrypt/);
  });

  it("rejects a malformed envelope", async () => {
    process.env.MESSAGING_ENCRYPTION_KEY = KEY;
    const { decryptSecret } = await load();
    expect(() => decryptSecret("not-an-envelope")).toThrow(/Malformed/);
  });
});
