/** Authored by: Mohit Singh */
//
// One Excel report per campaign ("group") — every recipient with its outcome, so the operator can
// see exactly which records failed (and why) without cross-referencing the UI. xlsx via exceljs
// (mirrors services/ocrExportService.ts — never the vulnerable `xlsx`/SheetJS npm package).
import ExcelJS from "exceljs";
import { findCampaignById, listCampaignRecipients } from "../db/campaigns.js";
import { NotFoundError } from "../errors.js";
import type { CampaignRecipient } from "../types/db.js";

const HEADERS = [
  "Business Name",
  "Type",
  "Location",
  "Phone",
  "Email",
  "Status",
  "Error",
  "Sent At",
] as const;

function toRow(r: CampaignRecipient): (string | null)[] {
  return [
    r.business_name,
    r.business_type,
    r.location,
    r.phone,
    r.email,
    r.status,
    r.error,
    r.sent_at ? r.sent_at.toISOString() : null,
  ];
}

export interface CampaignExportFile {
  buffer: Buffer;
  contentType: string;
  filename: string;
}

export async function buildCampaignExport(campaignId: string): Promise<CampaignExportFile> {
  const campaign = await findCampaignById(campaignId);
  if (!campaign) throw new NotFoundError("Campaign not found");
  const recipients = await listCampaignRecipients(campaignId);

  const workbook = new ExcelJS.Workbook();

  const summary = workbook.addWorksheet("Summary");
  summary.addRow(["Campaign", campaignId]);
  summary.addRow(["Channel", campaign.channel]);
  summary.addRow(["Status", campaign.status]);
  summary.addRow(["Total", campaign.total_count]);
  summary.addRow(["Sent", campaign.sent_count]);
  summary.addRow(["Failed", campaign.failed_count]);
  summary.addRow(["Skipped", campaign.skipped_count]);
  summary.getColumn(1).font = { bold: true };

  const sheet = workbook.addWorksheet("Recipients");
  sheet.addRow(HEADERS as unknown as string[]);
  sheet.getRow(1).font = { bold: true };
  for (const r of recipients) sheet.addRow(toRow(r));

  const failed = recipients.filter((r) => r.status === "failed");
  if (failed.length > 0) {
    const failedSheet = workbook.addWorksheet("Failed only");
    failedSheet.addRow(HEADERS as unknown as string[]);
    failedSheet.getRow(1).font = { bold: true };
    for (const r of failed) failedSheet.addRow(toRow(r));
  }

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    filename: `campaign-report_${campaign.channel}_${campaignId.slice(0, 8)}.xlsx`,
  };
}
