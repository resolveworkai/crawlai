/** Authored by: Mohit Singh */
import { describe, expect, it } from "vitest";
import {
  canSend,
  freshState,
  normalizeState,
  randomDelayMs,
  recordSend,
  todayKey,
} from "./rateLimiter.js";

describe("todayKey / freshState", () => {
  it("formats as YYYY-MM-DD and starts a zeroed counter", () => {
    const now = new Date("2026-03-05T12:00:00Z");
    expect(todayKey(now)).toBe("2026-03-05");
    expect(freshState(now)).toEqual({ date: "2026-03-05", sentToday: 0 });
  });
});

describe("normalizeState", () => {
  it("returns a fresh state when null (first run)", () => {
    const now = new Date("2026-03-05T12:00:00Z");
    expect(normalizeState(null, now)).toEqual({ date: "2026-03-05", sentToday: 0 });
  });

  it("keeps today's state as-is", () => {
    const now = new Date("2026-03-05T12:00:00Z");
    const state = { date: "2026-03-05", sentToday: 7 };
    expect(normalizeState(state, now)).toEqual(state);
  });

  it("rolls over to a fresh zeroed state on a new day (the daily cap resets)", () => {
    const now = new Date("2026-03-06T09:00:00Z");
    const yesterday = { date: "2026-03-05", sentToday: 40 };
    expect(normalizeState(yesterday, now)).toEqual({ date: "2026-03-06", sentToday: 0 });
  });
});

describe("canSend / recordSend", () => {
  it("allows sends under the daily cap and blocks at/over it", () => {
    expect(canSend({ date: "d", sentToday: 39 }, 40)).toBe(true);
    expect(canSend({ date: "d", sentToday: 40 }, 40)).toBe(false);
    expect(canSend({ date: "d", sentToday: 41 }, 40)).toBe(false);
  });

  it("recordSend increments without mutating the input", () => {
    const before = { date: "d", sentToday: 5 };
    const after = recordSend(before);
    expect(after).toEqual({ date: "d", sentToday: 6 });
    expect(before).toEqual({ date: "d", sentToday: 5 });
  });
});

describe("randomDelayMs", () => {
  it("stays within [min, max) using an injected rand()", () => {
    expect(randomDelayMs(1000, 2000, () => 0)).toBe(1000);
    expect(randomDelayMs(1000, 2000, () => 0.999999)).toBeLessThan(2000);
    expect(randomDelayMs(1000, 2000, () => 0.5)).toBe(1500);
  });

  it("throws if the range is inverted", () => {
    expect(() => randomDelayMs(2000, 1000)).toThrow();
  });
});
