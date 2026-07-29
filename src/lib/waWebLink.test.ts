/** Authored by: Mohit Singh */
import { describe, expect, it } from "vitest";
import { toWebWhatsAppUrl } from "./waWebLink";

describe("toWebWhatsAppUrl", () => {
  it("converts a wa.me link to the equivalent web.whatsapp.com send URL", () => {
    const waLink = `https://wa.me/919999999999?text=${encodeURIComponent("Hi there!")}`;
    expect(toWebWhatsAppUrl(waLink)).toBe(
      `https://web.whatsapp.com/send?phone=919999999999&text=${encodeURIComponent("Hi there!")}`,
    );
  });

  it("round-trips text containing a bare % without throwing (the double-decode regression)", () => {
    const text = "Grow bookings by 100% — 30% off enterprise for the first 100 businesses.";
    const waLink = `https://wa.me/918000000000?text=${encodeURIComponent(text)}`;
    expect(() => toWebWhatsAppUrl(waLink)).not.toThrow();
    const result = toWebWhatsAppUrl(waLink);
    expect(result).toBe(
      `https://web.whatsapp.com/send?phone=918000000000&text=${encodeURIComponent(text)}`,
    );
    // Decoding the produced URL's text param should reproduce the original message exactly.
    expect(new URL(result).searchParams.get("text")).toBe(text);
  });

  it("preserves multi-line message bodies", () => {
    const text = "Line one\nLine two\n\nLine four";
    const waLink = `https://wa.me/917000000000?text=${encodeURIComponent(text)}`;
    expect(new URL(toWebWhatsAppUrl(waLink)).searchParams.get("text")).toBe(text);
  });
});
