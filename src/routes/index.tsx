/** Authored by: Mohit Singh */
import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { RequireAuth } from "@/components/require-auth";
import { useOverviewStats } from "@/hooks/useStats";
import { useGlobalLogStream } from "@/hooks/useJobs";
import { useOcrJobs } from "@/hooks/useOcrCrawl";
import { timeAgo } from "@/lib/utils";
import { format } from "date-fns";
import {
  ArrowUpRight,
  Building2,
  Camera,
  Database,
  Sparkles,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";

export const Route = createFileRoute("/")({
  component: () => (
    <RequireAuth>
      <Dashboard />
    </RequireAuth>
  ),
});

function Stat({
  icon: Icon,
  label,
  value,
  accent,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  accent: string;
}) {
  return (
    <Card className="relative overflow-hidden border-border bg-card p-5">
      <div className="absolute inset-0 opacity-40" style={{ background: "var(--gradient-glow)" }} />
      <div className="relative flex items-start justify-between">
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg ring-1 ${accent}`}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <div className="relative mt-4">
        <div className="font-display text-3xl font-semibold tracking-tight">
          {value.toLocaleString()}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{label}</div>
      </div>
    </Card>
  );
}

function Dashboard() {
  const { data, isLoading } = useOverviewStats();
  const logs = useGlobalLogStream();
  const { data: ocrJobs = [] } = useOcrJobs();
  const stats = data?.stats;
  const trend = data?.trend ?? [];
  const recentOcrJobs = ocrJobs.slice(0, 4);

  return (
    <AppShell title="Overview" subtitle="Real-time signal across discovery, crawls and enrichment.">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Stat
          icon={Database}
          label="Businesses in master DB"
          value={stats?.totalBusinesses ?? 0}
          accent="bg-primary/15 text-primary ring-primary/30"
        />
        <Stat
          icon={Zap}
          label="Crawls this week"
          value={stats?.crawlsThisWeek ?? 0}
          accent="bg-chart-3/15 text-chart-3 ring-chart-3/30"
        />
        <Stat
          icon={Sparkles}
          label="AI extractions"
          value={stats?.aiExtractionsCount ?? 0}
          accent="bg-success/15 text-success ring-success/30"
        />
        <Stat
          icon={Building2}
          label="Active jobs"
          value={stats?.activeJobsCount ?? 0}
          accent="bg-warning/15 text-warning ring-warning/30"
        />
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2 border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="font-display text-base font-semibold">Discovery volume</h3>
              <p className="text-xs text-muted-foreground">Last 7 days · discovered vs enriched</p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-primary" /> Discovered
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-full bg-success" /> Enriched
              </span>
            </div>
          </div>
          <div className="mt-4 h-64">
            {isLoading ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={trend.map((t) => ({ ...t, label: format(new Date(t.day), "EEE") }))}
                  margin={{ top: 10, right: 10, left: -10, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="oklch(0.78 0.16 200)" stopOpacity={0.5} />
                      <stop offset="100%" stopColor="oklch(0.78 0.16 200)" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="oklch(0.72 0.18 155)" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="oklch(0.72 0.18 155)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="oklch(1 0 0 / 0.05)" vertical={false} />
                  <XAxis
                    dataKey="label"
                    stroke="oklch(0.68 0.02 255)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    stroke="oklch(0.68 0.02 255)"
                    fontSize={11}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "oklch(0.20 0.025 260)",
                      border: "1px solid oklch(0.28 0.03 260)",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="discovered"
                    stroke="oklch(0.78 0.16 200)"
                    strokeWidth={2}
                    fill="url(#g1)"
                  />
                  <Area
                    type="monotone"
                    dataKey="enriched"
                    stroke="oklch(0.72 0.18 155)"
                    strokeWidth={2}
                    fill="url(#g2)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </Card>

        <Card className="border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-base font-semibold">Live crawl log</h3>
            <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" /> streaming
            </span>
          </div>
          <div className="mt-4 max-h-64 space-y-2 overflow-y-auto pr-1 font-mono text-[11px]">
            {logs.length === 0 && <p className="text-muted-foreground">No activity yet.</p>}
            {logs.map((l) => (
              <div
                // Composite key: crawl_logs and ocr_logs are separate BIGSERIAL sequences, so a
                // bare l.id can collide between the two merged sources.
                key={`${l.source ?? "crawl"}-${l.id}`}
                className="flex gap-2 border-l-2 border-border pl-2.5 py-0.5"
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
                  <span className="text-foreground">{l.message}</span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <div className="mt-6 grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2 border-border bg-card">
          <div className="flex items-center justify-between border-b border-border p-5">
            <div>
              <h3 className="font-display text-base font-semibold">Active jobs</h3>
              <p className="text-xs text-muted-foreground">Live crawler pipelines</p>
            </div>
            <Button asChild size="sm" variant="ghost" className="text-muted-foreground gap-1">
              <Link to="/jobs">
                View all <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
          <div className="divide-y divide-border">
            {(data?.recentJobs.length ?? 0) === 0 && (
              <p className="p-5 text-sm text-muted-foreground">No jobs yet.</p>
            )}
            {data?.recentJobs.map((j) => {
              const progress =
                j.found_count === 0
                  ? 0
                  : Math.min(100, Math.round((j.crawled_count / j.found_count) * 100));
              return (
                <div key={j.id} className="grid grid-cols-12 items-center gap-4 px-5 py-3.5">
                  <div className="col-span-5 min-w-0">
                    <div className="truncate text-sm font-medium capitalize">{j.business_type}</div>
                    <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                      {j.id.slice(0, 8)} · {j.location_label ?? "pinned location"}
                    </div>
                  </div>
                  <div className="col-span-2">
                    <StatusBadge status={j.status} />
                  </div>
                  <div className="col-span-4">
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>
                        {j.crawled_count}/{j.found_count}
                      </span>
                      <span>{progress}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-primary to-chart-3 transition-all"
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>
                  <div className="col-span-1 text-right text-[10px] text-muted-foreground">
                    {timeAgo(j.started_at ?? j.created_at)}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>

        <Card className="border-border bg-card p-5">
          <h3 className="font-display text-base font-semibold">Recently enriched</h3>
          <p className="text-xs text-muted-foreground">Top new records in the master DB</p>
          <div className="mt-4 space-y-3">
            {(data?.recentlyEnriched.length ?? 0) === 0 && (
              <p className="text-sm text-muted-foreground">Nothing enriched yet.</p>
            )}
            {data?.recentlyEnriched.map((b) => (
              <div key={b.id} className="flex items-center gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold ring-1 ring-border">
                  {b.name
                    .split(" ")
                    .map((w) => w[0])
                    .slice(0, 2)
                    .join("")}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{b.name}</div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {b.category ?? "Uncategorized"} · {b.city ?? "—"}
                  </div>
                </div>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {timeAgo(b.updated_at)}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Crawl (OCR) — a separate parallel pipeline (Google Maps capture, see md/OCR_CRAWL.md)
          with its own job vocabulary and volume profile; reported here alongside the main
          crawler's stats, never merged into them. */}
      <div className="mt-6">
        <Card className="border-border bg-card">
          <div className="flex flex-col gap-3 border-b border-border p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Camera className="h-4 w-4 text-primary" />
                <h3 className="font-display text-base font-semibold">Crawl (OCR)</h3>
              </div>
              <p className="text-xs text-muted-foreground">
                Google Maps capture pipeline · {stats?.ocrBusinessesCount ?? 0} businesses captured
                · {stats?.ocrJobsThisWeek ?? 0} jobs this week
                {(stats?.ocrActiveJobsCount ?? 0) > 0 && ` · ${stats?.ocrActiveJobsCount} active`}
              </p>
            </div>
            <Button asChild size="sm" variant="ghost" className="text-muted-foreground gap-1">
              <Link to="/ocr-crawl">
                View all <ArrowUpRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>
          <div className="divide-y divide-border">
            {recentOcrJobs.length === 0 && (
              <p className="p-5 text-sm text-muted-foreground">No OCR jobs yet.</p>
            )}
            {recentOcrJobs.map((j) => (
              <div
                key={j.id}
                className="flex flex-col gap-2 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium capitalize">
                    {j.query} <span className="text-muted-foreground">· {j.location}</span>
                  </div>
                  <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                    {j.id.slice(0, 8)} · {j.captured_count}/{j.total_count || j.max_results}{" "}
                    captured
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <StatusBadge status={j.status} />
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {timeAgo(j.started_at ?? j.created_at)}
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
