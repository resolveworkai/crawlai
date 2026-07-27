/** Authored by: Mohit Singh */
//
// The only guardrail standing between "one-click automated WhatsApp send" and a banned number:
// a randomized delay between sends (spammy tools send at a fixed cadence — trivially fingerprinted)
// plus a hard daily cap persisted across runs (so restarting the script doesn't reset the budget).
// Pure logic here (unit-tested); fs I/O is a thin wrapper below.
import fs from "node:fs";

export interface SendState {
  date: string; // YYYY-MM-DD, local to whoever runs the agent
  sentToday: number;
}

export function todayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function freshState(now: Date = new Date()): SendState {
  return { date: todayKey(now), sentToday: 0 };
}

/** Rolls over to a fresh zeroed state if the stored date isn't today. */
export function normalizeState(state: SendState | null, now: Date = new Date()): SendState {
  if (!state || state.date !== todayKey(now)) return freshState(now);
  return state;
}

export function canSend(state: SendState, dailyCap: number): boolean {
  return state.sentToday < dailyCap;
}

export function recordSend(state: SendState): SendState {
  return { ...state, sentToday: state.sentToday + 1 };
}

/** Random delay in [minMs, maxMs) — `rand` is injectable so tests can assert boundaries without
 * relying on true randomness. */
export function randomDelayMs(
  minMs: number,
  maxMs: number,
  rand: () => number = Math.random,
): number {
  if (maxMs < minMs) throw new Error("maxMs must be >= minMs");
  return Math.floor(minMs + rand() * (maxMs - minMs));
}

// --- fs-backed persistence (not unit-tested — thin I/O wrapper over the pure functions above) ---

export function loadState(path: string): SendState | null {
  try {
    const raw = fs.readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as SendState;
    if (typeof parsed.date === "string" && typeof parsed.sentToday === "number") return parsed;
    return null;
  } catch {
    return null;
  }
}

export function saveState(path: string, state: SendState): void {
  fs.writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}
