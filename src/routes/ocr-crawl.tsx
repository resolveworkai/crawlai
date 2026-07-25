/** Authored by: Mohit Singh */
import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RequireAuth } from "@/components/require-auth";
import {
  ocrExportUrl,
  ocrImageUrl,
  useCreateOcrJob,
  useDeleteOcrJob,
  useOcrJob,
  useOcrJobs,
  useOcrResults,
} from "@/hooks/useOcrCrawl";
import { timeAgo } from "@/lib/utils";
import { Camera, Download, Loader2, Star, Trash2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import type { OcrBusiness, OcrJobStatus } from "@/types/api";
import { useSettings } from "@/hooks/useSettings";

export const Route = createFileRoute("/ocr-crawl")({
  component: () => (
    <RequireAuth>
      <OcrCrawl />
    </RequireAuth>
  ),
});

const ACTIVE: ReadonlySet<OcrJobStatus> = new Set(["queued", "capturing", "ocr", "parsing"]);
const STATUS_COLOR: Record<OcrJobStatus, string> = {
  queued: "text-muted-foreground",
  capturing: "text-primary",
  ocr: "text-primary",
  parsing: "text-primary",
  ready: "text-success",
  failed: "text-destructive",
  blocked: "text-warning",
};

type SortKey = "idx" | "rating" | "review_count";

function OcrCrawl() {
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("");
  const [maxResults, setMaxResults] = useState(25);
  const [expandHours, setExpandHours] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [sortKey, setSortKey] = useState<SortKey>("idx");

  const { data: settings } = useSettings();
  const ocrMaxResults = settings?.ocr_max_results ?? 1000;

  const { data: jobs = [] } = useOcrJobs();
  const activeJob = jobs.find((j) => ACTIVE.has(j.status));
  const focusId = selectedId ?? activeJob?.id ?? jobs[0]?.id;
  const { data: detail } = useOcrJob(focusId);
  const focus = detail?.job;
  const { data: results = [] } = useOcrResults(focusId, focus?.status === "ready");

  const createJob = useCreateOcrJob();
  const deleteJob = useDeleteOcrJob();

  const sorted = useMemo(() => {
    const rows = [...results];
    rows.sort((a, b) => {
      if (sortKey === "idx") return a.idx - b.idx;
      return (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0);
    });
    return rows;
  }, [results, sortKey]);

  function handleLaunch() {
    if (query.trim() === "" || location.trim() === "") {
      toast.error("Enter a business type and a location");
      return;
    }
    createJob.mutate(
      { query: query.trim(), location: location.trim(), maxResults, expandHours },
      {
        onSuccess: (job) => {
          toast.success(`OCR crawl launched for "${query}"`);
          setSelectedId(job.id);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <AppShell
      title="Crawl (OCR)"
      subtitle="Capture Google Maps business panels as screenshots, then OCR them into a table. Runs one job at a time; ~2–4 s per business."
    >
      <Card className="border-border bg-card p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="text-xs text-muted-foreground">Business type</label>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="gym"
              className="mt-1 h-9 bg-input"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Location</label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Al Nahda, Dubai"
              className="mt-1 h-9 bg-input"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              Max results{" "}
              <span className="text-[10px]">(up to {ocrMaxResults}, configurable in Settings)</span>
            </label>
            <Input
              type="number"
              min={1}
              max={ocrMaxResults}
              value={maxResults}
              onChange={(e) =>
                setMaxResults(Math.min(ocrMaxResults, Math.max(1, Number(e.target.value) || 1)))
              }
              className="mt-1 h-9 bg-input"
            />
          </div>
          <div className="flex items-end gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={expandHours}
                onChange={(e) => setExpandHours(e.target.checked)}
              />
              Weekly hours
            </label>
            <Button
              className="ml-auto gap-1.5"
              disabled={createJob.isPending || activeJob !== undefined}
              onClick={handleLaunch}
            >
              <Camera className="h-3.5 w-3.5" />
              {activeJob ? "Job running…" : "Launch"}
            </Button>
          </div>
        </div>
        {activeJob && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            A job is already running — only one runs at a time.
          </p>
        )}
      </Card>

      {focus && (
        <Card className="mt-4 border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2">
                {ACTIVE.has(focus.status) && (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                )}
                <span className={`text-sm font-medium ${STATUS_COLOR[focus.status]}`}>
                  {focus.status.toUpperCase()}
                </span>
                <span className="text-xs text-muted-foreground">
                  {focus.query} · {focus.location}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Capturing {focus.captured_count}/{focus.total_count || focus.max_results} → OCR{" "}
                {focus.ocr_done_count}/{focus.total_count || "…"}
                {focus.end_reason && ` · ${focus.end_reason.replace(/_/g, " ")}`}
              </div>
              {/* Live "what is it on right now" — a moving name proves the run is progressing
                  even while a count sits still (a stalled count alone looks identical to a hung
                  job, which is exactly how the earlier freeze presented). */}
              {focus.current_business && ACTIVE.has(focus.status) && (
                <div className="mt-1 truncate text-xs text-primary">
                  {focus.status === "capturing" ? "Capturing" : "Processing"}:{" "}
                  {focus.current_business}
                </div>
              )}
              {focus.status === "blocked" && (
                <p className="mt-1 flex items-center gap-1 text-xs text-warning">
                  <AlertTriangle className="h-3 w-3" /> Google served a verification wall — stopped
                  safely. Try again later.
                </p>
              )}
              {focus.error_message && focus.status === "failed" && (
                <p className="mt-1 text-xs text-destructive">{focus.error_message}</p>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              {focus.status === "ready" && (
                <>
                  <a href={ocrExportUrl(focus.id, "csv")} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border">
                      <Download className="h-3.5 w-3.5" /> CSV
                    </Button>
                  </a>
                  <a href={ocrExportUrl(focus.id, "xlsx")} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border">
                      <Download className="h-3.5 w-3.5" /> Excel
                    </Button>
                  </a>
                </>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (confirm("Delete this OCR job and its screenshots?")) {
                    deleteJob.mutate(focus.id, { onError: (e) => toast.error(e.message) });
                    setSelectedId(undefined);
                  }
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>

          {focus.status === "ready" && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-2 text-left font-medium">Photo</th>
                    <th className="px-2 py-2 text-left font-medium">Shots</th>
                    <th className="px-2 py-2 text-left font-medium">Name</th>
                    <SortHeader label="Rating" col="rating" sortKey={sortKey} onSort={setSortKey} />
                    <SortHeader
                      label="Reviews"
                      col="review_count"
                      sortKey={sortKey}
                      onSort={setSortKey}
                    />
                    <th className="px-2 py-2 text-left font-medium">Category</th>
                    <th className="px-2 py-2 text-left font-medium">Phone</th>
                    <th className="px-2 py-2 text-left font-medium">Website</th>
                    <th className="px-2 py-2 text-left font-medium">Address</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sorted.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-2 py-8 text-center text-muted-foreground">
                        No rows parsed.
                      </td>
                    </tr>
                  )}
                  {sorted.map((b) => (
                    <ResultRow key={b.id} b={b} jobId={focus.id} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Card className="mt-4 border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Recent OCR jobs
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
              className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-accent/30 ${
                j.id === focusId ? "bg-accent/20" : ""
              }`}
            >
              <span>
                <span className="font-medium">{j.query}</span>{" "}
                <span className="text-muted-foreground">· {j.location}</span>
              </span>
              <span className="flex items-center gap-3 text-xs">
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

function ResultRow({ b, jobId }: { b: OcrBusiness; jobId: string }) {
  return (
    <tr className={b.needs_review ? "bg-warning/5" : "hover:bg-accent/20"}>
      <td className="px-2 py-2">
        {b.image_url ? (
          <a href={b.image_url} target="_blank" rel="noreferrer">
            <img
              src={b.image_url}
              alt={b.name}
              className="h-8 w-8 rounded border border-border object-cover hover:border-primary"
            />
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-2 py-2">
        <div className="flex gap-1">
          {b.source_images.slice(0, 2).map((img) => (
            <a key={img} href={ocrImageUrl(jobId, img)} target="_blank" rel="noreferrer">
              <div className="h-8 w-8 rounded border border-border bg-muted/40 text-center text-[9px] leading-8 text-muted-foreground hover:border-primary">
                png
              </div>
            </a>
          ))}
        </div>
      </td>
      <td className="px-2 py-2">
        <div className="flex items-center gap-1.5 font-medium">
          {b.name}
          {b.needs_review && (
            <span
              title="Low OCR confidence — verify against the screenshot"
              className="rounded bg-warning/20 px-1 text-[9px] uppercase text-warning"
            >
              review
            </span>
          )}
        </div>
      </td>
      <td className="px-2 py-2">
        {b.rating !== null ? (
          <span className="inline-flex items-center gap-1 text-xs">
            <Star className="h-3 w-3 fill-warning text-warning" />
            {b.rating}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-2 py-2 text-xs">{b.review_count ?? "—"}</td>
      <td className="px-2 py-2 text-xs text-muted-foreground">{b.category ?? "—"}</td>
      <td className="px-2 py-2 font-mono text-[11px]">{b.phone ?? "—"}</td>
      <td className="px-2 py-2 text-xs">
        {b.website ? (
          <a
            href={b.website.startsWith("http") ? b.website : `https://${b.website}`}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            {b.website}
          </a>
        ) : (
          "—"
        )}
      </td>
      <td className="px-2 py-2 text-xs text-muted-foreground">{b.address ?? "—"}</td>
    </tr>
  );
}
