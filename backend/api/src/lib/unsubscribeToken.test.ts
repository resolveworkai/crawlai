/** Authored by: Mohit Singh */
import { describe, expect, it } from "vitest";
import { makeUnsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from "./unsubscribeToken.js";

describe("unsubscribeToken", () => {
  it("verifies a token it produced (case/space-insensitive on email)", () => {
    const token = makeUnsubscribeToken("Info@Gym.com");
    expect(verifyUnsubscribeToken("info@gym.com", token)).toBe(true);
    expect(verifyUnsubscribeToken("  INFO@GYM.COM ", token)).toBe(true);
  });

  it("rejects a forged or mismatched token", () => {
    const token = makeUnsubscribeToken("a@x.com");
    expect(verifyUnsubscribeToken("b@x.com", token)).toBe(false);
    expect(verifyUnsubscribeToken("a@x.com", "deadbeef")).toBe(false);
    expect(verifyUnsubscribeToken("a@x.com", "not-hex-zzzz")).toBe(false);
  });

  it("builds an absolute unsubscribe URL carrying the email + token", () => {
    const url = unsubscribeUrl("a@x.com");
    expect(url).toMatch(/\/unsubscribe\?email=a%40x\.com&token=[0-9a-f]{64}$/);
  });
});
