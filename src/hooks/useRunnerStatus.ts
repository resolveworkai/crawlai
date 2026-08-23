/** Authored by: Mohit Singh */
//
// Host-runner heartbeat (2026-08-23) — reads what backend/worker's chrome_health.py writes.
// Shared across property-crawl.tsx and ecom-crawl.tsx (the two pages whose jobs depend on a host
// runner attached to the operator's real Chrome) rather than duplicated, since it's the exact
// same status surface for both.
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";

export interface RunnerStatusView {
  runnerName: string;
  cdpReachable: boolean;
  lastError: string | null;
  lastHeartbeatAt: string | null;
  stale: boolean;
  healthy: boolean;
}

export function useRunnerStatus() {
  return useQuery({
    queryKey: ["system", "runner-status"] as const,
    queryFn: async () =>
      (await api.get<{ runners: RunnerStatusView[] }>("/system/runner-status")).runners,
    // Independent of any job's own polling — this needs to keep updating even when nothing else
    // on the page is polling (e.g. no active job), since "the runner is down" is exactly the
    // state where a job would otherwise sit queued with zero visible explanation.
    refetchInterval: 20_000,
  });
}
