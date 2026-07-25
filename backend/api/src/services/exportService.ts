/** Authored by: Mohit Singh */
//
// Phase 7 — generates xlsx/csv/json exports of the master businesses DB, respecting the
// caller's current filters. Every writer streams (batched DB reads + a file write stream) so a
// large export never materializes the whole result set in memory — see
// md/plans/0001-*.md "Phase 7" and .claude/skills/skills_backend_node.md.
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { config } from "../config.js";
import { listBusinessesFiltered, type BusinessFilters } from "../db/businesses.js";
import { createExportRecord, deleteExpiredExports, findExportById } from "../db/exports.js";
import { NotFoundError } from "../errors.js";
import { FLAT_EXPORT_HEADERS, toFlatRow, toNestedJson } from "../lib/businessExport.js";
import type { ExportFormat, ExportRecord } from "../types/db.js";
import type { Business } from "../types/db.js";

export const EXPORT_BATCH_SIZE = 500;
// Exported so tests can construct a realistic multi-batch scenario (a page shorter than this is
// the pagination loop's "no more rows" signal — see iterateAllMatching below).
const BATCH_SIZE = EXPORT_BATCH_SIZE;
const MAX_EXPORT_ROWS = 100_000;
// A sanity ceiling, not a real-world limit — protects against a runaway export if filters are
// accidentally too broad; narrow the filters to get everything past this in practice.

export type ExportFilters = Omit<BusinessFilters, "limit" | "offset">;

const FORMAT_EXTENSIONS: Record<ExportFormat, string> = { xlsx: "xlsx", csv: "csv", json: "json" };

async function* iterateAllMatching(filters: ExportFilters): AsyncGenerator<Business> {
  let offset = 0;
  let yielded = 0;
  for (;;) {
    const { businesses } = await listBusinessesFiltered({
      ...filters,
      limit: BATCH_SIZE,
      offset,
    });
    for (const business of businesses) {
      yield business;
      yielded += 1;
      if (yielded >= MAX_EXPORT_ROWS) return;
    }
    // Advance by the number of rows actually returned, not BATCH_SIZE — a page shorter than
    // BATCH_SIZE is the natural "no more rows" signal for LIMIT/OFFSET pagination; relying on
    // `total` instead would wrongly stop early if a page ever returns fewer rows than requested
    // while more still remain (e.g. a row deleted between batches shifting the offset window).
    if (businesses.length < BATCH_SIZE) return;
    offset += businesses.length;
  }
}

function csvEscape(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

async function endStream(stream: ReturnType<typeof createWriteStream>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()));
  });
}

async function writeCsv(filePath: string, filters: ExportFilters): Promise<number> {
  const stream = createWriteStream(filePath, { encoding: "utf-8" });
  stream.write(FLAT_EXPORT_HEADERS.map(csvEscape).join(",") + "\n");
  let rowCount = 0;
  for await (const business of iterateAllMatching(filters)) {
    const row = toFlatRow(business);
    stream.write(FLAT_EXPORT_HEADERS.map((h) => csvEscape(row[h])).join(",") + "\n");
    rowCount += 1;
  }
  await endStream(stream);
  return rowCount;
}

async function writeXlsx(filePath: string, filters: ExportFilters): Promise<number> {
  // ExcelJS's streaming WorkbookWriter writes rows to disk as they're added rather than
  // building the whole workbook in memory — the streaming half of "streamed for large sets".
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: filePath,
    useStyles: false,
    useSharedStrings: false,
  });
  const sheet = workbook.addWorksheet("Businesses");
  sheet.columns = FLAT_EXPORT_HEADERS.map((header) => ({ header, key: header }));
  let rowCount = 0;
  for await (const business of iterateAllMatching(filters)) {
    sheet.addRow(toFlatRow(business)).commit();
    rowCount += 1;
  }
  sheet.commit();
  await workbook.commit();
  return rowCount;
}

async function writeJson(filePath: string, filters: ExportFilters): Promise<number> {
  const stream = createWriteStream(filePath, { encoding: "utf-8" });
  stream.write("[");
  let rowCount = 0;
  for await (const business of iterateAllMatching(filters)) {
    if (rowCount > 0) stream.write(",");
    stream.write(JSON.stringify(toNestedJson(business)));
    rowCount += 1;
  }
  stream.write("]");
  await endStream(stream);
  return rowCount;
}

export async function generateExport(input: {
  format: ExportFormat;
  filters: ExportFilters;
  createdBy?: string | null;
}): Promise<ExportRecord> {
  await mkdir(config.EXPORTS_DIR, { recursive: true });

  const id = randomUUID();
  const datePart = new Date().toISOString().slice(0, 10);
  const filename = `businesses-${datePart}-${id.slice(0, 8)}.${FORMAT_EXTENSIONS[input.format]}`;
  const filePath = path.join(config.EXPORTS_DIR, filename);

  const rowCount =
    input.format === "csv"
      ? await writeCsv(filePath, input.filters)
      : input.format === "xlsx"
        ? await writeXlsx(filePath, input.filters)
        : await writeJson(filePath, input.filters);

  const fileStats = await stat(filePath);
  const expiresAt = new Date(Date.now() + config.EXPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  return createExportRecord({
    createdBy: input.createdBy ?? null,
    format: input.format,
    filename,
    rowCount,
    sizeBytes: fileStats.size,
    filterSnapshot: input.filters,
    storagePath: filePath,
    expiresAt,
  });
}

export async function getExportForDownload(id: string): Promise<ExportRecord> {
  const record = await findExportById(id);
  if (!record) throw new NotFoundError("Export not found");
  return record;
}

// Phase 7's retention-cleanup job — deletes both the DB row and the file for every export past
// its expires_at. Best-effort on the file unlink: a row whose file is already gone (manually
// removed, volume reset) must not block the DB row from being cleaned up too.
export async function cleanupExpiredExports(): Promise<number> {
  const expired = await deleteExpiredExports();
  await Promise.all(expired.map((record) => unlink(record.storage_path).catch(() => undefined)));
  return expired.length;
}
