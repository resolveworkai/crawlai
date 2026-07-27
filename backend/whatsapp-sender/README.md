<!-- Authored by: Mohit Singh -->

# WhatsApp Sender Agent

Local-only automation for the Marketing tool's WhatsApp campaigns. Drives your own, already-logged-in
WhatsApp Web session via a visible (headed) Playwright browser to actually send each queued message —
true one-click bulk send, as opposed to the manual click-to-chat links the Marketing composer also
offers.

## ⚠️ Read this before running it

This automates a **real WhatsApp Web session** outside WhatsApp's official Business API terms.
WhatsApp can rate-limit or ban a number it detects sending bulk automated messages. There is no way
to eliminate that risk — only reduce it:

- **Test on a secondary/non-critical number first**, not your main business line, until you're
  confident in the volume and cadence you're running.
- The built-in guardrails (randomized delay between sends, a hard daily cap) are defaults, not
  guarantees — raising them raises the risk.
- This tool **never** runs on the shared server. It only runs on your own machine, with a visible
  browser window you can watch and close at any time to stop it immediately.
- If in doubt, use the manual click-to-chat flow in the Marketing composer instead — zero risk, just
  more clicks.

## One-time setup

⚠️ Every command below must be run **from this directory** (`backend/whatsapp-sender`), not
`backend/` or the repo root — `npm run <script>` only sees scripts defined in the closest
`package.json` **above** your current directory; run it from the wrong folder and npm silently picks
up a different project's scripts instead of failing loudly.

```bash
cd backend/whatsapp-sender
npm install
npx playwright install chromium   # downloads the browser Playwright drives
cp .env.example .env              # then fill in API_EMAIL/API_PASSWORD (your Marketing login)
```

## First run — scanning the QR code, then a trial send

```bash
npm run test-send
```

A visible Chromium window opens to web.whatsapp.com. Scan the QR code with your phone (WhatsApp →
Linked Devices) the same way you would for the regular web.whatsapp.com site. The session is saved
to `.whatsapp-sender-profile/` (gitignored, never committed) — you only do this once; every later run
reuses it. This command then sends one trial message to `TEST_PHONE_NUMBER` (`.env.example` default:
`+919560397112` — set your own number) so you can confirm the automation actually works before it
ever touches a real business lead:

```bash
npm run test-send                                  # default trial message
npm run test-send -- --message "Custom trial text"  # or your own
```

Check that phone. If the message arrived correctly, you're ready for a real campaign. If it didn't
(wrong composer selector, chat never opened, etc.), fix that here first — never debug against real
recipients.

## Running a campaign

**CLI** (prints progress to the terminal, exits when done):

```bash
npm run send -- --campaign <campaignId>
npm run send -- --campaign <campaignId> --media ./flyer.png   # attach an image/file to every send
```

**Agent** (a local control server the Marketing campaign page's "Start Automated Send" button calls
directly from the browser — start it once and leave it running):

```bash
npm run agent
```

Then open the campaign in the Marketing UI and click **⚡ Start Automated Send**. If the button
reports the agent isn't reachable, this command isn't running — start it first. The agent also
exposes `POST /test-send` (same trial-send capability as `npm run test-send`, for a "Send test"
button in the UI).

**Run both the backend API and the agent together** (local, non-Docker dev only — see below):

```bash
npm run dev:with-backend
```

This starts `backend/api`'s `npm run dev` and this package's `npm run agent` side by side (via
`concurrently`), so you don't have to open two terminals. **Only for local dev** — the deployed
Docker backend can never run this: a Docker container has no visible desktop for the WhatsApp Web
QR-scan/browser session, and the agent is deliberately never added to `docker-compose.yml` (see the
"⚠️ Read this before running it" section above). If your backend is running via `docker compose up`,
just start `npm run agent` here separately — it talks to the backend over HTTP either way, container
or not.

## Guardrails (env vars — see `.env.example`)

| Var | Default | What it does |
|---|---|---|
| `MIN_DELAY_MS` / `MAX_DELAY_MS` | 25000 / 50000 | Randomized delay between sends — a fixed cadence is trivially fingerprinted as automation. |
| `DAILY_CAP` | 40 | Hard stop for the day, persisted in `.whatsapp-sender-state.json` (gitignored) so restarting the script doesn't reset the budget. Resets automatically at midnight (local date). |

Raising `DAILY_CAP` or shrinking the delay window increases ban risk — change these deliberately, not
by default.

## How a send is recorded

Every send/failure calls back to the same backend the manual UI uses
(`POST /marketing/campaigns/:id/recipients/:rid/mark-sent` or `.../mark-failed`) — no separate
tracking exists here. The campaign page's progress bar and history are always the source of truth.

## What this can't do

- **Can't send to a number that never messaged you first with a Business API template** — this is
  click-to-chat/Web automation, not the official Cloud API, so that restriction doesn't apply here,
  but it also means there's no delivery receipt beyond "the Send button was pressed."
- **Attachments only work through this agent**, not the manual click-to-chat links — `wa.me`/
  `web.whatsapp.com/send` only accept pre-filled text, no file parameter (see `md/MARKETING.md`).

## Testing

```bash
npm test
```

Covers the parts that don't need a real WhatsApp account: `rateLimiter.ts` (randomized delay bounds,
daily-cap rollover) and `apiClient.ts` (mocked `fetch`). The actual browser-automation send flow
(`waSession.ts`, `campaignRunner.ts`) can't be verified in CI — it needs a real phone and WhatsApp
account. Verify it manually: run `npm run send` against a small (2–3 recipient) test campaign and
confirm each chat actually opens and sends.
