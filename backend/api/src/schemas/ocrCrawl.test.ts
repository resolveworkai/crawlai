/** Authored by: Mohit Singh */
import { describe, expect, it } from "vitest";
import { createOcrJobSchema } from "./ocrCrawl.js";

const base = { query: "gym", location: "Dubai" };

describe("createOcrJobSchema radius bounds", () => {
  it("accepts a radius up to the 300km ceiling (matches capture.py's MAX_GRID_CELLS safety)", () => {
    const result = createOcrJobSchema.safeParse({
      ...base,
      centerLat: 25.2048,
      centerLng: 55.2708,
      radiusKm: 300,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a radius above the old 100km cap (was the original ceiling before it was raised)", () => {
    const result = createOcrJobSchema.safeParse({
      ...base,
      centerLat: 25.2048,
      centerLng: 55.2708,
      radiusKm: 150,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a radius past the 300km ceiling", () => {
    const result = createOcrJobSchema.safeParse({
      ...base,
      centerLat: 25.2048,
      centerLng: 55.2708,
      radiusKm: 301,
    });
    expect(result.success).toBe(false);
  });

  it("rejects radiusKm without a center point", () => {
    const result = createOcrJobSchema.safeParse({ ...base, radiusKm: 5 });
    expect(result.success).toBe(false);
  });

  it("rejects centerLat without centerLng", () => {
    const result = createOcrJobSchema.safeParse({ ...base, centerLat: 25.2048 });
    expect(result.success).toBe(false);
  });

  it("accepts a job with no geo fields at all (plain text search, unchanged behavior)", () => {
    const result = createOcrJobSchema.safeParse(base);
    expect(result.success).toBe(true);
  });
});
