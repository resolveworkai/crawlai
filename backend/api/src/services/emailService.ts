/** Authored by: Mohit Singh */
//
// Email sending via the operator's own SMTP (nodemailer). Two entry points: `sendTestEmail`
// (verifies credentials, marks them verified) and `runEmailCampaign` (the backgrounded blast).
// Compliance is built in: every email gets an unsubscribe footer + List-Unsubscribe header, and
// suppressed/opted-out addresses are skipped. See md/MARKETING.md.
import type { Transporter } from "nodemailer";
import { logger } from "../logger.js";
import type { CampaignRecipient } from "../types/db.js";
import type { Recipient } from "../lib/recipientParse.js";
import { recipientToPlaceholders, renderPlaceholders } from "../lib/placeholders.js";
import { unsubscribeUrl } from "../lib/unsubscribeToken.js";
import {
  getSmtpConfig,
  markEmailCredentialsVerified,
  type SmtpConfig,
} from "../db/messagingCredentials.js";
import {
  findCampaignById,
  listCampaignRecipients,
  refreshCampaignCounts,
  setCampaignStatus,
  setRecipientStatus,
} from "../db/campaigns.js";
import { listTemplateImages } from "../db/messageTemplates.js";
import { getSuppressedSet } from "../db/emailSuppressions.js";

// Between-send delay to protect sender reputation (bulk-blasting trips spam heuristics). Overridable
// for tests. ~1/s is conservative and fine for the low volumes this tool targets.
const DEFAULT_SEND_DELAY_MS = 1000;
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// nodemailer is lazy-imported (only when an email is actually sent) so it stays out of the app's
// import graph — it's a heavy module and every route file transitively importing it slowed down
// app-import-per-test suites (health.test.ts's resetModules re-import). renderEmail (the hot,
// pure path) needs no transport.
async function buildTransport(smtp: SmtpConfig): Promise<Transporter> {
  const nodemailer = (await import("nodemailer")).default;
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.password },
  });
}

function fromHeader(smtp: SmtpConfig): string {
  return `"${smtp.fromName}" <${smtp.fromEmail}>`;
}

// The CAN-SPAM/GDPR footer: physical mailing address + an unsubscribe link keyed to this recipient.
function footerHtml(toEmail: string, orgAddress: string | null): string {
  const unsub = unsubscribeUrl(toEmail);
  const addr = orgAddress ? `${escapeHtml(orgAddress)}<br/>` : "";
  return (
    `<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px"/>` +
    `<p style="font-size:12px;color:#6b7280;line-height:1.5">${addr}` +
    `You received this because your business was listed publicly. ` +
    `<a href="${unsub}" style="color:#6b7280">Unsubscribe</a>.</p>`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface RenderedEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  replyTo?: string;
  headers: Record<string, string>;
  attachments: { filename: string; content: Buffer; contentType: string; cid: string }[];
}

// Pure-ish render (no network) — testable with nodemailer's jsonTransport. Substitutes placeholders,
// appends the compliance footer, and wires inline images as cid attachments.
export function renderEmail(
  smtp: SmtpConfig,
  recipient: Recipient,
  subject: string,
  body: string,
  images: { cid: string; filename: string; mime: string; bytes: Buffer }[],
): RenderedEmail {
  const values = recipientToPlaceholders(recipient);
  const to = recipient.email!;
  const renderedSubject = renderPlaceholders(subject, values);
  const html = renderPlaceholders(body, values) + footerHtml(to, smtp.orgAddress);
  const result: RenderedEmail = {
    from: fromHeader(smtp),
    to,
    subject: renderedSubject,
    html,
    headers: { "List-Unsubscribe": `<${unsubscribeUrl(to)}>` },
    attachments: images.map((img) => ({
      filename: img.filename,
      content: img.bytes,
      contentType: img.mime,
      cid: img.cid,
    })),
  };
  if (smtp.replyTo) result.replyTo = smtp.replyTo;
  return result;
}

/** Send a single test email to `toEmail`, then mark the stored credentials verified. Throws with a
 * clear message if credentials aren't configured or the SMTP handshake/send fails. */
export async function sendTestEmail(toEmail: string): Promise<void> {
  const smtp = await getSmtpConfig();
  if (!smtp) {
    throw new Error("Email credentials are not fully configured — set host, user, password and from address first.");
  }
  const transport = await buildTransport(smtp);
  const sample: Recipient = {
    businessName: "Your Business",
    businessType: "Gym",
    location: "Your City",
    phone: null,
    email: toEmail,
  };
  const rendered = renderEmail(
    smtp,
    sample,
    "Test email from Business Scout AI",
    "<p>This is a test — your SMTP credentials work. Placeholders like " +
      "<b>{business_name}</b> render as <b>{business_name}</b>.</p>",
    [],
  );
  await transport.sendMail(rendered);
  await markEmailCredentialsVerified();
}

function toRecipientDto(r: CampaignRecipient): Recipient {
  return {
    businessName: r.business_name,
    businessType: r.business_type,
    location: r.location,
    phone: r.phone,
    email: r.email,
  };
}

/** The backgrounded email blast for a campaign. Best-effort per recipient (one failure never aborts
 * the run); suppressed/no-email recipients are skipped; counts + terminal status always land. */
export async function runEmailCampaign(
  campaignId: string,
  sendDelayMs: number = DEFAULT_SEND_DELAY_MS,
): Promise<void> {
  const log = logger.child({ campaignId });
  const campaign = await findCampaignById(campaignId);
  if (!campaign || campaign.channel !== "email") return;

  const smtp = await getSmtpConfig();
  if (!smtp) {
    await setCampaignStatus(campaignId, "failed", { finished: true });
    log.error("email campaign failed — no SMTP config");
    return;
  }

  const transport = await buildTransport(smtp);
  const images = campaign.template_id ? await listTemplateImages(campaign.template_id) : [];
  const suppressed = await getSuppressedSet();
  const recipients = (await listCampaignRecipients(campaignId)).filter(
    (r) => r.status === "pending" || r.status === "failed",
  );

  await setCampaignStatus(campaignId, "sending", { started: true });

  for (const r of recipients) {
    if (!r.email) {
      await setRecipientStatus(r.id, "skipped", "no email address");
      continue;
    }
    if (suppressed.has(r.email.toLowerCase())) {
      await setRecipientStatus(r.id, "skipped", "unsubscribed / suppressed");
      continue;
    }
    try {
      const rendered = renderEmail(smtp, toRecipientDto(r), campaign.subject ?? "", campaign.body, images);
      await transport.sendMail(rendered);
      await setRecipientStatus(r.id, "sent");
    } catch (err) {
      await setRecipientStatus(r.id, "failed", (err as Error).message.slice(0, 500));
      log.warn({ err: (err as Error).message, to: r.email }, "email send failed for recipient");
    }
    if (sendDelayMs > 0) await delay(sendDelayMs);
  }

  await refreshCampaignCounts(campaignId);
  await setCampaignStatus(campaignId, "completed", { finished: true });
  log.info("email campaign completed");
}
