/** Authored by: Mohit Singh */
import { z } from "zod";

export const channelSchema = z.enum(["whatsapp", "email"]);

// Recipient source: either an uploaded file (base64 + filename) OR a set of finished OCR job ids.
// At least one must be present; both may be combined (results are merged then deduped).
export const recipientSourceSchema = z
  .object({
    upload: z
      .object({
        filename: z.string().min(1).max(255),
        base64: z.string().min(1),
      })
      .optional(),
    ocrJobIds: z.array(z.string().uuid()).optional(),
  })
  .refine((v) => v.upload !== undefined || (v.ocrJobIds?.length ?? 0) > 0, {
    message: "provide an uploaded file and/or at least one ocrJobId",
  });

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

export const createTemplateSchema = z.object({
  channel: channelSchema,
  name: z.string().min(1).max(120),
  subject: z.string().max(300).nullable().optional(),
  body: z.string().min(1).max(50_000),
});
export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;

export const updateTemplateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  subject: z.string().max(300).nullable().optional(),
  body: z.string().min(1).max(50_000).optional(),
});

export const addTemplateImageSchema = z.object({
  cid: z.string().min(1).max(120),
  filename: z.string().min(1).max(255),
  mime: z.string().regex(/^image\//, "must be an image/* mime type"),
  base64: z.string().min(1),
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

export const suppressionSchema = z.object({ email: z.string().email() });
