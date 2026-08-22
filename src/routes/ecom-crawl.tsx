/** Authored by: Mohit Singh */
//
// Product Research (Ecom-Crawl) — SEPARATE page mirroring routes/ocr-crawl.tsx's layout/state
// conventions (create-job form, job list with polling, results table, export buttons). Do not
// merge with ocr-crawl.tsx — the two are deliberately parallel modules.
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { RequireAuth } from "@/components/require-auth";
import {
  ecomExportUrl,
  ecomImageUrl,
  useCreateEcomJob,
  useDeleteEcomJob,
  useEcomAnalysis,
  useEcomJob,
  useEcomJobs,
  useEcomResults,
  useRetryEcomJob,
} from "@/hooks/useEcomCrawl";
import { timeAgo } from "@/lib/utils";
import {
  AlertTriangle,
  ChevronDown,
  Download,
  ImageOff,
  Loader2,
  RotateCcw,
  ShoppingCart,
  Star,
  Trash2,
  Trophy,
  Truck,
} from "lucide-react";
import { toast } from "sonner";
import type { EcomJobStatus, EcomPlatform, EcomProduct, EcomSortMode } from "@/types/api";

export const Route = createFileRoute("/ecom-crawl")({
  component: () => (
    <RequireAuth>
      <EcomCrawl />
    </RequireAuth>
  ),
});

// Must match backend/api/src/db/ecomJobs.ts's MAX_ECOM_RETRIES — no shared-types package exists
// yet, so both sides carry the literal (same convention as routes/ocr-crawl.tsx).
const MAX_ECOM_RETRIES = 3;
const RETRYABLE: ReadonlySet<EcomJobStatus> = new Set(["failed", "blocked"]);
const ACTIVE: ReadonlySet<EcomJobStatus> = new Set([
  "queued",
  "capturing",
  "ocr",
  "parsing",
  "detail",
]);
// Actually running a browser session — distinct from merely 'queued'. Only one ecom job is ever
// RUNNING at a time (server-enforced); any number may be 'queued' behind it and auto-run in turn.
const RUNNING: ReadonlySet<EcomJobStatus> = new Set(["capturing", "ocr", "parsing", "detail"]);
const STATUS_COLOR: Record<EcomJobStatus, string> = {
  queued: "text-muted-foreground",
  capturing: "text-primary",
  ocr: "text-primary",
  parsing: "text-primary",
  detail: "text-primary",
  ready: "text-success",
  failed: "text-destructive",
  blocked: "text-warning",
};

const PLATFORM_OPTIONS: { value: EcomPlatform; label: string; disabled?: boolean }[] = [
  { value: "noon", label: "Noon (needs host runner)" },
  { value: "amazon", label: "Amazon" },
  // noon + aliexpress are Akamai-blocked to automated launch — they run via the host runner
  // (real Chrome), not the container. Still queued normally from here.
  { value: "aliexpress", label: "AliExpress (needs host runner)" },
];

const SORT_OPTIONS: { value: EcomSortMode; label: string }[] = [
  { value: "rating_desc", label: "Rating / reviews (high → low)" },
  { value: "price_asc", label: "Price (low → high)" },
  { value: "price_desc", label: "Price (high → low)" },
  { value: "relevance", label: "Relevance" },
];

// AliExpress has no rating sort — its adapter maps rating_desc to orders (total_tranpro_desc,
// "orders" sort) instead. Same underlying sortMode value, platform-specific label only, so the
// dropdown doesn't claim a "rating" sort that doesn't exist there.
function sortOptionsFor(platform: EcomPlatform): { value: EcomSortMode; label: string }[] {
  if (platform !== "aliexpress") return SORT_OPTIONS;
  return SORT_OPTIONS.map((opt) =>
    opt.value === "rating_desc" ? { ...opt, label: "Orders / sold (high → low)" } : opt,
  );
}

type SortKey = "idx" | "price" | "rating" | "review_count" | "opportunity_score";

function num(v: string | number | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatMoney(v: string | number | null, currency: string): string {
  const n = num(v);
  return n === null ? "—" : `${currency} ${n.toFixed(2)}`;
}

function EcomCrawl() {
  const [platform, setPlatform] = useState<EcomPlatform>("noon");
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<EcomSortMode>("rating_desc");
  const [maxPages, setMaxPages] = useState(3);
  const [maxProducts, setMaxProducts] = useState(90);
  const [detailScrapeTopN, setDetailScrapeTopN] = useState(0);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [sortKey, setSortKey] = useState<SortKey>("idx");

  const { data: jobs = [] } = useEcomJobs();
  const runningJob = jobs.find((j) => RUNNING.has(j.status));
  const queuedCount = jobs.filter((j) => j.status === "queued").length;
  const focusId = selectedId ?? runningJob?.id ?? jobs[0]?.id;
  const { data: detail } = useEcomJob(focusId);
  const focus = detail?.job;
  // A failed/blocked job that still has captured products (from this or an earlier retry
  // attempt) shows them too — resumable retry means "failed" no longer implies "nothing to show".
  const hasPartialResults =
    focus !== undefined && RETRYABLE.has(focus.status) && focus.captured_count > 0;
  const showResults = focus?.status === "ready" || hasPartialResults;
  const { data: results = [] } = useEcomResults(focusId, showResults);
  const { data: analysis } = useEcomAnalysis(focusId, showResults);

  const createJob = useCreateEcomJob();
  const deleteJob = useDeleteEcomJob();
  const retryJob = useRetryEcomJob();

  const sorted = useMemo(() => {
    const rows = [...results];
    rows.sort((a, b) => {
      if (sortKey === "idx") return a.idx - b.idx;
      if (sortKey === "price") return (num(b.price) ?? -Infinity) - (num(a.price) ?? -Infinity);
      if (sortKey === "rating") return (b.rating ?? -Infinity) - (a.rating ?? -Infinity);
      if (sortKey === "review_count")
        return (b.review_count ?? -Infinity) - (a.review_count ?? -Infinity);
      return (b.opportunity_score ?? -Infinity) - (a.opportunity_score ?? -Infinity);
    });
    return rows;
  }, [results, sortKey]);

  function handleLaunch() {
    if (query.trim() === "") {
      toast.error("Enter a search query");
      return;
    }
    createJob.mutate(
      {
        platform,
        query: query.trim(),
        sortMode,
        maxPages,
        maxProducts,
        detailScrapeTopN,
      },
      {
        onSuccess: ({ job, queuePosition }) => {
          toast.success(
            queuePosition > 0
              ? `Queued behind ${queuePosition} job${queuePosition > 1 ? "s" : ""} — will auto-run`
              : `Ecom crawl launched for "${query}"`,
          );
          setSelectedId(job.id);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <AppShell
      title="Product Research"
      subtitle="Search a marketplace's results pages, capture pricing/ratings/badges, then score each product's market opportunity. Runs one job at a time."
    >
      <Card className="border-border bg-card p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div>
            <label className="text-xs text-muted-foreground">Platform</label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as EcomPlatform)}>
              <SelectTrigger className="mt-1 h-9 bg-input">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORM_OPTIONS.map((opt) =>
                  opt.disabled ? (
                    <Tooltip key={opt.value}>
                      <TooltipTrigger asChild>
                        <div>
                          <SelectItem value={opt.value} disabled>
                            {opt.label}
                          </SelectItem>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="right">Coming soon</TooltipContent>
                    </Tooltip>
                  ) : (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Search query</label>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="wireless earbuds"
              className="mt-1 h-9 bg-input"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Sort</label>
            <Select value={sortMode} onValueChange={(v) => setSortMode(v as EcomSortMode)}>
              <SelectTrigger className="mt-1 h-9 bg-input">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sortOptionsFor(platform).map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              Pages / scroll depth <span className="text-[10px]">(1–10)</span>
            </label>
            <Input
              type="number"
              min={1}
              max={10}
              value={maxPages}
              onChange={(e) => setMaxPages(Math.min(10, Math.max(1, Number(e.target.value) || 1)))}
              className="mt-1 h-9 bg-input"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              Max records <span className="text-[10px]">(1–500)</span>
            </label>
            <Input
              type="number"
              min={1}
              max={500}
              value={maxProducts}
              onChange={(e) =>
                setMaxProducts(Math.min(500, Math.max(1, Number(e.target.value) || 1)))
              }
              className="mt-1 h-9 bg-input"
            />
          </div>
        </div>

        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="mt-3">
          <CollapsibleTrigger asChild>
            <button className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDown
                className={`h-3.5 w-3.5 transition-transform ${advancedOpen ? "rotate-180" : ""}`}
              />
              Advanced
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2">
            <div className="max-w-xs">
              <label className="text-xs text-muted-foreground">
                Deep-scrape top N products <span className="text-[10px]">(0–10, default 0)</span>
              </label>
              <Input
                type="number"
                min={0}
                max={10}
                value={detailScrapeTopN}
                onChange={(e) =>
                  setDetailScrapeTopN(Math.min(10, Math.max(0, Number(e.target.value) || 0)))
                }
                className="mt-1 h-9 bg-input"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Opens each of the top N products' detail pages for description/usage bullets and
                seller name. Slower (extra navigation per product) and off by default.
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <div className="mt-3 flex items-center justify-end">
          <Button className="gap-1.5" disabled={createJob.isPending} onClick={handleLaunch}>
            <ShoppingCart className="h-3.5 w-3.5" />
            Launch
          </Button>
        </div>

        {runningJob && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            A job is running now{queuedCount > 0 && ` (${queuedCount} more queued behind it)`} — new
            jobs queue and auto-run in order, no need to wait.
          </p>
        )}
      </Card>

      {focus && (
        <Card className="mt-4 border-border bg-card p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                {ACTIVE.has(focus.status) && (
                  <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                )}
                <span className={`text-sm font-medium ${STATUS_COLOR[focus.status]}`}>
                  {focus.status.toUpperCase()}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {focus.platform} · {focus.query}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Capturing {focus.captured_count}/{focus.total_count || focus.max_products} → OCR{" "}
                {focus.ocr_done_count}/{focus.total_count || "…"}
                {focus.detail_scrape_top_n > 0 &&
                  ` → Detail ${focus.detail_done_count}/${focus.detail_scrape_top_n}`}
                {focus.end_reason && ` · ${focus.end_reason.replace(/_/g, " ")}`}
              </div>
              {/* Live "what is it on right now" — a moving name proves the run is progressing
                  even while a count sits still. */}
              {focus.current_product && ACTIVE.has(focus.status) && (
                <div className="mt-1 truncate text-xs text-primary">
                  {focus.status === "capturing" ? "Capturing" : "Processing"}:{" "}
                  {focus.current_product}
                </div>
              )}
              {focus.status === "blocked" && (
                <p className="mt-1 flex items-center gap-1 text-xs text-warning">
                  <AlertTriangle className="h-3 w-3" /> {focus.platform} served a verification wall
                  — stopped safely. Retry resumes from the {focus.captured_count} products already
                  captured.
                </p>
              )}
              {focus.error_message && focus.status === "failed" && (
                <p className="mt-1 text-xs text-destructive">{focus.error_message}</p>
              )}
              {RETRYABLE.has(focus.status) && focus.retry_count > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Retried {focus.retry_count}/{MAX_ECOM_RETRIES}
                  {focus.captured_count > 0 &&
                    ` — ${focus.captured_count} products captured so far, kept across attempts`}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {showResults && (
                <>
                  <a href={ecomExportUrl(focus.id, "csv")} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border">
                      <Download className="h-3.5 w-3.5" /> CSV
                    </Button>
                  </a>
                  <a href={ecomExportUrl(focus.id, "xlsx")} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border">
                      <Download className="h-3.5 w-3.5" /> Excel
                    </Button>
                  </a>
                  <a href={ecomExportUrl(focus.id, "json")} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border">
                      <Download className="h-3.5 w-3.5" /> JSON
                    </Button>
                  </a>
                </>
              )}
              {RETRYABLE.has(focus.status) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 border-border"
                  disabled={retryJob.isPending || focus.retry_count >= MAX_ECOM_RETRIES}
                  title={
                    focus.retry_count >= MAX_ECOM_RETRIES
                      ? `Max retries (${MAX_ECOM_RETRIES}) reached — the captured results are still available`
                      : "Resume from the products already captured"
                  }
                  onClick={() =>
                    retryJob.mutate(focus.id, {
                      onSuccess: ({ queuePosition }) =>
                        toast.success(
                          queuePosition > 0
                            ? `Retry queued behind ${queuePosition} job${queuePosition > 1 ? "s" : ""}`
                            : "Retry launched",
                        ),
                      onError: (e) => toast.error(e.message),
                    })
                  }
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Retry{focus.retry_count > 0 ? ` (${focus.retry_count}/${MAX_ECOM_RETRIES})` : ""}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (confirm("Delete this ecom-crawl job and its captures?")) {
                    deleteJob.mutate(focus.id, { onError: (e) => toast.error(e.message) });
                    setSelectedId(undefined);
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {showResults && analysis && <AnalysisPanel analysis={analysis} />}

          {showResults && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-2 text-left font-medium">Photo</th>
                    <th className="px-2 py-2 text-left font-medium">Title</th>
                    <SortHeader label="Price" col="price" sortKey={sortKey} onSort={setSortKey} />
                    <SortHeader label="Rating" col="rating" sortKey={sortKey} onSort={setSortKey} />
                    <SortHeader
                      label="Reviews"
                      col="review_count"
                      sortKey={sortKey}
                      onSort={setSortKey}
                    />
                    <th className="px-2 py-2 text-left font-medium">Delivery</th>
                    <th className="px-2 py-2 text-left font-medium">Badges</th>
                    <SortHeader
                      label="Opportunity"
                      col="opportunity_score"
                      sortKey={sortKey}
                      onSort={setSortKey}
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sorted.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-2 py-8 text-center text-muted-foreground">
                        No rows parsed.
                      </td>
                    </tr>
                  )}
                  {sorted.map((p) => (
                    <ResultRow key={p.id} p={p} jobId={focus.id} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Card className="mt-4 border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Recent product-research jobs
        </div>
        <div className="divide-y divide-border">
          {jobs.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-muted-foreground">
              No jobs yet — launch one above.
            </div>
          )}
          {jobs.map((j) => (
            <button
              key={j.id}
              onClick={() => setSelectedId(j.id)}
              className={`flex w-full flex-col gap-1 px-4 py-2.5 text-left text-sm hover:bg-accent/30 sm:flex-row sm:items-center sm:justify-between sm:gap-3 ${
                j.id === focusId ? "bg-accent/20" : ""
              }`}
            >
              <span className="min-w-0 truncate">
                <span className="font-medium capitalize">{j.platform}</span>{" "}
                <span className="text-muted-foreground">· {j.query}</span>
              </span>
              <span className="flex shrink-0 items-center gap-3 text-xs">
                <span className={STATUS_COLOR[j.status]}>{j.status}</span>
                <span className="text-muted-foreground">{j.captured_count} rows</span>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {timeAgo(j.created_at)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </Card>
    </AppShell>
  );
}

function SortHeader({
  label,
  col,
  sortKey,
  onSort,
}: {
  label: string;
  col: SortKey;
  sortKey: SortKey;
  onSort: (k: SortKey) => void;
}) {
  return (
    <th className="px-2 py-2 text-left font-medium">
      <button
        onClick={() => onSort(col)}
        className={`uppercase ${sortKey === col ? "text-primary" : "hover:text-foreground"}`}
      >
        {label} {sortKey === col ? "↓" : ""}
      </button>
    </th>
  );
}

function ResultRow({ p, jobId }: { p: EcomProduct; jobId: string }) {
  const shotUrl = ecomImageUrl(jobId, p.source_images[0]);
  const thumb = p.image_url ?? shotUrl;
  const opportunity = p.opportunity_score;

  return (
    <tr className={p.sponsored ? "opacity-50" : "hover:bg-accent/20"}>
      <td className="px-2 py-2">
        {thumb ? (
          <img
            src={thumb}
            alt={p.title}
            className="h-8 w-8 rounded border border-border object-cover"
          />
        ) : (
          <span className="flex h-8 w-8 items-center justify-center rounded border border-border bg-muted/40 text-muted-foreground">
            <ImageOff className="h-3.5 w-3.5" />
          </span>
        )}
      </td>
      <td className="px-2 py-2">
        <div className="flex max-w-xs items-center gap-1.5">
          {p.product_url ? (
            <a
              href={p.product_url}
              target="_blank"
              rel="noreferrer"
              className="truncate font-medium text-primary hover:underline"
              title={p.title}
            >
              {p.title}
            </a>
          ) : (
            <span className="truncate font-medium" title={p.title}>
              {p.title}
            </span>
          )}
          {p.sponsored && (
            <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[9px]">
              sponsored
            </Badge>
          )}
          {p.needs_review && (
            <span
              title="Low OCR confidence — verify against the capture"
              className="shrink-0 rounded bg-warning/20 px-1 text-[9px] uppercase text-warning"
            >
              review
            </span>
          )}
        </div>
      </td>
      <td className="px-2 py-2 text-xs">
        <div>{formatMoney(p.price, p.currency)}</div>
        {p.list_price !== null && num(p.list_price) !== num(p.price) && (
          <div className="text-[10px] text-muted-foreground line-through">
            {formatMoney(p.list_price, p.currency)}
          </div>
        )}
      </td>
      <td className="px-2 py-2">
        {p.rating !== null ? (
          <span className="inline-flex items-center gap-1 text-xs">
            <Star className="h-3 w-3 fill-warning text-warning" />
            {p.rating}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        {p.bought_past_month !== null && (
          <div className="mt-0.5 text-[10px] text-muted-foreground">
            {p.bought_past_month}+ bought/mo
          </div>
        )}
      </td>
      <td className="px-2 py-2 text-xs">{p.review_count ?? "—"}</td>
      <td className="px-2 py-2 text-xs">
        {p.free_delivery && (
          <span className="inline-flex items-center gap-1 text-success">
            <Truck className="h-3 w-3" /> Free
          </span>
        )}
        {p.delivery_date && (
          <div className="text-[10px] text-muted-foreground">{p.delivery_date}</div>
        )}
        {!p.free_delivery && !p.delivery_date && <span className="text-muted-foreground">—</span>}
      </td>
      <td className="px-2 py-2">
        <div className="flex max-w-[160px] flex-wrap gap-1">
          {p.badges.length === 0 && <span className="text-xs text-muted-foreground">—</span>}
          {p.badges.slice(0, 3).map((b) => (
            <Badge key={b} variant="secondary" className="px-1.5 py-0 text-[9px]">
              {b}
            </Badge>
          ))}
        </div>
      </td>
      <td className="px-2 py-2">
        {opportunity !== null ? (
          <div className="flex items-center gap-1.5">
            <Progress
              value={Math.max(0, Math.min(100, opportunity * 100))}
              className="h-1.5 w-14"
            />
            <span className="font-mono text-[11px]">{(opportunity * 100).toFixed(0)}</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
    </tr>
  );
}

function AnalysisPanel({
  analysis,
}: {
  analysis: NonNullable<ReturnType<typeof useEcomAnalysis>["data"]>;
}) {
  const { summary, ratingDistribution, topOpportunities } = analysis;
  const maxBucket = Math.max(1, ...ratingDistribution.map((b) => b.count));

  return (
    <div className="mt-4 grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="Price range"
          value={
            summary.price.min !== null && summary.price.max !== null
              ? `${summary.price.min.toFixed(0)}–${summary.price.max.toFixed(0)}`
              : "—"
          }
          sub={
            summary.price.median !== null ? `median ${summary.price.median.toFixed(0)}` : undefined
          }
        />
        <StatCard
          label="Avg rating"
          value={summary.rating.avg !== null ? summary.rating.avg.toFixed(2) : "—"}
          sub={
            summary.rating.median !== null
              ? `median ${summary.rating.median.toFixed(2)}`
              : undefined
          }
        />
        <StatCard
          label="Total reviews"
          value={summary.reviews.total !== null ? summary.reviews.total.toLocaleString() : "—"}
        />
        <StatCard
          label="Free delivery"
          value={summary.pctFreeDelivery !== null ? `${summary.pctFreeDelivery.toFixed(0)}%` : "—"}
        />
        <StatCard
          label="Bought/mo coverage"
          value={`${summary.boughtPastMonth.productsWithData}/${summary.productCount}`}
          sub={
            summary.boughtPastMonth.total !== null
              ? `${summary.boughtPastMonth.total.toLocaleString()} total`
              : undefined
          }
        />
      </div>

      {ratingDistribution.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/10 p-3">
          <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            Rating distribution
          </div>
          <div className="flex items-end gap-2">
            {[...ratingDistribution]
              .sort((a, b) => b.star - a.star)
              .map((b) => (
                <div key={b.star} className="flex flex-1 flex-col items-center gap-1">
                  <div
                    className="w-full rounded-t bg-primary/60"
                    style={{ height: `${Math.max(4, (b.count / maxBucket) * 64)}px` }}
                  />
                  <span className="text-[10px] text-muted-foreground">
                    {b.star}★ ({b.count})
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {topOpportunities.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/10 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <Trophy className="h-3.5 w-3.5" /> Top opportunities
          </div>
          <div className="grid gap-1">
            {topOpportunities.map((o, i) => (
              <a
                key={o.id}
                href={o.productUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/30"
              >
                <span className="w-4 shrink-0 text-muted-foreground">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate">{o.title}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {o.opportunityScore !== null ? (o.opportunityScore * 100).toFixed(0) : "—"}
                </span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/10 p-3">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}
