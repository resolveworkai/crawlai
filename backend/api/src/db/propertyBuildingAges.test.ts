/** Authored by: Mohit Singh */
import { describe, expect, it, vi } from "vitest";
import { BuildingAgeMatcher } from "./propertyBuildingAges.js";
import type { PropertyBuildingAge, PropertyListing } from "../types/db.js";

function row(overrides: Partial<PropertyBuildingAge>): PropertyBuildingAge {
  return {
    id: "00000000-0000-0000-0000-000000000000",
    region: "Dubai Sports City",
    building_name: "Test Tower",
    completion_year: 2015,
    is_estimated: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe("BuildingAgeMatcher", () => {
  it("matches a listing whose title contains the building name", () => {
    const matcher = new BuildingAgeMatcher([
      row({ building_name: "Elite Sports Residence 9", completion_year: 2017 }),
    ]);
    const result = matcher.match(
      "Elite Sports Residence 9, Elite Sports Residence, Dubai Sports City, Dubai",
      "dubai sports city",
    );
    expect(result.mapped_building_name).toBe("Elite Sports Residence 9");
    expect(result.mapped_age_years).toBe(new Date().getFullYear() - 2017);
  });

  it("prefers the longest matching building name over a shorter substring match", () => {
    const matcher = new BuildingAgeMatcher([
      row({ building_name: "Golf Tower", completion_year: 2010 }),
      row({ building_name: "The Golf Tower", completion_year: 2011 }),
    ]);
    const result = matcher.match("The Golf Tower, Dubai Sports City, Dubai", "dubai sports city");
    expect(result.mapped_building_name).toBe("The Golf Tower");
  });

  it("returns no match when nothing in the title matches any known building", () => {
    const matcher = new BuildingAgeMatcher([row({ building_name: "Elite Sports Residence 9" })]);
    const result = matcher.match("Some Unrelated Tower, JVC, Dubai", "jvc");
    expect(result.mapped_building_name).toBeNull();
    expect(result.mapped_age_years).toBeNull();
  });

  it("prefers a region-scoped match over a name-only match from a different region", () => {
    const matcher = new BuildingAgeMatcher([
      row({ region: "JVC", building_name: "Tower One", completion_year: 2020 }),
      row({ region: "Dubai Sports City", building_name: "Tower One", completion_year: 2010 }),
    ]);
    const result = matcher.match("Tower One, Dubai Sports City, Dubai", "dubai sports city");
    expect(result.mapped_age_years).toBe(new Date().getFullYear() - 2010);
  });

  it("computes a future/this-year completion as age 0, never negative", () => {
    const nextYear = new Date().getFullYear() + 1;
    const matcher = new BuildingAgeMatcher([
      row({ building_name: "Upcoming Tower", completion_year: nextYear }),
    ]);
    const result = matcher.match("Upcoming Tower, Dubai Sports City", "dubai sports city");
    expect(result.mapped_age_years).toBe(0);
  });

  it("returns a null age (not 0) when the reference row's completion year is unknown", () => {
    const matcher = new BuildingAgeMatcher([
      row({ building_name: "Academic Residence", completion_year: null }),
    ]);
    const result = matcher.match("Academic Residence, Dubai Sports City", "dubai sports city");
    expect(result.mapped_building_name).toBe("Academic Residence");
    expect(result.mapped_age_years).toBeNull();
  });

  it("carries the is_estimated flag through to the match result", () => {
    const matcher = new BuildingAgeMatcher([
      row({ building_name: "Binghatti Haven", completion_year: 2025, is_estimated: true }),
    ]);
    const result = matcher.match("Binghatti Haven, Dubai Sports City", "dubai sports city");
    expect(result.mapped_age_is_estimated).toBe(true);
  });

  it("falls back to a global name-only match when no region-scoped candidate matches", () => {
    const matcher = new BuildingAgeMatcher([
      row({ region: "Some Other Area", building_name: "Cross Region Tower", completion_year: 2018 }),
    ]);
    // regionHint doesn't mention "Some Other Area" at all, but the building name still matches.
    const result = matcher.match("Cross Region Tower listing", "an unrelated hint");
    expect(result.mapped_building_name).toBe("Cross Region Tower");
  });
});

describe("attachMappedAges (via a minimal fake matcher path)", () => {
  it("never overrides a listing's own real age_years with a mapped one", async () => {
    vi.resetModules();
    vi.doMock("./pool.js", () => ({
      pool: { query: vi.fn().mockResolvedValue({ rows: [] }) },
    }));
    const { attachMappedAges } = await import("./propertyBuildingAges.js");
    const listing = {
      id: "1",
      job_id: "job-1",
      title: "Elite Sports Residence 9",
      community: null,
      location_text: null,
      age_years: 9,
    } as unknown as PropertyListing;
    const results = await attachMappedAges([listing]);
    const result = results[0];
    expect(result).toBeDefined();
    expect(result?.mapped_age_years).toBeNull();
    expect(result?.mapped_building_name).toBeNull();
  });
});
