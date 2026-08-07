/** Authored by: Mohit Singh */
//
// CSV/XLSX/JSON export for a Product Research (Ecom-Crawl) job's parsed rows. Result sets are
// small (a capped single search), so this builds in memory rather than streaming (mirrors
// ocrExportService.ts). xlsx via exceljs — never the vulnerable `xlsx`/SheetJS npm package (see
// skills_backend_node.md).
import ExcelJS from "exceljs";
import { findEcomJobById } from "../db/ecomJobs.js";
import { listEcomProducts } from "../db/ecomProducts.js";
import type { EcomJob, EcomProduct } from "../types/db.js";
import { NotFoundError } from "../errors.js";

const HEADERS = [
  "#",
  "Platform",
  "Title",
  "Price",
  "List Price",
  "Currency",
  "Discount %",
  "Rating",
  "Reviews",
  "Bought Past Month",
  "Free Delivery",
  "Delivery Date",
  "Category",
  "Badges",
  "Sponsored",
  "Opportunity Score",
  "Product URL",
  "Image URL",
  "Extraction Source",
  "Needs Review",
  "Description",
  "Seller",
  "Breadcrumb Category",
] as const;

function toRow(job: EcomJob, p: EcomProduct): (string | number | null)[] {
  return [
    p.idx,
    job.platform,
    p.title,
    p.price,
    p.list_price,
    p.currency,
    p.discount_pct,
    p.rating,
    p.review_count,
    p.bought_past_month,
    p.free_delivery ? "yes" : "",
    p.delivery_date,
    p.category,
    Array.isArray(p.badges) ? p.badges.join("; ") : "",
    p.sponsored ? "yes" : "",
    p.opportunity_score,
    p.product_url,
    p.image_url,
    p.extraction_source,
    p.needs_review ? "yes" : "",
    // Phase 2b fields — present only when the job's detail_scrape_top_n > 0 and this product was
    // in scope; blank otherwise, never fabricated.
    p.description,
    p.seller_name,
    p.breadcrumb_category,
  ];
}

function csvEscape(value: string | number | null): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function toJsonRow(job: EcomJob, p: EcomProduct): Record<string, unknown> {
  return {
    idx: p.idx,
    platform: job.platform,
    title: p.title,
    price: p.price,
    listPrice: p.list_price,
    currency: p.currency,
    discountPct: p.discount_pct,
    rating: p.rating,
    reviewCount: p.review_count,
    boughtPastMonth: p.bought_past_month,
    freeDelivery: p.free_delivery,
    deliveryDate: p.delivery_date,
    category: p.category,
    badges: p.badges,
    sponsored: p.sponsored,
    opportunityScore: p.opportunity_score,
    productUrl: p.product_url,
    imageUrl: p.image_url,
    extractionSource: p.extraction_source,
    needsReview: p.needs_review,
    description: p.description,
    aboutBullets: p.about_bullets,
    sellerName: p.seller_name,
    breadcrumbCategory: p.breadcrumb_category,
    detailScraped: p.detail_scraped,
  };
}

export interface EcomExportFile {
  buffer: Buffer;
  contentType: string;
  extension: "csv" | "xlsx" | "json";
}

export async function buildEcomExport(
  jobId: string,
  format: "csv" | "xlsx" | "json",
): Promise<EcomExportFile> {
  const job = await findEcomJobById(jobId);
  if (!job) throw new NotFoundError("Ecom job not found");
  const rows = await listEcomProducts(jobId);

  if (format === "csv") {
    const lines = [HEADERS.map(csvEscape).join(",")];
    for (const p of rows) lines.push(toRow(job, p).map(csvEscape).join(","));
    return {
      buffer: Buffer.from(lines.join("\n"), "utf-8"),
      contentType: "text/csv; charset=utf-8",
      extension: "csv",
    };
  }

  if (format === "json") {
    const payload = rows.map((p) => toJsonRow(job, p));
    return {
      buffer: Buffer.from(JSON.stringify(payload, null, 2), "utf-8"),
      contentType: "application/json; charset=utf-8",
      extension: "json",
    };
  }

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Ecom Products");
  sheet.addRow(HEADERS as unknown as string[]);
  for (const p of rows) sheet.addRow(toRow(job, p));
  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    extension: "xlsx",
  };
}
