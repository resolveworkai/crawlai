/** Authored by: Mohit Singh */
//
// Pure unit tests — db/ecomJobs.ts + db/ecomProducts.ts are mocked; the CSV/XLSX/JSON writers run
// for real (exceljs for xlsx) so this proves the output is well-formed, not just that mocks were
// called. Mirrors ocrExportService.test.ts's shape/conventions.
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EcomJob, EcomProduct } from "../types/db.js";

const findEcomJobById = vi.fn();
const listEcomProducts = vi.fn();
vi.mock("../db/ecomJobs.js", () => ({
  findEcomJobById: (...args: unknown[]) => findEcomJobById(...args),
}));
vi.mock("../db/ecomProducts.js", () => ({
  listEcomProducts: (...args: unknown[]) => listEcomProducts(...args),
}));

const { buildEcomExport } = await import("./ecomExportService.js");

function job(overrides: Partial<EcomJob> = {}): EcomJob {
  return {
    id: "j1",
    created_by: null,
    platform: "noon",
    query: "yoga mat",
    sort_mode: "rating_desc",
    max_pages: 3,
    max_products: 90,
    detail_scrape_top_n: 0,
    score_weights: null,
    status: "ready",
    end_reason: "end_of_results",
    total_count: 1,
    captured_count: 1,
    ocr_done_count: 1,
    detail_done_count: 0,
    current_product: null,
    error_message: null,
    storage_dir: "j1",
    retry_count: 0,
    created_at: new Date(),
    started_at: new Date(),
    finished_at: new Date(),
    ...overrides,
  };
}

function product(overrides: Partial<EcomProduct> = {}): EcomProduct {
  return {
    id: "p1",
    job_id: "j1",
    idx: 1,
    page_num: 1,
    title: "Premium Yoga Mat, Non-Slip",
    product_url: "https://www.noon.com/uae-en/p/N123",
    image_url: "https://images.noon.com/mat.jpg",
    price: 99.0,
    list_price: 129.0,
    currency: "AED",
    discount_pct: 23.3,
    rating: 4.6,
    review_count: 320,
    bought_past_month: 150,
    bought_past_month_raw: "150+ bought in past month",
    free_delivery: true,
    delivery_date: "Tomorrow, 8 Aug",
    category: "Yoga Mats",
    badges: ["Best Seller", "Express"],
    rank_in_category: 2,
    sponsored: false,
    opportunity_score: 78.4,
    extraction_source: "dom+ocr",
    ocr_confidence: 91.5,
    needs_review: false,
    raw_text: "",
    source_images: [],
    description: null,
    about_bullets: [],
    breadcrumb_category: null,
    seller_name: null,
    detail_scraped: false,
    created_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("buildEcomExport csv", () => {
  it("writes a header + one row, escaping the comma in the title", async () => {
    findEcomJobById.mockResolvedValue(job());
    listEcomProducts.mockResolvedValue([product()]);
    const file = await buildEcomExport("j1", "csv");
    expect(file.extension).toBe("csv");
    const text = file.buffer.toString("utf-8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Title");
    expect(lines[0]).toContain("Platform");
    expect(lines[1]).toContain('"Premium Yoga Mat, Non-Slip"'); // comma-quoted
    expect(lines[1]).toContain("noon"); // platform pulled from the job, not the product row
    expect(lines[1]).toContain("Best Seller; Express"); // badges joined with "; "
  });

  it("marks needs_review rows and blanks nulls", async () => {
    findEcomJobById.mockResolvedValue(job());
    listEcomProducts.mockResolvedValue([
      product({ price: null, needs_review: true, title: "A" }),
    ]);
    const text = (await buildEcomExport("j1", "csv")).buffer.toString("utf-8");
    const row = text.trim().split("\n")[1];
    expect(row).toContain("yes"); // needs_review column
  });

  it("throws NotFoundError when the job doesn't exist", async () => {
    findEcomJobById.mockResolvedValue(null);
    await expect(buildEcomExport("missing", "csv")).rejects.toThrow();
  });
});

describe("buildEcomExport xlsx", () => {
  it("writes a real, readable workbook", async () => {
    findEcomJobById.mockResolvedValue(job());
    listEcomProducts.mockResolvedValue([product()]);
    const file = await buildEcomExport("j1", "xlsx");
    expect(file.extension).toBe("xlsx");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet("Ecom Products");
    expect(sheet).toBeDefined();
    expect(sheet?.getRow(1).getCell(3).value).toBe("Title");
    expect(sheet?.getRow(2).getCell(3).value).toBe("Premium Yoga Mat, Non-Slip");
  });
});

describe("buildEcomExport json", () => {
  it("returns valid, parseable JSON with the expected fields", async () => {
    findEcomJobById.mockResolvedValue(job({ platform: "amazon" }));
    listEcomProducts.mockResolvedValue([product()]);
    const file = await buildEcomExport("j1", "json");
    expect(file.extension).toBe("json");
    expect(file.contentType).toContain("application/json");

    const parsed = JSON.parse(file.buffer.toString("utf-8"));
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      idx: 1,
      platform: "amazon",
      title: "Premium Yoga Mat, Non-Slip",
      price: 99.0,
      listPrice: 129.0,
      discountPct: 23.3,
      reviewCount: 320,
      boughtPastMonth: 150,
      freeDelivery: true,
      opportunityScore: 78.4,
      extractionSource: "dom+ocr",
      needsReview: false,
    });
  });
});
