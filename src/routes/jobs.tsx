/** Authored by: Mohit Singh */
import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { RequireAuth } from "@/components/require-auth";
import {
  useCancelJob,
  useDeleteJob,
  useGlobalLogStream,
  useJobs,
  usePauseJob,
  useResumeJob,
  useRetryJob,
} from "@/hooks/useJobs";
import { timeAgo } from "@/lib/utils";
import { Play, Pause, RotateCw, Trash2, X, Clock, MapPin } from "lucide-react";
import { toast } from "sonner";
import type { CrawlJob } from "@/types/api";

export const Route = createFileRoute("/jobs")({
  component: () => (
    <RequireAuth>
      <Jobs />
    </RequireAuth>
  ),
});

const ACTIVE_STATUSES: CrawlJob["status"][] = ["discovering", "crawling"];
const TERMINAL_STATUSES: CrawlJob["status"][] = ["completed", "failed", "cancelled"];

function progressOf(job: CrawlJob): number {
  if (job.found_count === 0) return 0;
  return Math.min(100, Math.round((job.crawled_count / job.found_count) * 100));
}

function JobRow({ job }: { job: CrawlJob }) {
  const pause = usePauseJob();
  const resume = useResumeJob();
  const retry = useRetryJob();
  const cancel = useCancelJob();
  const remove = useDeleteJob();

  const isActive = ACTIVE_STATUSES.includes(job.status);
  const isPaused = job.status === "paused";
  const isTerminal = TERMINAL_STATUSES.includes(job.status);
  const progress = progressOf(job);

  return (
    <Card className="border-border bg-card p-5 transition-colors hover:border-primary/40">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h3 className="font-display text-base font-semibold capitalize">{job.business_type}</h3>
            <StatusBadge status={job.status} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-3 font-mono text-[11px] text-muted-foreground">
            <span>{job.id.slice(0, 8)}</span>
            <span>·</span>
            <span className="flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {job.location_label ??
                `${job.center_lat.toFixed(3)}, ${job.center_lng.toFixed(3)}`} · {job.radius_km}km
            </span>
            <span>·</span>
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" /> {timeAgo(job.started_at ?? job.created_at)}
            </span>
            {job.current_business && (
              <>
                <span>·</span>
                <span className="truncate text-foreground">{job.current_business}</span>
              </>
            )}
          </div>
          {job.error_message && (
            <p className="mt-2 text-[11px] text-destructive">{job.error_message}</p>
          )}
        </div>
        <div className="flex items-center gap-1">
          {(isActive || isPaused) && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              disabled={pause.isPending || resume.isPending}
              onClick={() => {
                const mutation = isPaused ? resume : pause;
                mutation.mutate(job.id, {
                  onError: (err) => toast.error(err.message),
                });
              }}
            >
              {isPaused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            </Button>
          )}
          {isTerminal && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              disabled={retry.isPending}
              onClick={() => retry.mutate(job.id, { onError: (err) => toast.error(err.message) })}
            >
              <RotateCw className="h-3.5 w-3.5" />
            </Button>
          )}
          {(isActive || isPaused) && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate(job.id, { onError: (err) => toast.error(err.message) })}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-destructive"
            disabled={remove.isPending}
            onClick={() => {
              if (confirm(`Delete job for "${job.business_type}"? This cannot be undone.`)) {
                remove.mutate(job.id, { onError: (err) => toast.error(err.message) });
              }
            }}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-3 rounded-lg border border-border bg-background/40 p-3">
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Discovered
          </div>
          <div className="mt-0.5 font-display text-lg font-semibold">
            {job.found_count.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Crawled</div>
          <div className="mt-0.5 font-display text-lg font-semibold text-primary">
            {job.crawled_count.toLocaleString()}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Failed</div>
          <div className="mt-0.5 font-display text-lg font-semibold text-destructive">
            {job.failed_count.toLocaleString()}
          </div>
        </div>
      </div>

      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Pipeline progress</span>
          <span className="font-mono text-foreground">{progress}%</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={`h-full rounded-full transition-all ${job.status === "failed" ? "bg-destructive" : job.status === "paused" ? "bg-warning" : "bg-gradient-to-r from-primary to-chart-3"}`}
            style={{ width: `${progress}%` }}
          />
        </div>
      </div>
    </Card>
  );
}

function Jobs() {
  const { data: jobs, isLoading } = useJobs();
  const logs = useGlobalLogStream();

  return (
    <AppShell title="Crawl Jobs" subtitle="Every pipeline, its progress and its live signal.">
      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="space-y-3">
          {isLoading && (
            <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">
              Loading jobs…
            </div>
          )}
          {!isLoading && jobs?.length === 0 && (
            <div className="rounded-lg border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
              No crawl jobs yet. Launch one from the Discover screen.
            </div>
          )}
          {jobs?.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </div>

        <Card className="border-border bg-card p-5 h-fit sticky top-20">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold">Live console</h3>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> streaming
            </span>
          </div>
          <div className="mt-4 max-h-[600px] space-y-1.5 overflow-y-auto pr-1 font-mono text-[11px]">
            {logs.length === 0 && (
              <p className="text-muted-foreground">
                No activity yet — logs appear here in real time.
              </p>
            )}
            {logs.map((l) => (
              <div
                // Composite key: crawl_logs and ocr_logs are separate BIGSERIAL sequences, so a
                // bare l.id can collide between the two sources this merged stream sends.
                key={`${l.source ?? "crawl"}-${l.id}`}
                className="flex gap-2 border-l-2 py-0.5 pl-2.5"
                style={{
                  borderLeftColor:
                    l.level === "error"
                      ? "oklch(0.65 0.24 22)"
                      : l.level === "warn"
                        ? "oklch(0.80 0.17 75)"
                        : "oklch(0.78 0.16 200)",
                }}
              >
                <span className="text-muted-foreground shrink-0">
                  {new Date(l.ts).toLocaleTimeString()}
                </span>
                <div className="min-w-0">
                  {l.source === "ocr" && (
                    <span className="mr-1.5 rounded bg-primary/15 px-1 py-0.5 text-[9px] font-semibold uppercase text-primary">
                      OCR
                    </span>
                  )}
                  <span
                    className={
                      l.level === "error"
                        ? "text-destructive"
                        : l.level === "warn"
                          ? "text-warning"
                          : "text-foreground"
                    }
                  >
                    {l.message}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
