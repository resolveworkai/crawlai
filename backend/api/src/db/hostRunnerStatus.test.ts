/** Authored by: Mohit Singh */
import { describe, expect, it } from "vitest";
import {
  evaluateRunnerHealth,
  STALE_THRESHOLD_MS,
  type HostRunnerStatus,
} from "./hostRunnerStatus.js";

const NOW = Date.parse("2026-11-15T08:00:00Z");

function row(overrides: Partial<HostRunnerStatus> = {}): HostRunnerStatus {
  return {
    runner_name: "noon",
    cdp_reachable: true,
    last_error: null,
    last_heartbeat_at: new Date(NOW - 5_000),
    ...overrides,
  };
}

// This one function decides both the dashboard banner and whether an Amazon.in job is accepted at
// all (Amazon.in must never run headless), so every "why not" branch is pinned down here.
describe("evaluateRunnerHealth", () => {
  it("is healthy with a fresh heartbeat and a reachable Chrome", () => {
    expect(evaluateRunnerHealth(row(), NOW)).toEqual({ stale: false, healthy: true, reason: null });
  });

  it("reports a runner that never started as unhealthy, with a reason", () => {
    const h = evaluateRunnerHealth(undefined, NOW);
    expect(h.healthy).toBe(false);
    expect(h.stale).toBe(true);
    expect(h.reason).toMatch(/never started/);
  });

  it("treats a heartbeat older than the threshold as a dead process", () => {
    const h = evaluateRunnerHealth(
      row({ last_heartbeat_at: new Date(NOW - STALE_THRESHOLD_MS - 1_000) }),
      NOW,
    );
    expect(h.healthy).toBe(false);
    expect(h.stale).toBe(true);
    expect(h.reason).toMatch(/stopped responding \(last heartbeat 91s ago\)/);
  });

  it("is still healthy exactly at the threshold boundary", () => {
    const h = evaluateRunnerHealth(
      row({ last_heartbeat_at: new Date(NOW - STALE_THRESHOLD_MS) }),
      NOW,
    );
    expect(h.healthy).toBe(true);
  });

  it("distinguishes a live runner whose Chrome is down, and surfaces the runner's error", () => {
    const h = evaluateRunnerHealth(row({ cdp_reachable: false, last_error: "ECONNREFUSED" }), NOW);
    expect(h.healthy).toBe(false);
    expect(h.stale).toBe(false); // the process is alive — only Chrome is gone
    expect(h.reason).toBe("its Chrome is not reachable: ECONNREFUSED");
  });

  it("omits the error detail when the runner recorded none", () => {
    const h = evaluateRunnerHealth(row({ cdp_reachable: false }), NOW);
    expect(h.reason).toBe("its Chrome is not reachable");
  });
});
