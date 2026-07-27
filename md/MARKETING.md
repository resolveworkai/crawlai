<!-- Authored by: Mohit Singh -->

# Marketing / Messaging Outreach Tool

Turns the businesses the crawler discovered into an outreach list and lets the operator promote /
onboard them onto **Portal** (`https://portal.c7corp.com`) over **WhatsApp** and **Email** — without
manually copying numbers or emails into a phone or mail client. Sidebar group **Marketing** →
`Messaging` (`/marketing`) composer + `Campaigns` (`/marketing/campaigns`) history.

## The two channels — deliberate design

- **WhatsApp = click-to-chat + vCard by default, real one-click automation as an explicit, informed
  opt-in.** Per business we build a `https://wa.me/<number>?text=<message>` deep link that opens
  WhatsApp with the curated message pre-filled; the operator presses **Send** — zero automation, zero
  ban risk, no credentials. A one-time **vCard (.vcf)** export saves every business into the
  operator's phone contacts *by business name*, so chats are labelled correctly. On top of that,
  `backend/whatsapp-sender/` (a separate local-only package, **never** part of the shared Docker
  stack) can drive the operator's own WhatsApp Web session via Playwright for genuine bulk send —
  built after the operator explicitly re-confirmed they wanted true automation, knowing it violates
  WhatsApp's Business API terms and risks the number being rate-limited/banned. See its own README
  for the full risk disclaimer and guardrails.
- **Email = SMTP blast, fully compliant.** The operator's own SMTP (nodemailer), formatted **HTML
  with inline (CID) images and plain attachments**, `{placeholder}` substitution per recipient,
  throttled sending, a test-send, and true one-click bulk. Every email carries an **unsubscribe**
  footer + `List-Unsubscribe` header; a **suppression list** auto-skips anyone who opted out or
  hard-bounced.

## Recipients — deduped to unique businesses

Three sources, mergeable in one preview: an uploaded **CSV/XLSX** (e.g. a downloaded OCR export),
one or more **finished OCR jobs** picked straight from the DB (`ocr_businesses ⨝ ocr_jobs` — the
job's `query`→business type, `location`→location), and/or saved **Contacts** (`marketing_contacts` —
manually typed in via the composer's "+ Add business" form, reusable across every future campaign).
All three are merged and **deduped to unique businesses** (identity: normalized phone → email →
name+location) each carrying name / type / location / phone / email. Phones are normalized toward
E.164 — including inferring `+91` for a bare 10-digit Indian mobile number, so the same business
listed with vs. without a country code collapses to one recipient rather than surviving dedup as a
duplicate. `lib/recipientParse.ts` (unit-tested), surfaced by `POST /marketing/recipients/preview`
(no persistence for upload/OCR-derived rows — just the table + counts; contacts persist separately).

## Placeholders

`{business_name}` `{business_type}` `{location}` `{city}` (city = first part of location). Shared by
the email body/subject, the wa.me link, and the live preview via `lib/placeholders.ts` — unknown
tokens are left literal so a typo is visible, not silently blanked.

## Curated templates

Seeded (idempotent **upsert** — re-running `npm run seed` updates existing template content, not
just inserts missing rows) via `backend/api/src/scripts/seed.ts`: one generic + one-or-more per
business type (Gym, Library ×2, Coaching), for both channels. Every message links
`https://portal.c7corp.com` as a **plain, standalone URL** (not wrapped in "click here"-style anchor
text) so WhatsApp/email clients can auto-generate a link-preview card. Copy is specific about real
Portal features but avoids unverifiable claims ("100% conversion" etc. — reads as spam, erodes trust
in cold outreach). Templates optionally carry a `business_type` (nullable = generic); the composer's
template picker groups "Recommended for `<type>`" first, based on the loaded recipients' dominant
business type.

## Data model — `db/migrations/*marketing*.sql`

`email_credentials` (singleton; SMTP password **AES-256-GCM** at rest, never returned) ·
`message_templates` (+ nullable `business_type`) + `message_template_images` (bytes + `is_inline` —
`true` = cid-referenced inline image, `false` = a plain attachment like a PDF brochure) · `campaigns`
(subject/body **snapshotted** at create so editing a template never rewrites history) ·
`campaign_recipients` (per-business status + `wa_link` + `error`) · `email_suppressions` ·
`marketing_contacts` (manually-added, reusable recipients — separate from the crawler's
`businesses`/`ocr_businesses` tables, different lifecycle).

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
  volume stays low/manual. WhatsApp browser automation (`backend/whatsapp-sender/`) is a separate,
  explicitly-opted-into risk tier — see its README before enabling it.

## Reports — know what's failing, per campaign

- **In-app**: a "Failed" panel on the campaign's Send step lists every failed recipient + its error
  text inline (both channels) — no download needed just to see what went wrong.
- **Excel export**: `GET /marketing/campaigns/:id/export` (`services/campaignExportService.ts`, xlsx
  via exceljs) — one report per campaign ("group"): a Summary sheet (counts), a Recipients sheet
  (every row + status + error + sent_at), and a "Failed only" sheet (omitted if nothing failed).
  Available at any point (draft/sending/completed), so a partial run can be reviewed mid-flight.

## API (`routes/marketing.ts`, `requireAuth`; mutations `requireRole('operator')`)

| Route | Behaviour |
|---|---|
| `POST /marketing/recipients/preview` | `{upload?, ocrJobIds?, contactIds?}` → deduped recipients + counts |
| `GET/POST/PATCH/DELETE /marketing/contacts` | manually-added, reusable recipients |
| `GET/PUT /marketing/email-credentials` · `POST …/test` | masked read; encrypted write; test-send marks verified |
| `GET/POST/PATCH/DELETE /marketing/templates` · `POST …/:id/images` (+`isInline`) · `GET …/:id/images` | template CRUD + inline images / attachments |
| `POST /marketing/campaigns` · `GET /marketing/campaigns[/:id]` | create (snapshot + wa links) / list / detail |
| `POST /marketing/campaigns/:id/send` | background email blast (poll the campaign for progress) |
| `GET /marketing/campaigns/:id/vcard` | download the `.vcf` (contacts by business name) |
| `GET /marketing/campaigns/:id/export` | Excel report (Summary / Recipients / Failed-only sheets) |
| `POST /marketing/campaigns/:id/recipients/:rid/mark-sent` \| `.../mark-failed` | WhatsApp: mark after the operator (or the automation agent) sends/fails |
| `GET/POST/DELETE /marketing/suppressions` · public `GET /unsubscribe` | opt-out management |

## Config / deps

New backend dep: `nodemailer` (lazy-imported in `emailService` so it stays out of the hot import
graph). New env: `MESSAGING_ENCRYPTION_KEY` (optional; gates email credentials) + `APP_PUBLIC_URL`
(base for the emailed unsubscribe link — must be where `/unsubscribe` is publicly reachable).

## Frontend

`src/routes/marketing.tsx` (tabs WhatsApp | Email; 3 steps: Recipients [+ "Add business" / saved
Contacts] → Message [template picker w/ recommendations, attachments] → Send [report download,
Failed panel, and for WhatsApp: the automated-send panel]) · `src/routes/marketing.campaigns.tsx`
(history) · `src/hooks/useMarketing.ts` (main backend API) · `src/hooks/useWhatsappAgent.ts` (talks
directly to the local automation agent at `127.0.0.1:8787` — a *different* process from the main
backend; "agent not detected" is the expected default state, not an error).

## WhatsApp browser automation — `backend/whatsapp-sender/`

A separate local package (sibling to `backend/api`/`backend/worker`), **never** added to
`docker-compose.yml` — it runs on the operator's own machine only, since WhatsApp Web login is tied
to a physical phone scanning a QR code, and the risky part of this feature should stay under the
operator's direct, watchable control rather than running unattended on a shared server.

- `waSession.ts` — a **visible** (headed, never headless) Playwright Chromium session, persistent
  profile (`.whatsapp-sender-profile/`, gitignored) so the QR-code login is a one-time cost.
- `rateLimiter.ts` — randomized delay between sends + a persisted daily send cap
  (`.whatsapp-sender-state.json`, gitignored, rolls over at local midnight) — a fixed cadence is
  trivially fingerprinted as automation.
- `apiClient.ts` — a thin client for the *already-shipped* Marketing API (login, fetch a campaign's
  pending recipients, `mark-sent`/`mark-failed`) — the automation is purely a consumer of endpoints
  the manual UI already uses, no separate tracking.
- `campaignRunner.ts` — the shared send loop (used by both the CLI and the agent so they can't
  drift): fetch pending → rate-limit → send → record outcome → repeat, with cooperative stop support.
- `trialSend.ts` / `testSend.ts` — **run this before ever pointing the automation at real leads.**
  Sends one message to `TEST_PHONE_NUMBER` (default `+919560397112`) with no campaign/API involved,
  to confirm the browser automation itself actually works.
- `agent.ts` — local `127.0.0.1:8787` control server (`POST /start`, `GET /status`, `POST /stop`,
  `POST /test-send`), CORS-restricted to the frontend's own origin — this is what the campaign page's
  **⚡ Start Automated Send** button and **Send test** button call directly from the browser.
- `send.ts` — a plain CLI (`npm run send -- --campaign <id> [--media <path>]`) for operators who
  prefer a terminal workflow over the agent/browser button. `--media` attaches a local file to every
  send — the one thing click-to-chat links can never do (`wa.me`/`web.whatsapp.com/send` only accept
  pre-filled text, no file parameter).

Full setup, guardrail defaults, and the ban-risk disclaimer: `backend/whatsapp-sender/README.md`.
Testing scope: `rateLimiter.ts`/`apiClient.ts` are unit-tested (pure logic / mocked fetch); the real
browser-automation flow can't be verified in CI (needs a real phone + WhatsApp account) — verify
manually via `npm run test-send`, then a small real campaign.
