/** Authored by: Mohit Singh */
import { describe, expect, it } from "vitest";
import { parseBuildingAgeTable } from "./buildingAgeTableParser.js";

describe("parseBuildingAgeTable", () => {
  it("parses a tab-separated exact-year row", () => {
    const entries = parseBuildingAgeTable("1\tAmal Tower\t2025\t1 yr");
    expect(entries).toEqual([{ buildingName: "Amal Tower", completionYear: 2025, isEstimated: false }]);
  });

  it("parses a starred (estimated) year", () => {
    const entries = parseBuildingAgeTable("10\tBinghatti Haven\t2025*\t~1 yr");
    expect(entries).toEqual([
      { buildingName: "Binghatti Haven", completionYear: 2025, isEstimated: true },
    ]);
  });

  it("parses a year-range row, taking the first year and marking it estimated", () => {
    const entries = parseBuildingAgeTable("77\tRoyal Residence 2\t2015/16*\t~10-11 yrs");
    expect(entries).toEqual([
      { buildingName: "Royal Residence 2", completionYear: 2015, isEstimated: true },
    ]);
  });

  it("parses an N/V row as an unknown, non-estimated completion year", () => {
    const entries = parseBuildingAgeTable("1\tAcademic Residence\tN/V\t-");
    expect(entries).toEqual([
      { buildingName: "Academic Residence", completionYear: null, isEstimated: false },
    ]);
  });

  it("parses a future completion year (off-plan / not-yet-built) the same as any other year", () => {
    const entries = parseBuildingAgeTable("2\tAll Seasons Residence\t2027*\tNew");
    expect(entries).toEqual([
      { buildingName: "All Seasons Residence", completionYear: 2027, isEstimated: true },
    ]);
  });

  it("skips a header/title line with no recognizable year token", () => {
    const entries = parseBuildingAgeTable(
      "Dubai Sports City - Residential Buildings A-Z\n# Building Completion Age",
    );
    expect(entries).toEqual([]);
  });

  it("skips blank lines between real rows", () => {
    const entries = parseBuildingAgeTable("1\tAmal Tower\t2025\t1 yr\n\n2\tHera Tower\t2022\t4 yrs");
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.buildingName)).toEqual(["Amal Tower", "Hera Tower"]);
  });

  it("falls back to the regex parser for space-aligned (non-tab) text", () => {
    const entries = parseBuildingAgeTable("5 Arena Apartments 2015 11 yrs");
    expect(entries).toEqual([
      { buildingName: "Arena Apartments", completionYear: 2015, isEstimated: false },
    ]);
  });

  it("parses the real Dubai Sports City sample end-to-end without dropping any real row", () => {
    const raw = [
      "1\tAcademic Residence\tN/V\t-",
      "2\tAll Seasons Residence\t2027*\tNew",
      "3\tAmal Tower\t2025\t1 yr",
      "5\tArena Apartments\t2015\t11 yrs",
      "28\tDiamond Tower / The Diamond\t2009\t17 yrs",
      "49\tGolf Tower\t2010\t16 yrs",
      "89\tThe Golf Tower\t2010\t16 yrs",
      "104\tVista by Prestige One\t2025/26*\t~0-1 yr",
      "107\tZenith Tower A1\t2017\t9 yrs",
    ].join("\n");
    const entries = parseBuildingAgeTable(raw);
    expect(entries).toHaveLength(9);
    // "Golf Tower" and "The Golf Tower" are both real, distinct entries — the parser must not
    // collapse or confuse them (that distinction matters for the longest-match-wins logic in
    // db/propertyBuildingAges.ts's BuildingAgeMatcher).
    expect(entries.map((e) => e.buildingName)).toContain("Golf Tower");
    expect(entries.map((e) => e.buildingName)).toContain("The Golf Tower");
    const diamond = entries.find((e) => e.buildingName === "Diamond Tower / The Diamond");
    expect(diamond).toEqual({
      buildingName: "Diamond Tower / The Diamond",
      completionYear: 2009,
      isEstimated: false,
    });
  });
});
