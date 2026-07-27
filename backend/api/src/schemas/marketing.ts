/** Authored by: Mohit Singh */
import { z } from "zod";

export const channelSchema = z.enum(["whatsapp", "email"]);

// Recipient source: an uploaded file, a set of finished OCR job ids, and/or a set of saved
// marketing_contacts ids. At least one must be present; all may be combined (merged then deduped).
export const recipientSourceSchema = z
  .object({
    upload: z
      .object({
        filename: z.string().min(1).max(255),
        base64: z.string().min(1),
      })
      .optional(),
    ocrJobIds: z.array(z.string().uuid()).optional(),
    contactIds: z.array(z.string().uuid()).optional(),
  })
  .refine(
    (v) => v.upload !== undefined || (v.ocrJobIds?.length ?? 0) > 0 || (v.contactIds?.length ?? 0) > 0,
    { message: "provide an uploaded file, at least one ocrJobId, and/or at least one contactId" },
  );

export type RecipientSourceInput = z.infer<typeof recipientSourceSchema>;

// A recipient as it round-trips through the client (already normalized by the preview step). The
// client sends back the (possibly operator-edited/filtered) list when creating a campaign.
export const recipientSchema = z.object({
  businessName: z.string().min(1).max(300),
  businessType: z.string().max(120).nullable(),
  location: z.string().max(300).nullable(),
  phone: z.string().max(40).nullable(),
  email: z.string().max(320).nullable(),
});

export const updateEmailCredentialsSchema = z.object({
  smtpHost: z.string().min(1).max(255),
  smtpPort: z.coerce.number().int().min(1).max(65535),
  smtpSecure: z.boolean(),
  smtpUser: z.string().min(1).max(320),
  smtpPassword: z.string().min(1).max(500).optional(), // omitted on edit = keep existing
  fromName: z.string().min(1).max(120),
  fromEmail: z.string().email().max(320),
  replyTo: z.string().email().max(320).optional(),
  orgAddress: z.string().max(500).optional(),
});
export type UpdateEmailCredentialsInput = z.infer<typeof updateEmailCredentialsSchema>;

export const testEmailSchema = z.object({ to: z.string().email() });

// Scopes a curated template to a business type (e.g. "Gym") so the composer can recommend it first
// for that recipient set; null/omitted = generic, recommended for every business type.
export const createTemplateSchema = z.object({
  channel: channelSchema,
  name: z.string().min(1).max(120),
  subject: z.string().max(300).nullable().optional(),
  body: z.string().min(1).max(50_000),
  businessType: z.string().max(120).nullable().optional(),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  subject: z.string().max(300).nullable().optional(),
  body: z.string().min(1).max(50_000).optional(),
  businessType: z.string().max(120).nullable().optional(),
});

// isInline (default true) selects cid-referenced inline image vs. a plain email attachment (e.g. a
// PDF brochure) — only inline images are restricted to image/* mime; a plain attachment may be any
// file type.
export const addTemplateImageSchema = z
  .object({
    cid: z.string().min(1).max(120),
    filename: z.string().min(1).max(255),
    mime: z.string().min(1).max(200),
    base64: z.string().min(1),
    isInline: z.boolean().optional().default(true),
  })
  .refine((v) => !v.isInline || v.mime.startsWith("image/"), {
    message: "an inline image must have an image/* mime type",
    path: ["mime"],
  });

export const createContactSchema = z.object({
  businessName: z.string().min(1).max(300),
  businessType: z.string().max(120).nullable().optional(),
  location: z.string().max(300).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().email().max(320).nullable().optional(),
});
export type CreateContactInput = z.infer<typeof createContactSchema>;

export const updateContactSchema = z.object({
  businessName: z.string().min(1).max(300).optional(),
  businessType: z.string().max(120).nullable().optional(),
  location: z.string().max(300).nullable().optional(),
  phone: z.string().max(40).nullable().optional(),
  email: z.string().email().max(320).nullable().optional(),
});

export const createCampaignSchema = z.object({
  channel: channelSchema,
  templateId: z.string().uuid().nullable().optional(),
  subject: z.string().max(300).nullable().optional(),
  body: z.string().min(1).max(50_000),
  recipients: z.array(recipientSchema).min(1).max(5000),
});
export type CreateCampaignInput = z.infer<typeof createCampaignSchema>;

export const idParamsSchema = z.object({ id: z.string().uuid() });
export const campaignRecipientParamsSchema = z.object({
  id: z.string().uuid(),
  rid: z.string().uuid(),
});

// Used by the WhatsApp automation agent (backend/whatsapp-sender) to record a send that failed
// (e.g. the chat never loaded, an invalid number) — mirrors mark-sent's shape + params.
export const markFailedSchema = z.object({ error: z.string().max(500).optional() });

export const suppressionSchema = z.object({ email: z.string().email() });
