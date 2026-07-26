/** Authored by: Mohit Singh */
import { describe, expect, it } from "vitest";
import { buildVcard, buildWaLink, waNumber } from "./whatsappService.js";
import type { Recipient } from "../lib/recipientParse.js";

const r = (over: Partial<Recipient>): Recipient => ({
  businessName: "Bajrang Fitness",
  businessType: "Gym",
  location: "Haldwani, Uttarakhand",
  phone: "+918445588806",
  email: null,
  ...over,
});

describe("waNumber", () => {
  it("strips + and leading zeros to a dialable number", () => {
    expect(waNumber("+91 84455 88806")).toBe("918445588806");
    expect(waNumber("008445588806")).toBe("8445588806");
  });
  it("returns null for no/too-short phone", () => {
    expect(waNumber(null)).toBeNull();
    expect(waNumber("123")).toBeNull();
  });
});

describe("buildWaLink", () => {
  it("builds a wa.me link with the placeholder-substituted, url-encoded message", () => {
    const link = buildWaLink(r({}), "Hi {business_name} in {city}! Join our portal.");
    expect(link).toBe(
      "https://wa.me/918445588806?text=" +
        encodeURIComponent("Hi Bajrang Fitness in Haldwani! Join our portal."),
    );
  });
  it("returns null when there's no usable phone", () => {
    expect(buildWaLink(r({ phone: null }), "hi")).toBeNull();
  });
});

describe("buildVcard", () => {
  it("emits one importable VCARD per business with a phone, named by business", () => {
    const vcf = buildVcard([r({}), r({ businessName: "Flow; Fitness", phone: "+919286836869" })]);
    expect(vcf).toContain("BEGIN:VCARD");
    expect(vcf).toContain("FN:Bajrang Fitness");
    expect(vcf).toContain("TEL;TYPE=CELL:+918445588806");
    expect(vcf).toContain("ORG:Gym");
    // vCard escaping: the semicolon in the name is escaped.
    expect(vcf).toContain("FN:Flow\\; Fitness");
    expect(vcf.match(/BEGIN:VCARD/g)).toHaveLength(2);
  });
  it("skips businesses with no phone (nothing to save as a WhatsApp contact)", () => {
    const vcf = buildVcard([r({ phone: null })]);
    expect(vcf.trim()).toBe("");
  });
});
