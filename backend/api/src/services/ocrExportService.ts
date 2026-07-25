/** Authored by: Mohit Singh */
//
// CSV/XLSX export for a Crawl-OCR job's parsed rows. Result sets are small (a capped single
// Maps search), so this builds in memory rather than streaming (unlike the big businesses
// export). xlsx via exceljs — never the vulnerable `xlsx`/SheetJS npm package (see
// skills_backend_node.md).
import ExcelJS from "exceljs";
import { listOcrBusinesses } from "../db/ocrBusinesses.js";
import type { OcrBusiness } from "../types/db.js";

const HEADERS = [
  "#",
  "Name",
  "Rating",
  "Reviews",
  "Category",
  "Address",
  "Phone",
  "Website",
  "Plus Code",
  "Hours",
  "Email",
  "Image URL",
  "Maps URL",
  "Needs Review",
] as const;

function toRow(b: OcrBusiness): (string | number | null)[] {
  return [
    b.idx,
    b.name,
    b.rating,
    b.review_count,
    b.category,
    b.address,
    b.phone,
    b.website,
    b.plus_code,
    b.hours_summary,
    b.email,
    b.image_url,
    b.maps_url,
    b.needs_review ? "yes" : "",
  ];
}

function csvEscape(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

export interface OcrExportFile {
  buffer: Buffer;
  contentType: string;
  extension: "csv" | "xlsx";
}

export async function buildOcrExport(
  jobId: string,
  format: "csv" | "xlsx",
): Promise<OcrExportFile> {
  const rows = await listOcrBusinesses(jobId);

  if (format === "csv") {
    const lines = [HEADERS.map(csvEscape).join(",")];
    for (const b of rows) lines.push(toRow(b).map(csvEscape).join(","));
    return {
      buffer: Buffer.from(lines.join("\n"), "utf-8"),
      contentType: "text/csv; charset=utf-8",
      extension: "csv",
    };
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("OCR Businesses");
  sheet.addRow(HEADERS as unknown as string[]);
  for (const b of rows) sheet.addRow(toRow(b));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  };
}
