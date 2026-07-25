/** Authored by: Mohit Singh */
//
// Pure unit tests — db/ocrBusinesses.ts is mocked; the CSV/XLSX writers run for real (exceljs)
// so this proves the output is well-formed, not just that mocks were called.
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OcrBusiness } from "../types/db.js";

const listOcrBusinesses = vi.fn();
vi.mock("../db/ocrBusinesses.js", () => ({
  listOcrBusinesses: (...args: unknown[]) => listOcrBusinesses(...args),
}));

const { buildOcrExport } = await import("./ocrExportService.js");

function biz(overrides: Partial<OcrBusiness> = {}): OcrBusiness {
  return {
    id: "b1",
    job_id: "j1",
    idx: 1,
    name: "XFit Gym, Mamzar",
    maps_url: "https://maps/x",
    rating: 4.9,
    review_count: 140,
    category: "Gym",
    address: "Onyx Tower, Dubai",
    phone: "+971585315770",
    website: "xfitgym.ae",
    plus_code: "79M4+3F",
    hours_summary: "Open 24 hours",
    hours_weekly: null,
    email: null,
    image_url: null,
    lat: null,
    lng: null,
    distance_km: null,
    ocr_confidence: 95,
    needs_review: false,
    raw_text: "",
    source_images: [],
    created_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("buildOcrExport csv", () => {
  it("writes a header + one row, escaping the comma in the name", async () => {
    listOcrBusinesses.mockResolvedValue([biz()]);
    const file = await buildOcrExport("j1", "csv");
    expect(file.extension).toBe("csv");
    const text = file.buffer.toString("utf-8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Name");
    expect(lines[1]).toContain('"XFit Gym, Mamzar"'); // comma-quoted
    expect(lines[1]).toContain("+971585315770");
  });

  it("marks needs_review rows and blanks nulls", async () => {
    listOcrBusinesses.mockResolvedValue([biz({ rating: null, needs_review: true, name: "A" })]);
    const text = (await buildOcrExport("j1", "csv")).buffer.toString("utf-8");
    const row = text.trim().split("\n")[1];
    expect(row).toContain("yes"); // needs_review column
  });
});

describe("buildOcrExport xlsx", () => {
  it("writes a real, readable workbook", async () => {
    listOcrBusinesses.mockResolvedValue([biz()]);
    const file = await buildOcrExport("j1", "xlsx");
    expect(file.extension).toBe("xlsx");

    const wb = new ExcelJS.Workbook();
    // exceljs's load() types predate Node's Buffer<ArrayBufferLike> generic — cast to satisfy tsc.
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("OCR Businesses");
    expect(sheet).toBeDefined();
    expect(sheet?.getRow(1).getCell(2).value).toBe("Name");
    expect(sheet?.getRow(2).getCell(2).value).toBe("XFit Gym, Mamzar");
  });
});
