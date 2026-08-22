/** Authored by: Mohit Singh */
//
// Property Research (Property-Crawl) — SEPARATE page mirroring routes/ecom-crawl.tsx's
// layout/state conventions (create-job form, job list with polling, results table, export
// buttons). Do not merge with ecom-crawl.tsx or ocr-crawl.tsx — all three are deliberately
// parallel modules. Searches dubizzle.com/propertyfinder.ae for a location + bedroom/bathroom/
// property-type filter, captures every listing (price/sqft/beds/baths/community/badges), scores
// each one as a "distress deal" (best value for money), and — for the top-N ranked listings —
// reveals a phone number and builds a wa.me WhatsApp link with a custom message.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { RequireAuth } from "@/components/require-auth";
import {
  propertyExportUrl,
  propertyImageUrl,
  useCreatePropertyJob,
  useDeletePropertyJob,
  usePropertyAnalysis,
  usePropertyJob,
  usePropertyJobs,
  usePropertyResults,
  useRetryPropertyJob,
} from "@/hooks/usePropertyCrawl";
import { useGeocodeSuggestions } from "@/hooks/useGeocode";
import { timeAgo } from "@/lib/utils";
import {
  AlertTriangle,
  Bath,
  Bed,
  ChevronDown,
  Download,
  ExternalLink,
  Home,
  ImageOff,
  Loader2,
  MapPin,
  MessageCircle,
  Ruler,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Trophy,
} from "lucide-react";
import { toast } from "sonner";
import type {
  GeocodeResult,
  PropertyJobStatus,
  PropertyListing,
  PropertyPlatform,
  PropertyPurpose,
  PropertyType,
} from "@/types/api";

// Nominatim's display_name is a full address ("Jumeirah Village Circle, Dubai, Dubai, United
// Arab Emirates") — too long/specific for dubizzle/propertyfinder's own free-text location search
// (they expect a neighborhood name, e.g. "Jumeirah Village Circle" or "Jumeirah Village Circle,
// Dubai"). Keep just the first 2 comma-separated segments so the picked suggestion still reads as
// a normal area name once it fills the input.
function shortLocationLabel(displayName: string): string {
  return displayName
    .split(",")
    .map((p) => p.trim())
    .slice(0, 2)
    .join(", ");
}

// Debounces `value` by `delayMs` — the location field's autosuggest dropdown shouldn't fire a
// Nominatim request on every keystroke, only once typing pauses.
function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export const Route = createFileRoute("/property-crawl")({
  component: () => (
    <RequireAuth>
      <PropertyCrawl />
    </RequireAuth>
  ),
});

// Must match backend/api/src/db/propertyJobs.ts's MAX_PROPERTY_RETRIES — no shared-types package
// exists yet, so both sides carry the literal (same convention as routes/ecom-crawl.tsx).
const MAX_PROPERTY_RETRIES = 3;
const RETRYABLE: ReadonlySet<PropertyJobStatus> = new Set(["failed", "blocked"]);
const ACTIVE: ReadonlySet<PropertyJobStatus> = new Set([
  "queued",
  "capturing",
  "parsing",
  "detail",
  "scoring",
]);
// Actually running a browser session — distinct from merely 'queued'. Only one property job is
// ever RUNNING at a time (server-enforced); any number may be 'queued' behind it.
const RUNNING: ReadonlySet<PropertyJobStatus> = new Set([
  "capturing",
  "parsing",
  "detail",
  "scoring",
]);
const STATUS_COLOR: Record<PropertyJobStatus, string> = {
  queued: "text-muted-foreground",
  capturing: "text-primary",
  parsing: "text-primary",
  detail: "text-primary",
  scoring: "text-primary",
  ready: "text-success",
  failed: "text-destructive",
  blocked: "text-warning",
};

const PLATFORM_OPTIONS: { value: PropertyPlatform; label: string }[] = [
  { value: "dubizzle", label: "dubizzle.com (needs host runner)" },
  { value: "propertyfinder", label: "propertyfinder.ae (needs host runner)" },
];

const PROPERTY_TYPE_OPTIONS: { value: PropertyType; label: string }[] = [
  { value: "apartment", label: "Apartment" },
  { value: "studio", label: "Studio" },
  { value: "villa", label: "Villa" },
  { value: "townhouse", label: "Townhouse" },
  { value: "penthouse", label: "Penthouse" },
];

const PURPOSE_OPTIONS: { value: PropertyPurpose; label: string }[] = [
  { value: "buy", label: "Buy" },
  { value: "rent", label: "Rent" },
];

const BEDROOM_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "0", label: "Studio (0)" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4", label: "4" },
  { value: "5", label: "5+" },
];

const BATHROOM_OPTIONS = [
  { value: "any", label: "Any" },
  { value: "1", label: "1" },
  { value: "2", label: "2" },
  { value: "3", label: "3" },
  { value: "4", label: "4+" },
];

function num(v: string | number | null): number | null {
  if (v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function formatMoney(v: string | number | null, currency: string | null): string {
  const n = num(v);
  return n === null ? "—" : `${currency ?? "AED"} ${n.toLocaleString()}`;
}

type SortKey = "distress_score" | "price" | "price_per_sqft" | "area_sqft" | "listed_days_ago";

function PropertyCrawl() {
  const [platform, setPlatform] = useState<PropertyPlatform>("dubizzle");
  const [location, setLocation] = useState("");
  const [propertyType, setPropertyType] = useState<PropertyType>("apartment");
  const [bedrooms, setBedrooms] = useState("any");
  const [bathrooms, setBathrooms] = useState("any");
  const [purpose, setPurpose] = useState<PropertyPurpose>("buy");
  const [maxPages, setMaxPages] = useState(3);
  const [maxListings, setMaxListings] = useState(100);
  const [detailScrapeTopN, setDetailScrapeTopN] = useState(10);
  const [whatsappTemplate, setWhatsappTemplate] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [sortKey, setSortKey] = useState<SortKey>("distress_score");

  const { data: jobs = [] } = usePropertyJobs();
  const runningJob = jobs.find((j) => RUNNING.has(j.status));
  const queuedCount = jobs.filter((j) => j.status === "queued").length;
  const focusId = selectedId ?? runningJob?.id ?? jobs[0]?.id;
  const { data: detail } = usePropertyJob(focusId);
  const focus = detail?.job;
  // A failed/blocked job that still has captured listings (from this or an earlier retry
  // attempt) shows them too — resumable retry means "failed" no longer implies "nothing to show".
  const hasPartialResults =
    focus !== undefined && RETRYABLE.has(focus.status) && focus.captured_count > 0;
  const showResults = focus?.status === "ready" || hasPartialResults;
  const { data: results = [] } = usePropertyResults(focusId, showResults);
  const { data: analysis } = usePropertyAnalysis(focusId, showResults);

  const createJob = useCreatePropertyJob();
  const deleteJob = useDeletePropertyJob();
  const retryJob = useRetryPropertyJob();

  const sorted = useMemo(() => {
    const rows = [...results];
    rows.sort((a, b) => {
      if (sortKey === "price") return (num(a.price) ?? Infinity) - (num(b.price) ?? Infinity);
      if (sortKey === "price_per_sqft")
        return (num(a.price_per_sqft) ?? Infinity) - (num(b.price_per_sqft) ?? Infinity);
      if (sortKey === "area_sqft")
        return (num(b.area_sqft) ?? -Infinity) - (num(a.area_sqft) ?? -Infinity);
      if (sortKey === "listed_days_ago")
        return (b.listed_days_ago ?? -Infinity) - (a.listed_days_ago ?? -Infinity);
      return (b.distress_score ?? -Infinity) - (a.distress_score ?? -Infinity);
    });
    return rows;
  }, [results, sortKey]);

  function handleLaunch() {
    if (location.trim() === "") {
      toast.error("Enter a location (e.g. JVC, Dubai Marina, Al Barsha)");
      return;
    }
    createJob.mutate(
      {
        platform,
        location: location.trim(),
        propertyType,
        bedrooms: bedrooms === "any" ? undefined : Number(bedrooms),
        bathrooms: bathrooms === "any" ? undefined : Number(bathrooms),
        purpose,
        maxPages,
        maxListings,
        detailScrapeTopN,
        whatsappMessageTemplate: whatsappTemplate.trim() || undefined,
      },
      {
        onSuccess: ({ job, queuePosition }) => {
          toast.success(
            queuePosition > 0
              ? `Queued behind ${queuePosition} job${queuePosition > 1 ? "s" : ""} — will auto-run`
              : `Property search launched for "${location}"`,
          );
          setSelectedId(job.id);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <AppShell
      title="Property Research"
      subtitle="Search dubizzle/propertyfinder for a location + bedroom/bathroom filter, capture every listing, and rank the top deals by price-per-sqft, distress-sale language, freshness, and verification — best value for money first."
    >
      <Card className="border-border bg-card p-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="text-xs text-muted-foreground">Platform</label>
            <Select value={platform} onValueChange={(v) => setPlatform(v as PropertyPlatform)}>
              <SelectTrigger className="mt-1 h-9 bg-input">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORM_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <LocationField value={location} onChange={setLocation} />
          <div>
            <label className="text-xs text-muted-foreground">Property type</label>
            <Select value={propertyType} onValueChange={(v) => setPropertyType(v as PropertyType)}>
              <SelectTrigger className="mt-1 h-9 bg-input">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROPERTY_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Purpose</label>
            <Select value={purpose} onValueChange={(v) => setPurpose(v as PropertyPurpose)}>
              <SelectTrigger className="mt-1 h-9 bg-input">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PURPOSE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Bedrooms</label>
            <Select value={bedrooms} onValueChange={setBedrooms}>
              <SelectTrigger className="mt-1 h-9 bg-input">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BEDROOM_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Bathrooms</label>
            <Select value={bathrooms} onValueChange={setBathrooms}>
              <SelectTrigger className="mt-1 h-9 bg-input">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BATHROOM_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              Pages to scrape <span className="text-[10px]">(1–20)</span>
            </label>
            <Input
              type="number"
              min={1}
              max={20}
              value={maxPages}
              onChange={(e) => setMaxPages(Math.min(20, Math.max(1, Number(e.target.value) || 1)))}
              className="mt-1 h-9 bg-input"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">
              Max listings <span className="text-[10px]">(1–500)</span>
            </label>
            <Input
              type="number"
              min={1}
              max={500}
              value={maxListings}
              onChange={(e) =>
                setMaxListings(Math.min(500, Math.max(1, Number(e.target.value) || 1)))
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
          <CollapsibleContent className="mt-2 grid gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs text-muted-foreground">
                Reveal phone / WhatsApp for top N deals <span className="text-[10px]">(0–20)</span>
              </label>
              <Input
                type="number"
                min={0}
                max={20}
                value={detailScrapeTopN}
                onChange={(e) =>
                  setDetailScrapeTopN(Math.min(20, Math.max(0, Number(e.target.value) || 0)))
                }
                className="mt-1 h-9 bg-input"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Visits each of the top N ranked listings' ad pages, clicks "Call" to reveal a phone
                number, and builds a WhatsApp deep link with a custom message. Slower — only runs
                for the best deals.
              </p>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">
                Custom WhatsApp message <span className="text-[10px]">(optional)</span>
              </label>
              <Textarea
                value={whatsappTemplate}
                onChange={(e) => setWhatsappTemplate(e.target.value)}
                placeholder="Hi, I'm interested in your listing: {title} ({community}, AED {price}). Is it still available? {url}"
                className="mt-1 min-h-[76px] bg-input text-xs"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Placeholders: {"{title}"}, {"{price}"}, {"{community}"}, {"{url}"}. Leave blank for
                the default message.
              </p>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <div className="mt-3 flex items-center justify-end">
          <Button className="gap-1.5" disabled={createJob.isPending} onClick={handleLaunch}>
            <Home className="h-3.5 w-3.5" />
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
                  {focus.platform} · {focus.location}
                  {focus.bedrooms !== null &&
                    ` · ${focus.bedrooms === 0 ? "Studio" : `${focus.bedrooms}BR`}`}
                  {focus.bathrooms !== null && ` · ${focus.bathrooms} bath`}
                </span>
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Capturing {focus.captured_count}/{focus.total_count || focus.max_listings}
                {focus.detail_scrape_top_n > 0 &&
                  ` → Detail ${focus.detail_done_count}/${focus.detail_scrape_top_n}`}
                {focus.end_reason && ` · ${focus.end_reason.replace(/_/g, " ")}`}
              </div>
              {/* Live "what is it on right now" — a moving name proves the run is progressing
                  even while a count sits still. */}
              {focus.current_listing && ACTIVE.has(focus.status) && (
                <div className="mt-1 truncate text-xs text-primary">
                  {focus.status === "capturing" ? "Capturing" : "Processing"}:{" "}
                  {focus.current_listing}
                </div>
              )}
              {focus.status === "blocked" && (
                <p className="mt-1 flex items-center gap-1 text-xs text-warning">
                  <AlertTriangle className="h-3 w-3" /> {focus.platform} served a verification wall
                  — stopped safely. Retry resumes from the {focus.captured_count} listings already
                  captured.
                </p>
              )}
              {focus.error_message && focus.status === "failed" && (
                <p className="mt-1 text-xs text-destructive">{focus.error_message}</p>
              )}
              {RETRYABLE.has(focus.status) && focus.retry_count > 0 && (
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Retried {focus.retry_count}/{MAX_PROPERTY_RETRIES}
                  {focus.captured_count > 0 &&
                    ` — ${focus.captured_count} listings captured so far, kept across attempts`}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {showResults && (
                <>
                  <a href={propertyExportUrl(focus.id, "csv")} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border">
                      <Download className="h-3.5 w-3.5" /> CSV
                    </Button>
                  </a>
                  <a href={propertyExportUrl(focus.id, "xlsx")} target="_blank" rel="noreferrer">
                    <Button variant="outline" size="sm" className="h-8 gap-1.5 border-border">
                      <Download className="h-3.5 w-3.5" /> Excel
                    </Button>
                  </a>
                  <a href={propertyExportUrl(focus.id, "json")} target="_blank" rel="noreferrer">
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
                  disabled={retryJob.isPending || focus.retry_count >= MAX_PROPERTY_RETRIES}
                  title={
                    focus.retry_count >= MAX_PROPERTY_RETRIES
                      ? `Max retries (${MAX_PROPERTY_RETRIES}) reached — the captured results are still available`
                      : "Resume from the listings already captured"
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
                  Retry
                  {focus.retry_count > 0 ? ` (${focus.retry_count}/${MAX_PROPERTY_RETRIES})` : ""}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => {
                  if (confirm("Delete this property-crawl job and its captures?")) {
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
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground">Sort by</span>
              {(
                [
                  { key: "distress_score", label: "Best value" },
                  { key: "price", label: "Price ↑" },
                  { key: "price_per_sqft", label: "AED/sqft ↑" },
                  { key: "area_sqft", label: "Area ↓" },
                  { key: "listed_days_ago", label: "Oldest first" },
                ] as { key: SortKey; label: string }[]
              ).map((opt) => (
                <button
                  key={opt.key}
                  onClick={() => setSortKey(opt.key)}
                  className={`rounded-full border px-2.5 py-1 text-[11px] ${
                    sortKey === opt.key
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}

          {showResults && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-2 text-left font-medium">Photo</th>
                    <th className="px-2 py-2 text-left font-medium">Listing</th>
                    <th className="px-2 py-2 text-left font-medium">Price</th>
                    <th className="px-2 py-2 text-left font-medium">Area</th>
                    <th className="px-2 py-2 text-left font-medium">AED/sqft</th>
                    <th className="px-2 py-2 text-left font-medium">Beds/Baths</th>
                    <th className="px-2 py-2 text-left font-medium">Listed</th>
                    <th className="px-2 py-2 text-left font-medium">Score</th>
                    <th className="px-2 py-2 text-left font-medium">Contact</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sorted.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-2 py-8 text-center text-muted-foreground">
                        No listings parsed.
                      </td>
                    </tr>
                  )}
                  {sorted.map((l) => (
                    <ResultRow key={l.id} l={l} jobId={focus.id} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      <Card className="mt-4 border-border bg-card">
        <div className="border-b border-border px-4 py-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Recent property-research jobs
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
                <span className="text-muted-foreground">· {j.location}</span>
              </span>
              <span className="flex shrink-0 items-center gap-3 text-xs">
                <span className={STATUS_COLOR[j.status]}>{j.status}</span>
                <span className="text-muted-foreground">{j.captured_count} listings</span>
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

// Location input with an as-you-type autocomplete dropdown, backed by the same Nominatim proxy
// the app's map already uses (Discover's location box / the header's quick-launch modal — see
// hooks/useGeocode.ts). Debounced so it doesn't fire a request per keystroke; picking a
// suggestion fills the field with a short area label rather than Nominatim's full address string.
function LocationField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [focused, setFocused] = useState(false);
  const debouncedValue = useDebouncedValue(value, 350);
  const { data: suggestions = [] } = useGeocodeSuggestions(debouncedValue);
  const showSuggestions = focused && suggestions.length > 0;

  function pick(s: GeocodeResult) {
    onChange(shortLocationLabel(s.displayName));
    setFocused(false);
  }

  return (
    <div className="relative">
      <label className="text-xs text-muted-foreground">Location</label>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="JVC, Dubai Marina, Al Barsha…"
        className="mt-1 h-9 bg-input"
        autoComplete="off"
      />
      {showSuggestions && (
        <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover shadow-md">
          {suggestions.map((s, i) => (
            <button
              key={`${s.lat}-${s.lng}-${i}`}
              type="button"
              // Prevents the input's onBlur from firing before this button's onClick — otherwise
              // the dropdown would close (and unmount the button) before the click registers.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(s)}
              className="flex w-full items-start gap-1.5 px-3 py-2 text-left text-xs hover:bg-accent/40"
              title={s.displayName}
            >
              <MapPin className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{s.displayName}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ResultRow({ l, jobId }: { l: PropertyListing; jobId: string }) {
  const shotUrl = propertyImageUrl(jobId, l.source_images[0]);
  const thumb = l.image_urls[0] ?? shotUrl;
  const score = l.distress_score;

  return (
    <tr className="hover:bg-accent/20">
      <td className="px-2 py-2">
        {thumb ? (
          <img
            src={thumb}
            alt={l.title}
            className="h-10 w-10 rounded border border-border object-cover"
          />
        ) : (
          <span className="flex h-10 w-10 items-center justify-center rounded border border-border bg-muted/40 text-muted-foreground">
            <ImageOff className="h-3.5 w-3.5" />
          </span>
        )}
      </td>
      <td className="px-2 py-2">
        <div className="flex max-w-xs flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            {l.listing_url ? (
              <a
                href={l.listing_url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 truncate font-medium text-primary hover:underline"
                title={l.title}
              >
                {l.title}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ) : (
              <span className="truncate font-medium" title={l.title}>
                {l.title}
              </span>
            )}
            {l.verified && (
              <span title="Verified listing">
                <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" />
              </span>
            )}
            {l.needs_review && (
              <span
                title="Low-confidence extraction — verify against the capture"
                className="shrink-0 rounded bg-warning/20 px-1 text-[9px] uppercase text-warning"
              >
                review
              </span>
            )}
          </div>
          <span className="truncate text-[11px] text-muted-foreground">
            {l.community ?? l.location_text ?? "—"}
          </span>
          {l.distress_keywords.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {l.distress_keywords.slice(0, 2).map((k) => (
                <Badge key={k} variant="secondary" className="px-1.5 py-0 text-[9px]">
                  {k}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </td>
      <td className="px-2 py-2 text-xs">{formatMoney(l.price, l.currency)}</td>
      <td className="px-2 py-2 text-xs">
        {l.area_sqft !== null ? (
          <span className="inline-flex items-center gap-1">
            <Ruler className="h-3 w-3 text-muted-foreground" />
            {Number(l.area_sqft).toLocaleString()}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-2 py-2 text-xs">
        {l.price_per_sqft !== null ? Number(l.price_per_sqft).toLocaleString() : "—"}
      </td>
      <td className="px-2 py-2 text-xs">
        <span className="inline-flex items-center gap-2">
          <span className="inline-flex items-center gap-0.5">
            <Bed className="h-3 w-3 text-muted-foreground" />
            {l.bedrooms ?? "—"}
          </span>
          <span className="inline-flex items-center gap-0.5">
            <Bath className="h-3 w-3 text-muted-foreground" />
            {l.bathrooms ?? "—"}
          </span>
        </span>
      </td>
      <td className="px-2 py-2 text-xs">
        {l.listed_days_ago !== null ? `${l.listed_days_ago}d ago` : "—"}
      </td>
      <td className="px-2 py-2">
        {score !== null ? (
          <div className="flex items-center gap-1.5">
            <Progress value={Math.max(0, Math.min(100, score))} className="h-1.5 w-14" />
            <span className="font-mono text-[11px]">{score.toFixed(0)}</span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-2 py-2">
        {l.whatsapp_link ? (
          <a href={l.whatsapp_link} target="_blank" rel="noreferrer">
            <Button
              size="sm"
              className="h-7 gap-1 bg-success text-success-foreground hover:bg-success/90"
            >
              <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
            </Button>
          </a>
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
  analysis: NonNullable<ReturnType<typeof usePropertyAnalysis>["data"]>;
}) {
  const { summary, communityBreakdown, top10 } = analysis;

  return (
    <div className="mt-4 grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard
          label="Price range"
          value={
            summary.price.min !== null && summary.price.max !== null
              ? `${summary.price.min.toLocaleString()}–${summary.price.max.toLocaleString()}`
              : "—"
          }
          sub={
            summary.price.median !== null
              ? `median ${summary.price.median.toLocaleString()}`
              : undefined
          }
        />
        <StatCard
          label="AED/sqft range"
          value={
            summary.pricePerSqft.min !== null && summary.pricePerSqft.max !== null
              ? `${summary.pricePerSqft.min.toFixed(0)}–${summary.pricePerSqft.max.toFixed(0)}`
              : "—"
          }
          sub={
            summary.pricePerSqft.median !== null
              ? `median ${summary.pricePerSqft.median.toFixed(0)}`
              : undefined
          }
        />
        <StatCard
          label="Listings"
          value={String(summary.listingCount)}
          sub={summary.needsReviewCount > 0 ? `${summary.needsReviewCount} need review` : undefined}
        />
        <StatCard
          label="Verified"
          value={summary.pctVerified !== null ? `${summary.pctVerified.toFixed(0)}%` : "—"}
        />
        <StatCard
          label="Avg days listed"
          value={summary.avgListedDaysAgo !== null ? summary.avgListedDaysAgo.toFixed(0) : "—"}
          sub={
            summary.detailScrapedCount > 0 ? `${summary.detailScrapedCount} contacted` : undefined
          }
        />
      </div>

      {communityBreakdown.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/10 p-3">
          <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
            By community
          </div>
          <div className="grid gap-1 sm:grid-cols-2">
            {communityBreakdown.slice(0, 10).map((c) => (
              <div
                key={c.community}
                className="flex items-center justify-between rounded px-1.5 py-1 text-xs"
              >
                <span className="min-w-0 flex-1 truncate">{c.community}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {c.count} · {c.medianPrice !== null ? c.medianPrice.toLocaleString() : "—"} AED
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {top10.length > 0 && (
        <div className="rounded-lg border border-border bg-muted/10 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
            <Trophy className="h-3.5 w-3.5" /> Top 10 best value for money
          </div>
          <div className="grid gap-1">
            {top10.map((t, i) => (
              <a
                key={t.id}
                href={t.listingUrl ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/30"
              >
                <span className="w-4 shrink-0 text-muted-foreground">{i + 1}.</span>
                <span className="min-w-0 flex-1 truncate">{t.title}</span>
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {t.price !== null ? t.price.toLocaleString() : "—"} AED
                  {t.pricePerSqft !== null && ` · ${t.pricePerSqft.toFixed(0)}/sqft`}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-primary">
                  {t.distressScore !== null ? t.distressScore.toFixed(0) : "—"}
                </span>
                {t.whatsappLink && <MessageCircle className="h-3.5 w-3.5 shrink-0 text-success" />}
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
