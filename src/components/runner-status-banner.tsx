/** Authored by: Mohit Singh */
//
// Shared "host runner not responding" banner for property-crawl.tsx / ecom-crawl.tsx — both pages
// depend on a host runner attached to the operator's real Chrome (see useRunnerStatus.ts), and
// Chrome dying previously failed jobs silently with no visible explanation anywhere in the UI.
import { AlertTriangle } from "lucide-react";
import { useRunnerStatus, type RunnerStatusView } from "@/hooks/useRunnerStatus";
import { timeAgo } from "@/lib/utils";

const LABELS: Record<string, string> = {
  property: "Property Research host runner",
  noon: "noon/AliExpress host runner",
};

function describe(r: RunnerStatusView): string {
  const label = LABELS[r.runnerName] ?? `${r.runnerName} host runner`;
  if (r.lastHeartbeatAt === null) {
    return `${label} has never checked in — start it via the scripts/start-*.bat launcher.`;
  }
  if (r.stale) {
    return `${label} hasn't checked in (last seen ${timeAgo(r.lastHeartbeatAt)}) — it may have crashed or been closed.`;
  }
  // Not stale (the process is alive and heartbeating) but Chrome/CDP is unreachable.
  return `${label} is running but can't reach Chrome (${r.lastError ?? "CDP unreachable"}) — it will keep retrying automatically.`;
}

// `runnerNames` scopes the banner to only the runner(s) a given page actually cares about — the
// property page shouldn't warn about noon being down and vice versa.
export function RunnerStatusBanner({ runnerNames }: { runnerNames: string[] }) {
  const { data: runners = [] } = useRunnerStatus();
  const unhealthy = runners.filter((r) => runnerNames.includes(r.runnerName) && !r.healthy);
  if (unhealthy.length === 0) return null;

  return (
    <div className="mb-4 flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <div className="flex flex-col gap-0.5">
        {unhealthy.map((r) => (
          <span key={r.runnerName}>{describe(r)}</span>
        ))}
      </div>
    </div>
  );
}
