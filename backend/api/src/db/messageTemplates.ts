/** Authored by: Mohit Singh */
//
// CRUD for reusable curated message bodies + their inline email images. Mirrors db/dynamicFields.ts
// conventions. Image bytes live in the DB (message_template_images.bytes) and are attached by `cid`
// at send time (services/emailService.ts).
import { pool } from "./pool.js";
import type { MessageChannel, MessageTemplate, MessageTemplateImage } from "../types/db.js";

export async function listTemplates(channel?: MessageChannel): Promise<MessageTemplate[]> {
  const { rows } = channel
    ? await pool.query<MessageTemplate>(
        "SELECT * FROM message_templates WHERE channel = $1 ORDER BY created_at DESC",
        [channel],
      )
    : await pool.query<MessageTemplate>(
        "SELECT * FROM message_templates ORDER BY created_at DESC",
      );
  return rows;
}

export async function findTemplateById(id: string): Promise<MessageTemplate | null> {
  const { rows } = await pool.query<MessageTemplate>(
    "SELECT * FROM message_templates WHERE id = $1",
    [id],
  );
  return rows[0] ?? null;
}

export async function createTemplate(input: {
  channel: MessageChannel;
  name: string;
  subject: string | null;
  body: string;
  createdBy: string | null;
}): Promise<MessageTemplate> {
  const { rows } = await pool.query<MessageTemplate>(
    `INSERT INTO message_templates (channel, name, subject, body, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.channel, input.name, input.subject, input.body, input.createdBy],
  );
  return rows[0]!;
}

export async function updateTemplate(
  id: string,
  patch: { name?: string; subject?: string | null; body?: string },
): Promise<MessageTemplate | null> {
  const { rows } = await pool.query<MessageTemplate>(
    `UPDATE message_templates SET
        name = COALESCE($2, name),
        subject = CASE WHEN $3::boolean THEN $4 ELSE subject END,
        body = COALESCE($5, body),
        updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, patch.name ?? null, patch.subject !== undefined, patch.subject ?? null, patch.body ?? null],
  );
  return rows[0] ?? null;
}

export async function deleteTemplate(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM message_templates WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

// --- inline images ---

export async function addTemplateImage(input: {
  templateId: string;
  cid: string;
  filename: string;
  mime: string;
  bytes: Buffer;
}): Promise<Omit<MessageTemplateImage, "bytes">> {
  const { rows } = await pool.query<Omit<MessageTemplateImage, "bytes">>(
    `INSERT INTO message_template_images (template_id, cid, filename, mime, bytes)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (template_id, cid) DO UPDATE SET filename = EXCLUDED.filename,
       mime = EXCLUDED.mime, bytes = EXCLUDED.bytes
     RETURNING id, template_id, cid, filename, mime, created_at`,
    [input.templateId, input.cid, input.filename, input.mime, input.bytes],
  );
  return rows[0]!;
}

export async function listTemplateImages(templateId: string): Promise<MessageTemplateImage[]> {
  const { rows } = await pool.query<MessageTemplateImage>(
    "SELECT * FROM message_template_images WHERE template_id = $1 ORDER BY created_at ASC",
    [templateId],
  );
  return rows;
}
