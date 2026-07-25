/** Authored by: Mohit Singh */
//
// Pure unit tests — db/businesses.ts and db/exports.ts are mocked, but the file writers
// (CSV/XLSX/JSON) run for real against a temp directory, so this genuinely proves the output is
// well-formed, not just that the mocks were called correctly.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Business } from "../types/db.js";

const listBusinessesFiltered = vi.fn();
const createExportRecord = vi.fn();
const deleteExpiredExports = vi.fn();
const findExportById = vi.fn();

vi.mock("../db/businesses.js", () => ({
  listBusinessesFiltered: (...args: unknown[]) => listBusinessesFiltered(...args),
}));
vi.mock("../db/exports.js", () => ({
  createExportRecord: (...args: unknown[]) => createExportRecord(...args),
  deleteExpiredExports: (...args: unknown[]) => deleteExpiredExports(...args),
  findExportById: (...args: unknown[]) => findExportById(...args),
}));

let tmpDir: string;

vi.mock("../config.js", async () => {
  return {
    get config() {
      return {
        EXPORTS_DIR: tmpDir,
        EXPORT_RETENTION_DAYS: 7,
      };
    },
  };
});

const { generateExport, cleanupExpiredExports, getExportForDownload, EXPORT_BATCH_SIZE } =
  await import("./exportService.js");

function business(overrides: Partial<Business> = {}): Business {
  return {
    id: "biz-1",
    name: "Test Gym",
    sub_name: null,
    category: "gym",
    address_line1: "1 Main St",
    address_line2: null,
    area: null,
    city: "Berlin",
    state: null,
    country: "Germany",
    postal_code: null,
    latitude: 52.5,
    longitude: 13.4,
    email: "hello@testgym.example",
    emails: ["hello@testgym.example", "info@testgym.example"],
    phone: "+491234567",
    phones: ["+491234567"],
    website_url: "https://testgym.example",
    about_text: "A gym, comma, in Berlin",
    google_rating: null,
    review_count: null,
    review_url: null,
    opening_hours: { mon: [{ open: "08:00", close: "20:00" }] },
    enrichment_status: "enriched",
    extras: { founded_year: "2015" },
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  } as Business;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "export-test-"));
  vi.clearAllMocks();
  // Mirrors the real createExportRecord's camelCase-in / snake_case-out shape (db/exports.ts's
  // `RETURNING *` returns the actual Postgres column names).
  createExportRecord.mockImplementation(async (input: Record<string, unknown>) => ({
    id: "export-1",
    created_by: input.createdBy ?? null,
    format: input.format,
    filename: input.filename,
    row_count: input.rowCount,
    size_bytes: input.sizeBytes,
    filter_snapshot: input.filterSnapshot,
    storage_path: input.storagePath,
    created_at: new Date(),
    expires_at: input.expiresAt ?? null,
  }));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("generateExport (csv)", () => {
  it("writes a header row and one row per business, escaping commas", async () => {
    listBusinessesFiltered
      .mockResolvedValueOnce({ businesses: [business()], total: 1 })
      .mockResolvedValue({ businesses: [], total: 1 });

    const record = await generateExport({ format: "csv", filters: {} });

    expect(record.row_count).toBe(1);
    const content = await readFile(record.storage_path as string, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Name");
    expect(lines[1]).toContain('"A gym, comma, in Berlin"');
    expect(lines[1]).toContain("Test Gym");
  });

  it("handles zero matching businesses (header only)", async () => {
    listBusinessesFiltered.mockResolvedValue({ businesses: [], total: 0 });

    const record = await generateExport({ format: "csv", filters: {} });

    expect(record.row_count).toBe(0);
    const content = await readFile(record.storage_path as string, "utf-8");
    expect(content.trim().split("\n")).toHaveLength(1); // header row only
  });
});

describe("generateExport (json)", () => {
  it("writes a valid, structured JSON array including nested extras/openingHours", async () => {
    listBusinessesFiltered
      .mockResolvedValueOnce({ businesses: [business()], total: 1 })
      .mockResolvedValue({ businesses: [], total: 1 });

    const record = await generateExport({ format: "json", filters: {} });

    const content = await readFile(record.storage_path as string, "utf-8");
    const parsed = JSON.parse(content) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe("Test Gym");
    expect(parsed[0]?.extras).toEqual({ founded_year: "2015" });
    expect(parsed[0]?.contact).toMatchObject({
      emails: ["hello@testgym.example", "info@testgym.example"],
    });
  });

  it("writes an empty array for zero matches", async () => {
    listBusinessesFiltered.mockResolvedValue({ businesses: [], total: 0 });

    const record = await generateExport({ format: "json", filters: {} });

    const content = await readFile(record.storage_path as string, "utf-8");
    expect(JSON.parse(content)).toEqual([]);
    expect(record.row_count).toBe(0);
  });
});

describe("generateExport (xlsx)", () => {
  it("writes a real, readable workbook with a header + one data row", async () => {
    listBusinessesFiltered
      .mockResolvedValueOnce({ businesses: [business()], total: 1 })
      .mockResolvedValue({ businesses: [], total: 1 });

    const record = await generateExport({ format: "xlsx", filters: {} });
    expect(record.row_count).toBe(1);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(record.storage_path as string);
    const sheet = workbook.getWorksheet("Businesses");
    expect(sheet).toBeDefined();
    expect(sheet?.getRow(1).getCell(1).value).toBe("Name");
    expect(sheet?.getRow(2).getCell(1).value).toBe("Test Gym");
  });
});

describe("generateExport pagination across batches", () => {
  it("iterates multiple pages until a short (final) page is returned", async () => {
    // A full-sized first page is the loop's signal that more rows might exist — it must fetch
    // a second page. That second page is shorter than EXPORT_BATCH_SIZE, which is what actually
    // ends the loop (real LIMIT/OFFSET pagination: a short page always means "no more rows").
    const total = EXPORT_BATCH_SIZE + 2;
    const page1 = Array.from({ length: EXPORT_BATCH_SIZE }, (_, i) => business({ id: `b-${i}` }));
    const page2 = Array.from({ length: 2 }, (_, i) =>
      business({ id: `b-${i + EXPORT_BATCH_SIZE}` }),
    );
    listBusinessesFiltered
      .mockResolvedValueOnce({ businesses: page1, total })
      .mockResolvedValueOnce({ businesses: page2, total });

    const record = await generateExport({ format: "json", filters: {} });

    expect(record.row_count).toBe(total);
    expect(listBusinessesFiltered).toHaveBeenCalledTimes(2);
  });
});

describe("getExportForDownload", () => {
  it("throws NotFoundError when the export doesn't exist", async () => {
    findExportById.mockResolvedValue(null);
    await expect(getExportForDownload("missing")).rejects.toThrow("Export not found");
  });

  it("returns the record when found", async () => {
    const record = { id: "export-1", storage_path: "/x", filename: "x.csv" };
    findExportById.mockResolvedValue(record);
    await expect(getExportForDownload("export-1")).resolves.toBe(record);
  });
});

describe("cleanupExpiredExports", () => {
  it("deletes files for every expired row and returns the count", async () => {
    const filePath = path.join(tmpDir, "expired.csv");
    await import("node:fs/promises").then((fs) => fs.writeFile(filePath, "x"));
    deleteExpiredExports.mockResolvedValue([{ id: "e1", storage_path: filePath }]);

    const count = await cleanupExpiredExports();

    expect(count).toBe(1);
    await expect(readFile(filePath)).rejects.toThrow();
  });

  it("does not throw when the file is already missing", async () => {
    deleteExpiredExports.mockResolvedValue([
      { id: "e1", storage_path: path.join(tmpDir, "already-gone.csv") },
    ]);

    await expect(cleanupExpiredExports()).resolves.toBe(1);
  });
});
