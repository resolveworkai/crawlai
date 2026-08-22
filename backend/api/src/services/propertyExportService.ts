/** Authored by: Mohit Singh */
//
// CSV/XLSX/JSON export for a Property Research job's ranked listings. Result sets are small
// (a capped single search), so this builds in memory rather than streaming — mirrors
// ecomExportService.ts. xlsx via exceljs — never the vulnerable `xlsx`/SheetJS npm package (see
// skills_backend_node.md).
import ExcelJS from "exceljs";
import { findPropertyJobById } from "../db/propertyJobs.js";
import { listPropertyListings } from "../db/propertyListings.js";
import type { PropertyJob, PropertyListing } from "../types/db.js";
import { NotFoundError } from "../errors.js";

const HEADERS = [
  "Rank",
  "Distress Score",
  "Platform",
  "Title",
  "Price",
  "Currency",
  "Area (sqft)",
  "Price/sqft",
  "Bedrooms",
  "Bathrooms",
  "Property Type",
  "Community",
  "Listed Days Ago",
  "Verified",
  "Distress Keywords",
  "Agent",
  "Phone",
  "WhatsApp Link",
  "Listing URL",
  "First Photo URL",
  "Needs Review",
] as const;

function toRow(job: PropertyJob, l: PropertyListing, rank: number): (string | number | null)[] {
  return [
    rank,
    l.distress_score,
    job.platform,
    l.title,
    l.price,
    l.currency,
    l.area_sqft,
    l.price_per_sqft,
    l.bedrooms,
    l.bathrooms,
    l.property_type,
    l.community ?? l.location_text,
    l.listed_days_ago,
    l.verified ? "yes" : "",
    Array.isArray(l.distress_keywords) ? l.distress_keywords.join("; ") : "",
    l.agent_name,
    l.phone_number,
    l.whatsapp_link,
    l.listing_url,
    Array.isArray(l.image_urls) ? (l.image_urls[0] ?? null) : null,
    l.needs_review ? "yes" : "",
  ];
}

function csvEscape(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toJsonRow(job: PropertyJob, l: PropertyListing, rank: number): Record<string, unknown> {
  return {
    rank,
    distressScore: l.distress_score,
    platform: job.platform,
    title: l.title,
    price: l.price,
    currency: l.currency,
    areaSqft: l.area_sqft,
    pricePerSqft: l.price_per_sqft,
    bedrooms: l.bedrooms,
    bathrooms: l.bathrooms,
    propertyType: l.property_type,
    community: l.community ?? l.location_text,
    listedDaysAgo: l.listed_days_ago,
    verified: l.verified,
    distressKeywords: l.distress_keywords,
    badges: l.badges,
    agentName: l.agent_name,
    phoneNumber: l.phone_number,
    whatsappLink: l.whatsapp_link,
    listingUrl: l.listing_url,
    imageUrls: l.image_urls,
    description: l.description,
    extractionSource: l.extraction_source,
    needsReview: l.needs_review,
    detailScraped: l.detail_scraped,
  };
}

export interface PropertyExportFile {
  buffer: Buffer;
  contentType: string;
  extension: "csv" | "xlsx" | "json";
}

export async function buildPropertyExport(
  jobId: string,
  format: "csv" | "xlsx" | "json",
): Promise<PropertyExportFile> {
  const job = await findPropertyJobById(jobId);
  if (!job) throw new NotFoundError("Property job not found");
  // Already ranked best-deal-first by listPropertyListings' own ORDER BY.
  const rows = await listPropertyListings(jobId);

  if (format === "csv") {
    const lines = [HEADERS.map(csvEscape).join(",")];
    rows.forEach((l, i) =>
      lines.push(
        toRow(job, l, i + 1)
          .map(csvEscape)
          .join(","),
      ),
    );
    return {
      buffer: Buffer.from(lines.join("\n"), "utf-8"),
      contentType: "text/csv; charset=utf-8",
      extension: "csv",
    };
  }

  if (format === "json") {
    const payload = rows.map((l, i) => toJsonRow(job, l, i + 1));
    return {
      buffer: Buffer.from(JSON.stringify(payload, null, 2), "utf-8"),
      contentType: "application/json; charset=utf-8",
      extension: "json",
    };
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Property Listings");
  sheet.addRow(HEADERS as unknown as string[]);
  rows.forEach((l, i) => sheet.addRow(toRow(job, l, i + 1)));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  };
}
