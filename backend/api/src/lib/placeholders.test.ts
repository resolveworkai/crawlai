/** Authored by: Mohit Singh */
import { describe, expect, it } from "vitest";
import { recipientToPlaceholders, renderPlaceholders } from "./placeholders.js";
import type { Recipient } from "./recipientParse.js";

const rec: Recipient = {
  businessName: "Flow Fitness Gym",
  businessType: "Gym",
  location: "Al Nahda, Dubai",
  phone: "+971585325771",
  email: "hi@flow.com",
};

describe("placeholders", () => {
  it("derives {city} from the first part of location", () => {
    expect(recipientToPlaceholders(rec).city).toBe("Al Nahda");
  });

  it("substitutes every supported token", () => {
    const out = renderPlaceholders(
      "{business_name} ({business_type}) in {location} / {city}",
      recipientToPlaceholders(rec),
    );
    expect(out).toBe("Flow Fitness Gym (Gym) in Al Nahda, Dubai / Al Nahda");
  });

  it("leaves unknown tokens untouched and blanks missing values", () => {
    const bare: Recipient = { ...rec, businessType: null, location: null };
    const out = renderPlaceholders("{business_type}|{unknown}|{city}", recipientToPlaceholders(bare));
    expect(out).toBe("|{unknown}|");
  });
});
