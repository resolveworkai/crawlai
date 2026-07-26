/** Authored by: Mohit Singh */
//
// Campaign + recipient persistence. A campaign snapshots its subject/body at create time so editing
// a template later never rewrites history (see the migration). Recipients are inserted in one
// batched statement; the send loop / click-to-chat then drives their status.
import { pool } from "./pool.js";
import type {
  Campaign,
  CampaignRecipient,
  CampaignStatus,
  MessageChannel,
  RecipientStatus,
} from "../types/db.js";
import type { Recipient } from "../lib/recipientParse.js";

export async function createCampaign(input: {
  channel: MessageChannel;
  templateId: string | null;
  subject: string | null;
  body: string;
  createdBy: string | null;
  recipients: { recipient: Recipient; waLink: string | null }[];
}): Promise<Campaign> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<Campaign>(
      `INSERT INTO campaigns (channel, template_id, subject, body, total_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        input.channel,
        input.templateId,
        input.subject,
        input.body,
        input.recipients.length,
        input.createdBy,
      ],
    );
    const campaign = rows[0]!;

    // Batch-insert recipients. ON CONFLICT DO NOTHING against the per-campaign dedup unique index
    // is a belt-and-braces guard (the caller already deduped) — never a hard error mid-insert.
    for (const { recipient, waLink } of input.recipients) {
      await client.query(
        `INSERT INTO campaign_recipients
           (campaign_id, business_name, business_type, location, phone, email, wa_link)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING`,
        [
          campaign.id,
          recipient.businessName,
          recipient.businessType,
          recipient.location,
          recipient.phone,
          recipient.email,
          waLink,
        ],
      );
    }
    await client.query("COMMIT");
    return campaign;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listCampaigns(limit = 50): Promise<Campaign[]> {
  const { rows } = await pool.query<Campaign>(
    "SELECT * FROM campaigns ORDER BY created_at DESC LIMIT $1",
    [limit],
  );
  return rows;
}

export async function findCampaignById(id: string): Promise<Campaign | null> {
  const { rows } = await pool.query<Campaign>("SELECT * FROM campaigns WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function listCampaignRecipients(campaignId: string): Promise<CampaignRecipient[]> {
  const { rows } = await pool.query<CampaignRecipient>(
    "SELECT * FROM campaign_recipients WHERE campaign_id = $1 ORDER BY created_at ASC",
    [campaignId],
  );
  return rows;
}

export async function setCampaignStatus(
  id: string,
  status: CampaignStatus,
  opts: { started?: boolean; finished?: boolean } = {},
): Promise<void> {
  await pool.query(
    `UPDATE campaigns SET status = $2,
       started_at = CASE WHEN $3::boolean THEN now() ELSE started_at END,
       finished_at = CASE WHEN $4::boolean THEN now() ELSE finished_at END
     WHERE id = $1`,
    [id, status, opts.started ?? false, opts.finished ?? false],
  );
}

// Recompute the campaign's aggregate counts from its recipient rows — called after the send loop so
// the numbers always reconcile with reality rather than drifting from incremental updates.
export async function refreshCampaignCounts(id: string): Promise<Campaign> {
  const { rows } = await pool.query<Campaign>(
    `UPDATE campaigns c SET
        sent_count    = agg.sent,
        failed_count  = agg.failed,
        skipped_count = agg.skipped
      FROM (
        SELECT
          count(*) FILTER (WHERE status = 'sent')    AS sent,
          count(*) FILTER (WHERE status = 'failed')  AS failed,
          count(*) FILTER (WHERE status = 'skipped') AS skipped
        FROM campaign_recipients WHERE campaign_id = $1
      ) agg
      WHERE c.id = $1 RETURNING c.*`,
    [id],
  );
  return rows[0]!;
}

export async function setRecipientStatus(
  recipientId: string,
  status: RecipientStatus,
  error: string | null = null,
): Promise<CampaignRecipient | null> {
  const { rows } = await pool.query<CampaignRecipient>(
    // Bind $2 as plain text (deduced from the `$2 = 'sent'` comparison) and cast it to the enum in
    // the SET — otherwise PG deduces two conflicting types for the same parameter (enum vs text).
    `UPDATE campaign_recipients SET status = $2::recipient_status, error = $3,
        sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END
      WHERE id = $1 RETURNING *`,
    [recipientId, status, error],
  );
  return rows[0] ?? null;
}
