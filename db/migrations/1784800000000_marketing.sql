-- Authored by: Mohit Singh
--
-- Marketing / Messaging outreach tool — send curated WhatsApp (click-to-chat) + Email to the
-- business owners discovered by the crawler, to promote/onboard them onto the portal. See
-- md/MARKETING.md. WhatsApp is click-to-chat + vCard (no automation, no credentials); Email is
-- SMTP via nodemailer with the password encrypted at rest (AES-256-GCM). All tables are
-- workspace-global (single-operator tool), mirroring crawl_settings' singleton convention.

-- Up Migration

CREATE TYPE message_channel AS ENUM ('whatsapp', 'email');
CREATE TYPE campaign_status AS ENUM ('draft', 'sending', 'completed', 'failed', 'cancelled');
CREATE TYPE recipient_status AS ENUM ('pending', 'sent', 'failed', 'skipped');
CREATE TYPE suppression_reason AS ENUM ('unsubscribed', 'bounced', 'manual');

-- SMTP credentials — singleton (id=1). smtp_password_encrypted is AES-256-GCM (lib/messagingCrypto)
-- and is NEVER returned to the client; reads expose only non-secret fields (see db/messagingCredentials).
CREATE TABLE email_credentials (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  smtp_host TEXT,
  smtp_port INTEGER,
  smtp_secure BOOLEAN NOT NULL DEFAULT TRUE,
  smtp_user TEXT,
  smtp_password_encrypted TEXT,
  from_name TEXT,
  from_email TEXT,
  reply_to TEXT,
  org_address TEXT,        -- physical mailing address for the CAN-SPAM/GDPR email footer
  verified BOOLEAN NOT NULL DEFAULT FALSE,  -- set true after a successful test send
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO email_credentials (id) VALUES (1);

-- Reusable curated message bodies. whatsapp body = plain text; email body = HTML. Both support
-- {business_name}/{business_type}/{location}/{city} placeholders (lib/placeholders).
CREATE TABLE message_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel message_channel NOT NULL,
  name TEXT NOT NULL,
  subject TEXT,            -- email only
  body TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_templates_channel ON message_templates(channel, created_at DESC);

-- Inline email images, attached by `cid` at send time so the email renders offline with no
-- external hosting dependency. Bytes live in the DB (modest size, avoids another volume).
CREATE TABLE message_template_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES message_templates(id) ON DELETE CASCADE,
  cid TEXT NOT NULL,       -- Content-ID referenced as <img src="cid:..."> in the HTML body
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, cid)
);

-- One send run. subject/body are SNAPSHOTTED at create time so editing a template later never
-- rewrites campaign history.
CREATE TABLE campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel message_channel NOT NULL,
  template_id UUID REFERENCES message_templates(id) ON DELETE SET NULL,
  subject TEXT,
  body TEXT NOT NULL,
  status campaign_status NOT NULL DEFAULT 'draft',
  total_count INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ
);
CREATE INDEX idx_campaigns_created_at ON campaigns(created_at DESC);

-- Per-business row for a campaign. For whatsapp, wa_link is the click-to-chat URL and status flips
-- to 'sent' when the operator clicks it (we can't confirm real delivery for click-to-chat). For
-- email, the send loop drives status server-side.
CREATE TABLE campaign_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  business_name TEXT NOT NULL,
  business_type TEXT,
  location TEXT,
  phone TEXT,              -- normalized toward E.164
  email TEXT,
  wa_link TEXT,            -- whatsapp only
  status recipient_status NOT NULL DEFAULT 'pending',
  error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_campaign_recipients_campaign ON campaign_recipients(campaign_id);
-- Dedup guard within a campaign: one row per (phone|email) pair. COALESCE so NULLs don't defeat it.
CREATE UNIQUE INDEX ux_campaign_recipients_dedup
  ON campaign_recipients(campaign_id, COALESCE(phone, ''), COALESCE(lower(email), ''));

-- Email opt-out / hard-bounce list. Checked before every email send; the public /unsubscribe
-- endpoint inserts here.
CREATE TABLE email_suppressions (
  email TEXT PRIMARY KEY,  -- always stored lowercased
  reason suppression_reason NOT NULL DEFAULT 'unsubscribed',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE IF EXISTS email_suppressions;
DROP TABLE IF EXISTS campaign_recipients;
DROP TABLE IF EXISTS campaigns;
DROP TABLE IF EXISTS message_template_images;
DROP TABLE IF EXISTS message_templates;
DROP TABLE IF EXISTS email_credentials;
DROP TYPE IF EXISTS suppression_reason;
DROP TYPE IF EXISTS recipient_status;
DROP TYPE IF EXISTS campaign_status;
DROP TYPE IF EXISTS message_channel;
