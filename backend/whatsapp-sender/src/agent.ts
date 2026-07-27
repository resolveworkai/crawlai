#!/usr/bin/env node
/** Authored by: Mohit Singh */
//
// Local-only control server the campaign page's "Start Automated Send" button talks to
// (127.0.0.1:8787 by default — see src/routes/marketing.tsx). Run this once with `npm run agent`
// and leave it running on your own machine; it is NEVER deployed to the shared Docker stack (see
// README.md). CORS is restricted to the frontend's own origin — this server accepts no other
// callers, and nothing here is reachable from outside localhost.
import "dotenv/config";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { runCampaign, type RunProgress, type StopSignal } from "./campaignRunner.js";
import { sendTrialMessage } from "./trialSend.js";

const PORT = Number(process.env.AGENT_PORT ?? 8787);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "http://localhost:3000";
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:4010";
const API_EMAIL = process.env.API_EMAIL;
const API_PASSWORD = process.env.API_PASSWORD;
const MIN_DELAY_MS = Number(process.env.MIN_DELAY_MS ?? 25_000);
const MAX_DELAY_MS = Number(process.env.MAX_DELAY_MS ?? 50_000);
const DAILY_CAP = Number(process.env.DAILY_CAP ?? 40);
const STATE_FILE =
  process.env.STATE_FILE ?? path.resolve(process.cwd(), ".whatsapp-sender-state.json");

interface RunHandle {
  campaignId: string;
  stopSignal: StopSignal;
  progress: RunProgress;
}

let current: RunHandle | undefined;

const app = express();
app.use(express.json());
app.use((req: Request, res: Response, next: () => void) => {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.get("/status", (_req: Request, res: Response) => {
  if (!current) {
    res.json({ running: false });
    return;
  }
  res.json({
    running: !current.progress.done,
    campaignId: current.campaignId,
    ...current.progress,
  });
});

// Trial send — confirms the automation actually works (login session, selectors, real delivery)
// before the operator points it at real business leads. No campaign/API involved, just one message
// to TEST_PHONE_NUMBER (default +919560397112, see .env.example).
app.post("/test-send", (req: Request, res: Response) => {
  const { message } = req.body as { message?: string };
  sendTrialMessage(undefined, message)
    .then(() => res.json({ ok: true }))
    .catch((err: unknown) => res.status(500).json({ error: (err as Error).message }));
});

app.post("/start", (req: Request, res: Response) => {
  if (current && !current.progress.done) {
    res.status(409).json({ error: "A campaign is already sending. Stop it first." });
    return;
  }
  const { campaignId, mediaPath } = req.body as { campaignId?: string; mediaPath?: string };
  if (!campaignId) {
    res.status(400).json({ error: "campaignId is required" });
    return;
  }
  if (!API_EMAIL || !API_PASSWORD) {
    res
      .status(500)
      .json({ error: "Agent is missing API_EMAIL/API_PASSWORD — set them in .env and restart." });
    return;
  }

  const stopSignal: StopSignal = { stopped: false };
  current = {
    campaignId,
    stopSignal,
    progress: { total: 0, sent: 0, failed: 0, remaining: 0, lastMessage: "Starting…", done: false },
  };

  void runCampaign(
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
    (progress) => {
      if (current?.campaignId === campaignId) current.progress = progress;
    },
    stopSignal,
  ).catch((err: unknown) => {
    if (current?.campaignId === campaignId) {
      current.progress = {
        ...current.progress,
        lastMessage: `Error: ${(err as Error).message}`,
        done: true,
      };
    }
  });

  res.status(202).json({ ok: true });
});

app.post("/stop", (_req: Request, res: Response) => {
  if (!current || current.progress.done) {
    res.status(404).json({ error: "Nothing is running" });
    return;
  }
  current.stopSignal.stopped = true;
  res.status(202).json({ ok: true });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`WhatsApp sender agent listening on http://127.0.0.1:${PORT} (CORS: ${CORS_ORIGIN})`);
  if (!API_EMAIL || !API_PASSWORD) {
    console.warn(
      "⚠️  API_EMAIL/API_PASSWORD not set — /start will fail until you set them in .env",
    );
  }
});
