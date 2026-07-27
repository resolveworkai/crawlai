/** Authored by: Mohit Singh */
//
// Pure unit tests — db/campaigns.ts is mocked; the xlsx writer runs for real (exceljs) so this
// proves the output is a well-formed workbook, not just that mocks were called.
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Campaign, CampaignRecipient } from "../types/db.js";

const findCampaignById = vi.fn();
const listCampaignRecipients = vi.fn();
vi.mock("../db/campaigns.js", () => ({
  findCampaignById: (...args: unknown[]) => findCampaignById(...args),
  listCampaignRecipients: (...args: unknown[]) => listCampaignRecipients(...args),
}));

const { buildCampaignExport } = await import("./campaignExportService.js");

function campaign(overrides: Partial<Campaign> = {}): Campaign {
  return {
    id: "c1",
    channel: "whatsapp",
    template_id: null,
    subject: null,
    body: "Hi {business_name}!",
    status: "completed",
    total_count: 2,
    sent_count: 1,
    failed_count: 1,
    skipped_count: 0,
    created_by: null,
    created_at: new Date(),
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

function recipient(overrides: Partial<CampaignRecipient> = {}): CampaignRecipient {
  return {
    id: "r1",
    campaign_id: "c1",
    business_name: "Gym A",
    business_type: "Gym",
    location: "Delhi",
    phone: "+911111111111",
    email: null,
    wa_link: "https://wa.me/911111111111?text=hi",
    status: "sent",
    error: null,
    sent_at: new Date("2026-01-01T00:00:00Z"),
    created_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("buildCampaignExport", () => {
  it("throws NotFoundError for a missing campaign", async () => {
    findCampaignById.mockResolvedValue(null);
    await expect(buildCampaignExport("missing")).rejects.toThrow("Campaign not found");
  });

  it("writes Summary + Recipients sheets with correct counts and rows", async () => {
    findCampaignById.mockResolvedValue(campaign());
    listCampaignRecipients.mockResolvedValue([
      recipient(),
      recipient({ id: "r2", business_name: "Gym B", status: "failed", error: "chat never loaded", sent_at: null }),
    ]);

    const file = await buildCampaignExport("c1");
    expect(file.filename).toContain("campaign-report_whatsapp_c1");

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);

    const summary = wb.getWorksheet("Summary");
    expect(summary?.getRow(5).getCell(2).value).toBe(1); // Sent
    expect(summary?.getRow(6).getCell(2).value).toBe(1); // Failed

    const sheet = wb.getWorksheet("Recipients");
    expect(sheet?.getRow(1).getCell(1).value).toBe("Business Name");
    expect(sheet?.getRow(2).getCell(1).value).toBe("Gym A");
    expect(sheet?.getRow(2).getCell(6).value).toBe("sent");
    expect(sheet?.getRow(3).getCell(1).value).toBe("Gym B");
    expect(sheet?.getRow(3).getCell(7).value).toBe("chat never loaded");
  });

  it("adds a 'Failed only' sheet containing just the failed rows, and omits it when nothing failed", async () => {
    findCampaignById.mockResolvedValue(campaign({ failed_count: 1 }));
    listCampaignRecipients.mockResolvedValue([
      recipient(),
      recipient({ id: "r2", business_name: "Gym B", status: "failed", error: "invalid number" }),
    ]);
    const withFailure = await buildCampaignExport("c1");
    const wbWithFailure = new ExcelJS.Workbook();
    await wbWithFailure.xlsx.load(withFailure.buffer as unknown as ArrayBuffer);
    const failedSheet = wbWithFailure.getWorksheet("Failed only");
    expect(failedSheet).toBeDefined();
    expect(failedSheet?.rowCount).toBe(2); // header + 1 failed row
    expect(failedSheet?.getRow(2).getCell(1).value).toBe("Gym B");

    findCampaignById.mockResolvedValue(campaign({ failed_count: 0 }));
    listCampaignRecipients.mockResolvedValue([recipient()]);
    const noFailures = await buildCampaignExport("c1");
    const wbNoFailures = new ExcelJS.Workbook();
    await wbNoFailures.xlsx.load(noFailures.buffer as unknown as ArrayBuffer);
    expect(wbNoFailures.getWorksheet("Failed only")).toBeUndefined();
  });
});
