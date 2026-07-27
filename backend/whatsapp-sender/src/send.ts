#!/usr/bin/env node
/** Authored by: Mohit Singh */
//
// Terminal entry point: `npm run send -- --campaign <id> [--media <path>]`. Wraps campaignRunner's
// shared send loop and prints progress to the console — for operators who prefer a plain CLI over
// the local control-server agent (see agent.ts / README.md).
import "dotenv/config";
import path from "node:path";
import { runCampaign } from "./campaignRunner.js";

function parseArgs(argv: string[]): { campaignId: string; mediaPath?: string } {
  let campaignId: string | undefined;
  let mediaPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--campaign") campaignId = argv[++i];
    if (argv[i] === "--media") mediaPath = argv[++i];
  }
  if (!campaignId) {
    console.error("Usage: npm run send -- --campaign <id> [--media <path>]");
    process.exit(1);
  }
  return mediaPath ? { campaignId, mediaPath } : { campaignId };
}

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:4010";
const API_EMAIL = process.env.API_EMAIL;
const API_PASSWORD = process.env.API_PASSWORD;
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS ?? 25_000);
const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS ?? 50_000);
const DAILY_CAP = Number(process.env.DAILY_CAP ?? 40);
const STATE_FILE =
  process.env.STATE_FILE ?? path.resolve(process.cwd(), ".whatsapp-sender-state.json");

async function main(): Promise<void> {
  const { campaignId, mediaPath } = parseArgs(process.argv.slice(2));

  if (!API_EMAIL || !API_PASSWORD) {
    console.error(
      "Set API_EMAIL and API_PASSWORD (env or .env) — the operator account to send as.",
    );
    process.exit(1);
  }

  console.log(
    "\n⚠️  This automates a real WhatsApp Web session outside WhatsApp's Business API terms.",
  );
  console.log("    Your number can be rate-limited or banned. Test on a secondary number first.\n");

  await runCampaign(
    {
      apiBaseUrl: API_BASE_URL,
      email: API_EMAIL,
      password: API_PASSWORD,
      campaignId,
      ...(mediaPath ? { mediaPath } : {}),
      minDelayMs: MIN_DELAY_MS,
      maxDelayMs: MAX_DELAY_MS,
      dailyCap: DAILY_CAP,
      stateFilePath: STATE_FILE,
    },
    (p) => console.log(p.lastMessage + (p.done ? "" : ` (${p.sent + p.failed}/${p.total})`)),
  );
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
