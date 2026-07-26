<!-- Authored by: Mohit Singh -->

# Marketing / Messaging Outreach Tool

Turns the businesses the crawler discovered into an outreach list and lets the operator promote /
onboard them onto the portal over **WhatsApp** and **Email** — without manually copying numbers or
emails into a phone or mail client. New sidebar group **Marketing** → `Messaging` (`/marketing`)
composer + `Campaigns` (`/marketing/campaigns`) history.

## The two channels — deliberate design

- **WhatsApp = click-to-chat + vCard (no automation).** 100% ToS-safe, zero ban risk, no WhatsApp
  credentials. Per business we build a `https://wa.me/<number>?text=<message>` deep link that opens
  WhatsApp with the curated message pre-filled; the operator presses **Send**. This is genuinely
  manual — one contact at a time, NOT auto-bulk. A one-time **vCard (.vcf)** export saves every
  business into the operator's phone contacts *by business name*, so chats are labelled correctly.
  > Automating a personal number (whatsapp-web.js / Baileys) was explicitly declined — bulk
  > cold-messaging a scraped list is the #1 cause of number bans. Not built.
- **Email = SMTP blast, fully compliant.** The operator's own SMTP (nodemailer), formatted **HTML
  with inline (CID) images**, `{placeholder}` substitution per recipient, throttled sending, a
  test-send, and true one-click bulk. Every email carries an **unsubscribe** footer +
  `List-Unsubscribe` header; a **suppression list** auto-skips anyone who opted out or hard-bounced.

## Recipients — deduped to unique businesses

Source = an uploaded **CSV/XLSX** (e.g. a downloaded OCR export) AND/or one or more **finished OCR
jobs** picked straight from the DB (`ocr_businesses ⨝ ocr_jobs` — the job's `query`→business type,
`location`→location). Both are merged and **deduped to unique businesses** (identity: normalized
phone → email → name+location) each carrying name / type / location / phone / email. Phones are
normalized toward E.164; emails lowercased. `lib/recipientParse.ts` (unit-tested), surfaced by
`POST /marketing/recipients/preview` (no persistence — just the table + counts).

## Placeholders

`{business_name}` `{business_type}` `{location}` `{city}` (city = first part of location). Shared by
the email body/subject, the wa.me link, and the live preview via `lib/placeholders.ts` — unknown
tokens are left literal so a typo is visible, not silently blanked.

## Data model — `db/migrations/*marketing.sql`

`email_credentials` (singleton; SMTP password **AES-256-GCM** at rest, never returned) ·
`message_templates` + `message_template_images` (inline CID image bytes) · `campaigns`
(subject/body **snapshotted** at create so editing a template never rewrites history) ·
`campaign_recipients` (per-business status + `wa_link`) · `email_suppressions`.

## Security / compliance

- SMTP password encrypted with `lib/messagingCrypto.ts` (AES-256-GCM, key = `MESSAGING_ENCRYPTION_KEY`
  env — 64 hex chars). Absent key ⇒ email-credential save/test refuse (`isEncryptionAvailable()`
  false); wa.me/vCard need no secret and keep working. **Never** returned to the client; decrypted
  only in `services/emailService.ts`.
- Unsubscribe link = HMAC(email) token (`lib/unsubscribeToken.ts`, keyed on `JWT_SECRET`); the
  public `GET /unsubscribe` verifies it (no auth, rate-limited) → adds to `email_suppressions`.
- Suppression checked before every email send; throttle (~1/s) between sends; operator-role gated
  mutations. CAN-SPAM/GDPR footer = org address + unsubscribe.
- **Scope note:** cold B2B outreach to scraped contacts carries the same acknowledged legal/ToS
  posture as this app's Maps scraping — the guardrails above are the responsible-use minimum;
  volume stays low/manual.

## API (`routes/marketing.ts`, `requireAuth`; mutations `requireRole('operator')`)

| Route | Behaviour |
|---|---|
| `POST /marketing/recipients/preview` | `{upload? , ocrJobIds?}` → deduped recipients + counts |
| `GET/PUT /marketing/email-credentials` · `POST …/test` | masked read; encrypted write; test-send marks verified |
| `GET/POST/PATCH/DELETE /marketing/templates` · `POST …/:id/images` | template CRUD + inline images |
| `POST /marketing/campaigns` · `GET /marketing/campaigns[/:id]` | create (snapshot + wa links) / list / detail |
| `POST /marketing/campaigns/:id/send` | background email blast (poll the campaign for progress) |
| `GET /marketing/campaigns/:id/vcard` | download the `.vcf` (contacts by business name) |
| `POST /marketing/campaigns/:id/recipients/:rid/mark-sent` | WhatsApp: mark after the operator clicks the link |
| `GET/POST/DELETE /marketing/suppressions` · public `GET /unsubscribe` | opt-out management |

## Config / deps

New backend dep: `nodemailer` (lazy-imported in `emailService` so it stays out of the hot import
graph). New env: `MESSAGING_ENCRYPTION_KEY` (optional; gates email credentials) + `APP_PUBLIC_URL`
(base for the emailed unsubscribe link — must be where `/unsubscribe` is publicly reachable).

## Frontend

`src/routes/marketing.tsx` (tabs WhatsApp | Email; 3 steps: Recipients → Message → Send; SMTP form;
WhatsApp wizard) · `src/routes/marketing.campaigns.tsx` (history) · `src/hooks/useMarketing.ts`.
