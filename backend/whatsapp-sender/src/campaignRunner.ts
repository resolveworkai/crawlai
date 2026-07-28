/** Authored by: Mohit Singh */
//
// The shared send loop — used by both the CLI (send.ts) and the local control-server agent
// (agent.ts) so the two entry points can't drift. Fetches a WhatsApp campaign's pending recipients,
// sends each via WaSession with a randomized delay + persisted daily cap (rateLimiter.ts), and
// records the outcome back through the same mark-sent/mark-failed endpoints the manual UI uses.
import { ApiClient } from "./apiClient.js";
import { WaSession } from "./waSession.js";
import {
  canSend,
  loadState,
  normalizeState,
  randomDelayMs,
  recordSend,
  saveState,
} from "./rateLimiter.js";

export interface RunOptions {
  apiBaseUrl: string;
  email: string;
  password: string;
  campaignId: string;
  mediaPath?: string;
  minDelayMs: number;
  maxDelayMs: number;
  dailyCap: number;
  stateFilePath: string;
}

/** One row of the live send log surfaced in the UI — the operator needs to see WHICH number each
 * message actually went to and whether it landed, not just a running total. */
export interface SendLogEntry {
  at: string; // ISO timestamp
  businessName: string;
  phone: string;
  ok: boolean;
  error?: string;
}

export interface RunProgress {
  total: number;
  sent: number;
  failed: number;
  remaining: number;
  lastMessage: string;
  done: boolean;
  log: SendLogEntry[];
}

/** Cooperative stop flag — the agent's /stop handler sets `stopped = true`; the loop checks it
 * between sends (not mid-send, so a message that already started always finishes cleanly). */
export interface StopSignal {
  stopped: boolean;
}

function decodeWaLinkText(waLink: string): string {
  // URLSearchParams.get() already percent-decodes the value — a SECOND decodeURIComponent() here
  // used to throw "URI malformed" on any message containing a lone `%` (e.g. "grow bookings by
  // 30%"), which is common enough in real marketing copy that it broke nearly every send.
  const url = new URL(waLink);
  return url.searchParams.get("text") ?? "";
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runCampaign(
  options: RunOptions,
  onProgress: (p: RunProgress) => void,
  stopSignal: StopSignal = { stopped: false },
): Promise<void> {
  const api = new ApiClient(options.apiBaseUrl);
  await api.login(options.email, options.password);

  const { campaign, recipients } = await api.getCampaign(options.campaignId);
  if (campaign.channel !== "whatsapp") {
    throw new Error(
      `Campaign ${options.campaignId} is a ${campaign.channel} campaign, not whatsapp.`,
    );
  }

  const pending = recipients.filter((r) => r.status === "pending" && r.phone && r.wa_link);
  let sent = 0;
  let failed = 0;
  const total = pending.length;

  const log: SendLogEntry[] = [];
  const report = (lastMessage: string, done = false): void =>
    onProgress({ total, sent, failed, remaining: total - sent - failed, lastMessage, done, log });

  if (total === 0) {
    report("Nothing to send — no pending recipients with a usable phone.", true);
    return;
  }

  let state = normalizeState(loadState(options.stateFilePath));
  const wa = new WaSession();
  await wa.open();
  report(
    `WhatsApp Web ready. ${total} pending, ${state.sentToday}/${options.dailyCap} sent today.`,
  );

  try {
    for (const r of pending) {
      if (stopSignal.stopped) {
        report("Stopped by operator.", true);
        return;
      }
      if (!canSend(state, options.dailyCap)) {
        report(`Daily cap (${options.dailyCap}) reached — stopping.`, true);
        return;
      }
      const digits = r.phone!.replace(/[^\d]/g, "");
      const text = decodeWaLinkText(r.wa_link!);
      try {
        await wa.sendTo(digits, text, options.mediaPath);
        await api.markSent(options.campaignId, r.id);
        state = recordSend(state);
        saveState(options.stateFilePath, state);
        sent += 1;
        log.push({
          at: new Date().toISOString(),
          businessName: r.business_name,
          phone: r.phone!,
          ok: true,
        });
        report(`Sent → ${r.business_name}`);
      } catch (err) {
        failed += 1;
        const message = (err as Error).message.slice(0, 500);
        await api.markFailed(options.campaignId, r.id, message).catch(() => undefined);
        log.push({
          at: new Date().toISOString(),
          businessName: r.business_name,
          phone: r.phone!,
          ok: false,
          error: message,
        });
        report(`Failed → ${r.business_name}: ${message}`);
      }
      if (stopSignal.stopped) {
        report("Stopped by operator.", true);
        return;
      }
      await delay(randomDelayMs(options.minDelayMs, options.maxDelayMs));
    }
  } finally {
    await wa.close();
  }

  report("Done.", true);
}
