/** Authored by: Mohit Singh */
//
// Marketing / Messaging API — email (SMTP blast, compliant) + WhatsApp (click-to-chat + vCard).
// See md/MARKETING.md. requireAuth per-route; mutations require the operator role. The public
// /unsubscribe endpoint is intentionally auth-free (verified by an HMAC token instead).
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  addTemplateImageSchema,
  campaignRecipientParamsSchema,
  createCampaignSchema,
  createTemplateSchema,
  idParamsSchema,
  recipientSourceSchema,
  suppressionSchema,
  testEmailSchema,
  updateEmailCredentialsSchema,
  updateTemplateSchema,
  type CreateCampaignInput,
  type CreateTemplateInput,
  type RecipientSourceInput,
  type UpdateEmailCredentialsInput,
} from "../schemas/marketing.js";
import { NotFoundError, ServiceUnavailableError, ValidationError } from "../errors.js";
import { isEncryptionAvailable } from "../lib/messagingCrypto.js";
import {
  buildRecipientsFromOcrJobs,
  dedupeRecipients,
  parseUploadedRecipients,
  type Recipient,
} from "../lib/recipientParse.js";
import {
  getPublicEmailCredentials,
  updateEmailCredentials,
} from "../db/messagingCredentials.js";
import {
  addTemplateImage,
  createTemplate,
  deleteTemplate,
  findTemplateById,
  listTemplateImages,
  listTemplates,
  updateTemplate,
} from "../db/messageTemplates.js";
import {
  createCampaign,
  findCampaignById,
  listCampaignRecipients,
  listCampaigns,
  refreshCampaignCounts,
  setRecipientStatus,
} from "../db/campaigns.js";
import {
  addSuppression,
  listSuppressions,
  removeSuppression,
} from "../db/emailSuppressions.js";
import { runEmailCampaign, sendTestEmail } from "../services/emailService.js";
import { buildVcard, buildWaLink } from "../services/whatsappService.js";
import { verifyUnsubscribeToken } from "../lib/unsubscribeToken.js";

export const marketingRouter = Router();

// Resolve a recipient-source payload → deduped unique businesses. Shared by preview + create.
async function resolveRecipients(source: RecipientSourceInput): Promise<Recipient[]> {
  const parts: Recipient[] = [];
  if (source.ocrJobIds?.length) {
    parts.push(...(await buildRecipientsFromOcrJobs(source.ocrJobIds)));
  }
  if (source.upload) {
    parts.push(...(await parseUploadedRecipients(source.upload.base64, source.upload.filename)));
  }
  return dedupeRecipients(parts);
}

// --- recipient preview (no persistence) ---
marketingRouter.post(
  "/marketing/recipients/preview",
  requireAuth,
  validate(recipientSourceSchema),
  async (req, res) => {
    const recipients = await resolveRecipients(req.body as RecipientSourceInput);
    res.json({
      recipients,
      total: recipients.length,
      withPhone: recipients.filter((r) => r.phone).length,
      withEmail: recipients.filter((r) => r.email).length,
    });
  },
);

// --- email credentials ---
marketingRouter.get("/marketing/email-credentials", requireAuth, async (_req, res) => {
  res.json({ credentials: await getPublicEmailCredentials(), encryptionAvailable: isEncryptionAvailable() });
});

marketingRouter.put(
  "/marketing/email-credentials",
  requireAuth,
  requireRole("operator"),
  validate(updateEmailCredentialsSchema),
  async (req, res) => {
    if (!isEncryptionAvailable()) {
      throw new ServiceUnavailableError(
        "MESSAGING_ENCRYPTION_KEY is not configured — cannot store the SMTP password securely. See config.ts.",
      );
    }
    const credentials = await updateEmailCredentials(req.body as UpdateEmailCredentialsInput);
    res.json({ credentials });
  },
);

marketingRouter.post(
  "/marketing/email-credentials/test",
  requireAuth,
  requireRole("operator"),
  validate(testEmailSchema),
  async (req, res) => {
    const { to } = req.body as { to: string };
    await sendTestEmail(to); // throws (→ 500) with a clear message if SMTP fails
    res.json({ ok: true });
  },
);

// --- templates ---
marketingRouter.get("/marketing/templates", requireAuth, async (req, res) => {
  const channel = req.query.channel === "whatsapp" || req.query.channel === "email" ? req.query.channel : undefined;
  res.json({ templates: await listTemplates(channel) });
});

marketingRouter.post(
  "/marketing/templates",
  requireAuth,
  requireRole("operator"),
  validate(createTemplateSchema),
  async (req, res) => {
    const input = req.body as CreateTemplateInput;
    if (input.channel === "email" && !input.subject) {
      throw new ValidationError("An email template needs a subject.");
    }
    const template = await createTemplate({
      channel: input.channel,
      name: input.name,
      subject: input.subject ?? null,
      body: input.body,
      createdBy: req.user!.id,
    });
    res.status(201).json({ template });
  },
);

marketingRouter.patch(
  "/marketing/templates/:id",
  requireAuth,
  requireRole("operator"),
  validate(idParamsSchema, "params"),
  validate(updateTemplateSchema),
  async (req, res) => {
    const template = await updateTemplate(req.params.id as string, req.body);
    if (!template) throw new NotFoundError("Template not found");
    res.json({ template });
  },
);

marketingRouter.delete(
  "/marketing/templates/:id",
  requireAuth,
  requireRole("operator"),
  validate(idParamsSchema, "params"),
  async (req, res) => {
    if (!(await deleteTemplate(req.params.id as string))) throw new NotFoundError("Template not found");
    res.status(204).send();
  },
);

marketingRouter.post(
  "/marketing/templates/:id/images",
  requireAuth,
  requireRole("operator"),
  validate(idParamsSchema, "params"),
  validate(addTemplateImageSchema),
  async (req, res) => {
    const template = await findTemplateById(req.params.id as string);
    if (!template) throw new NotFoundError("Template not found");
    const { cid, filename, mime, base64 } = req.body as {
      cid: string;
      filename: string;
      mime: string;
      base64: string;
    };
    const image = await addTemplateImage({
      templateId: template.id,
      cid,
      filename,
      mime,
      bytes: Buffer.from(base64, "base64"),
    });
    res.status(201).json({ image });
  },
);

marketingRouter.get(
  "/marketing/templates/:id/images",
  requireAuth,
  validate(idParamsSchema, "params"),
  async (req, res) => {
    const images = await listTemplateImages(req.params.id as string);
    // Never ship raw bytes in JSON — metadata only (the send path reads bytes server-side).
    res.json({
      images: images.map((i) => ({ id: i.id, cid: i.cid, filename: i.filename, mime: i.mime })),
    });
  },
);

// --- campaigns ---
marketingRouter.post(
  "/marketing/campaigns",
  requireAuth,
  requireRole("operator"),
  validate(createCampaignSchema),
  async (req, res) => {
    const input = req.body as CreateCampaignInput;
    if (input.channel === "email" && !input.subject) {
      throw new ValidationError("An email campaign needs a subject.");
    }
    // Per-recipient wa.me link for whatsapp; email recipients carry no link.
    const recipients = input.recipients.map((recipient) => ({
      recipient,
      waLink: input.channel === "whatsapp" ? buildWaLink(recipient, input.body) : null,
    }));
    const campaign = await createCampaign({
      channel: input.channel,
      templateId: input.templateId ?? null,
      subject: input.subject ?? null,
      body: input.body,
      createdBy: req.user!.id,
      recipients,
    });
    res.status(201).json({ campaign });
  },
);

marketingRouter.get("/marketing/campaigns", requireAuth, async (_req, res) => {
  res.json({ campaigns: await listCampaigns() });
});

marketingRouter.get(
  "/marketing/campaigns/:id",
  requireAuth,
  validate(idParamsSchema, "params"),
  async (req, res) => {
    const campaign = await findCampaignById(req.params.id as string);
    if (!campaign) throw new NotFoundError("Campaign not found");
    res.json({ campaign, recipients: await listCampaignRecipients(campaign.id) });
  },
);

// Email: background the blast; UI polls GET /campaigns/:id for progress (mirrors OCR jobs).
marketingRouter.post(
  "/marketing/campaigns/:id/send",
  requireAuth,
  requireRole("operator"),
  validate(idParamsSchema, "params"),
  async (req, res) => {
    const campaign = await findCampaignById(req.params.id as string);
    if (!campaign) throw new NotFoundError("Campaign not found");
    if (campaign.channel !== "email") throw new ValidationError("Only email campaigns are sent server-side; WhatsApp uses click-to-chat links.");
    if (campaign.status === "sending") throw new ValidationError("Campaign is already sending.");
    // Fire-and-forget — awaited failures inside are logged + persisted per-recipient.
    void runEmailCampaign(campaign.id).catch(() => undefined);
    res.status(202).json({ ok: true });
  },
);

// WhatsApp: download the vCard so all businesses save into the operator's contacts BY NAME.
marketingRouter.get(
  "/marketing/campaigns/:id/vcard",
  requireAuth,
  validate(idParamsSchema, "params"),
  async (req, res) => {
    const campaign = await findCampaignById(req.params.id as string);
    if (!campaign) throw new NotFoundError("Campaign not found");
    const recipients = await listCampaignRecipients(campaign.id);
    const vcf = buildVcard(
      recipients.map((r) => ({
        businessName: r.business_name,
        businessType: r.business_type,
        location: r.location,
        phone: r.phone,
        email: r.email,
      })),
    );
    res.setHeader("Content-Type", "text/vcard; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="contacts-${campaign.id.slice(0, 8)}.vcf"`);
    res.send(vcf);
  },
);

// WhatsApp: the frontend marks a recipient 'sent' after the operator clicks its wa.me link (we
// can't confirm real delivery for click-to-chat).
marketingRouter.post(
  "/marketing/campaigns/:id/recipients/:rid/mark-sent",
  requireAuth,
  requireRole("operator"),
  validate(campaignRecipientParamsSchema, "params"),
  async (req, res) => {
    const recipient = await setRecipientStatus(req.params.rid as string, "sent");
    if (!recipient || recipient.campaign_id !== req.params.id) throw new NotFoundError("Recipient not found");
    const campaign = await refreshCampaignCounts(req.params.id as string);
    res.json({ recipient, campaign });
  },
);

// --- suppressions ---
marketingRouter.get("/marketing/suppressions", requireAuth, async (_req, res) => {
  res.json({ suppressions: await listSuppressions() });
});

marketingRouter.post(
  "/marketing/suppressions",
  requireAuth,
  requireRole("operator"),
  validate(suppressionSchema),
  async (req, res) => {
    await addSuppression((req.body as { email: string }).email, "manual");
    res.status(201).json({ ok: true });
  },
);

marketingRouter.delete(
  "/marketing/suppressions/:email",
  requireAuth,
  requireRole("operator"),
  async (req, res) => {
    if (!(await removeSuppression(req.params.email as string))) throw new NotFoundError("Not suppressed");
    res.status(204).send();
  },
);

// --- public unsubscribe (no auth — HMAC-token-verified, rate-limited) ---
const unsubscribeLimiter = rateLimit({ windowMs: 60_000, max: 20, standardHeaders: true, legacyHeaders: false });

marketingRouter.get("/unsubscribe", unsubscribeLimiter, async (req, res) => {
  const email = typeof req.query.email === "string" ? req.query.email : "";
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const page = (title: string, msg: string): string =>
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<title>${title}</title>` +
    `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;text-align:center">` +
    `<h2 style="color:#111">${title}</h2><p style="color:#555;line-height:1.6">${msg}</p></div>`;

  if (!email || !token || !verifyUnsubscribeToken(email, token)) {
    res.status(400).type("html").send(page("Invalid link", "This unsubscribe link is invalid or has expired."));
    return;
  }
  await addSuppression(email, "unsubscribed");
  res.type("html").send(
    page("Unsubscribed", `<b>${email}</b> has been removed. You won't receive further emails from us.`),
  );
});
