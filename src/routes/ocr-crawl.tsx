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
  useRetryOcrJob,
} from "@/hooks/useOcrCrawl";
import { useGeocode } from "@/hooks/useGeocode";
import { timeAgo } from "@/lib/utils";
import {
  Camera,
  Download,
  Loader2,
  MapPin,
  RotateCcw,
  Search,
  Star,
  Trash2,
  AlertTriangle,
} from "lucide-react";
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

// Must match backend/api/src/db/ocrJobs.ts's MAX_OCR_RETRIES — no shared-types package exists
// yet to import this from a single source, so both sides carry the literal.
const MAX_OCR_RETRIES = 3;
const RETRYABLE: ReadonlySet<OcrJobStatus> = new Set(["failed", "blocked"]);
const ACTIVE: ReadonlySet<OcrJobStatus> = new Set(["queued", "capturing", "ocr", "parsing"]);
// Actually running a Chromium/Maps session — distinct from merely 'queued'. Only one job is ever
// RUNNING at a time (server-enforced); any number may be 'queued' behind it and auto-run in turn.
const RUNNING: ReadonlySet<OcrJobStatus> = new Set(["capturing", "ocr", "parsing"]);
const STATUS_COLOR: Record<OcrJobStatus, string> = {
  queued: "text-muted-foreground",
  capturing: "text-primary",
  ocr: "text-primary",
  parsing: "text-primary",
  ready: "text-success",
  failed: "text-destructive",
  blocked: "text-warning",
};

type SortKey = "idx" | "rating" | "review_count" | "distance_km";

function OcrCrawl() {
  const [query, setQuery] = useState("");
  const [location, setLocation] = useState("");
  const [maxResults, setMaxResults] = useState(25);
  const [expandHours, setExpandHours] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [sortKey, setSortKey] = useState<SortKey>("idx");
  // Center point (from "Use my location" or manual entry) + a real km radius. When set, the
  // worker enforces radiusKm as an exact haversine filter on each business's own coordinates —
  // not just a Maps search bias — so businesses outside it are never captured at all.
  const [centerLat, setCenterLat] = useState<number | undefined>(undefined);
  const [centerLng, setCenterLng] = useState<number | undefined>(undefined);
  const [radiusKm, setRadiusKm] = useState<number | undefined>(5);
  const [locating, setLocating] = useState(false);
  const geocode = useGeocode();

  function useMyLocation() {
    if (!navigator.geolocation) {
      toast.error("Geolocation isn't available in this browser");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setCenterLat(pos.coords.latitude);
        setCenterLng(pos.coords.longitude);
        if (location.trim() === "") {
          setLocation(`${pos.coords.latitude.toFixed(4)}, ${pos.coords.longitude.toFixed(4)}`);
        }
        setLocating(false);
        toast.success("Current location captured");
      },
      (err) => {
        setLocating(false);
        toast.error(`Couldn't get your location: ${err.message}`);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  // Manual pin: geocode whatever address the user typed into Location (Nominatim, same proxy the
  // main crawler's Discover screen uses) — an alternative to "Use my location" for pinning a
  // center point that isn't wherever the browser physically is.
  function pinTypedAddress() {
    if (location.trim() === "") {
      toast.error("Type an address into Location first");
      return;
    }
    geocode.mutate(location.trim(), {
      onSuccess: ({ result }) => {
        setCenterLat(result.lat);
        setCenterLng(result.lng);
        setLocation(result.displayName);
        toast.success(`Pinned: ${result.displayName}`);
      },
      onError: (err) => toast.error(`Couldn't find that address: ${err.message}`),
    });
  }

  const { data: settings } = useSettings();
  const ocrMaxResults = settings?.ocr_max_results ?? 1000;

  const { data: jobs = [] } = useOcrJobs();
  const runningJob = jobs.find((j) => RUNNING.has(j.status));
  const queuedCount = jobs.filter((j) => j.status === "queued").length;
  const focusId = selectedId ?? runningJob?.id ?? jobs[0]?.id;
  const { data: detail } = useOcrJob(focusId);
  const focus = detail?.job;
  // A failed/blocked job that still has captured businesses (from this or an earlier retry
  // attempt) shows them too — resumable retry means "failed" no longer implies "nothing to show".
  const hasPartialResults =
    focus !== undefined && RETRYABLE.has(focus.status) && focus.captured_count > 0;
  const showResults = focus?.status === "ready" || hasPartialResults;
  const { data: results = [] } = useOcrResults(focusId, showResults);

  const createJob = useCreateOcrJob();
  const deleteJob = useDeleteOcrJob();
  const retryJob = useRetryOcrJob();

  const sorted = useMemo(() => {
    const rows = [...results];
    rows.sort((a, b) => {
      if (sortKey === "idx") return a.idx - b.idx;
      if (sortKey === "distance_km")
        return (a.distance_km ?? Infinity) - (b.distance_km ?? Infinity);
      return (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0);
    });
    return rows;
  }, [results, sortKey]);

  function handleLaunch() {
    if (query.trim() === "" || location.trim() === "") {
      toast.error("Enter a business type and a location");
      return;
    }
    if (radiusKm !== undefined && (centerLat === undefined || centerLng === undefined)) {
      toast.error("Set a center point (Use my location) before applying a radius");
      return;
    }
    createJob.mutate(
      {
        query: query.trim(),
        location: location.trim(),
        maxResults,
        expandHours,
        ...(centerLat !== undefined && centerLng !== undefined
          ? { centerLat, centerLng, ...(radiusKm !== undefined ? { radiusKm } : {}) }
          : {}),
      },
      {
        onSuccess: ({ job, queuePosition }) => {
          toast.success(
            queuePosition > 0
              ? `Queued behind ${queuePosition} job${queuePosition > 1 ? "s" : ""} — will auto-run`
              : `OCR crawl launched for "${query}"`,
          );
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
            <div className="mt-1 flex gap-1.5">
              <Input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="Al Nahda, Dubai"
                className="h-9 min-w-0 flex-1 bg-input"
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0 border-border"
                disabled={geocode.isPending || location.trim() === ""}
                onClick={pinTypedAddress}
                title="Pin the typed address as the search center"
              >
                <Search className={`h-3.5 w-3.5 ${geocode.isPending ? "animate-pulse" : ""}`} />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-9 w-9 shrink-0 border-border"
                disabled={locating}
                onClick={useMyLocation}
                title="Use my current location as the search center"
              >
                <MapPin className={`h-3.5 w-3.5 ${locating ? "animate-pulse" : ""}`} />
              </Button>
            </div>
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
          <div>
            <label className="text-xs text-muted-foreground">
              Radius (km){" "}
              {centerLat === undefined ? (
                <span className="text-[10px]">(pin a location first)</span>
              ) : (
                radiusKm !== undefined &&
                radiusKm > 20 && (
                  <span className="text-[10px]">(large radii auto-tile, take longer)</span>
                )
              )}
            </label>
            <Input
              type="number"
              min={0.1}
              max={300}
              step={0.5}
              value={radiusKm ?? ""}
              disabled={centerLat === undefined}
              onChange={(e) => {
                const v = Number(e.target.value);
                setRadiusKm(e.target.value === "" || Number.isNaN(v) ? undefined : v);
              }}
              placeholder="No limit"
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
              disabled={createJob.isPending}
              onClick={handleLaunch}
            >
              <Camera className="h-3.5 w-3.5" />
              Launch
            </Button>
          </div>
        </div>
        {centerLat !== undefined && centerLng !== undefined && (
          <p className="mt-2 flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
            <MapPin className="h-3 w-3 shrink-0" /> Center: {centerLat.toFixed(5)},{" "}
            {centerLng.toFixed(5)}
            {radiusKm !== undefined && ` · ${radiusKm} km radius (exact — enforced per business)`}
            <button
              className="ml-1 text-primary hover:underline"
              onClick={() => {
                setCenterLat(undefined);
                setCenterLng(undefined);
              }}
            >
              clear
            </button>
          </p>
        )}
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
                  safely. Retry resumes from the {focus.captured_count} businesses already captured.
                </p>
              )}
              {focus.error_message && focus.status === "failed" && (
                <p className="mt-1 text-xs text-destructive">{focus.error_message}</p>
              )}
              {RETRYABLE.has(focus.status) && focus.retry_count > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Retried {focus.retry_count}/{MAX_OCR_RETRIES}
                  {focus.captured_count > 0 &&
                    ` — ${focus.captured_count} businesses captured so far, kept across attempts`}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {showResults && (
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
              {RETRYABLE.has(focus.status) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 border-border"
                  disabled={retryJob.isPending || focus.retry_count >= MAX_OCR_RETRIES}
                  title={
                    focus.retry_count >= MAX_OCR_RETRIES
                      ? `Max retries (${MAX_OCR_RETRIES}) reached — the captured results are still available`
                      : "Resume from the businesses already captured"
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
                  Retry{focus.retry_count > 0 ? ` (${focus.retry_count}/${MAX_OCR_RETRIES})` : ""}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
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

          {showResults && (
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
                    {focus.center_lat !== null && (
                      <SortHeader
                        label="Distance"
                        col="distance_km"
                        sortKey={sortKey}
                        onSort={setSortKey}
                      />
                    )}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sorted.length === 0 && (
                    <tr>
                      <td
                        colSpan={focus.center_lat !== null ? 10 : 9}
                        className="px-2 py-8 text-center text-muted-foreground"
                      >
                        No rows parsed.
                      </td>
                    </tr>
                  )}
                  {sorted.map((b) => (
                    <ResultRow
                      key={b.id}
                      b={b}
                      jobId={focus.id}
                      showDistance={focus.center_lat !== null}
                    />
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
              className={`flex w-full flex-col gap-1 px-4 py-2.5 text-left text-sm hover:bg-accent/30 sm:flex-row sm:items-center sm:justify-between sm:gap-3 ${
                j.id === focusId ? "bg-accent/20" : ""
              }`}
            >
              <span className="min-w-0 truncate">
                <span className="font-medium">{j.query}</span>{" "}
                <span className="text-muted-foreground">· {j.location}</span>
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

function ResultRow({
  b,
  jobId,
  showDistance,
}: {
  b: OcrBusiness;
  jobId: string;
  showDistance: boolean;
}) {
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
      {showDistance && (
        <td className="px-2 py-2 text-xs">
          {b.distance_km !== null ? `${b.distance_km.toFixed(2)} km` : "—"}
        </td>
      )}
    </tr>
  );
}
