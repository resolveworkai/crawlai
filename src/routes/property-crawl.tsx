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
import { useQueryClient } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { RequireAuth } from "@/components/require-auth";
import { RunnerStatusBanner } from "@/components/runner-status-banner";
import {
  propertyExportUrl,
  propertyImageUrl,
  propertyKeys,
  useAddToWishlist,
  useBulkImportBuildingAges,
  useCreatePropertyJob,
  useCreatePropertyJobSchedule,
  useDeleteBuildingAge,
  useDeleteBuildingAgeRegion,
  useDeletePropertyJob,
  useDeletePropertyJobSchedule,
  useListingRefreshStatus,
  usePropertyAnalysis,
  usePropertyBuildingAgeRegions,
  usePropertyBuildingAges,
  usePropertyJob,
  usePropertyJobs,
  usePropertyJobSchedules,
  usePropertyResults,
  usePropertySearch,
  usePropertyWishlist,
  useRefreshListing,
  useRemoveFromWishlist,
  useRetryPropertyJob,
  useSetPropertyJobScheduleEnabled,
} from "@/hooks/usePropertyCrawl";
import { useGeocodeSuggestions } from "@/hooks/useGeocode";
import { timeAgo } from "@/lib/utils";
import {
  AlertTriangle,
  Bath,
  Bed,
  Building2,
  CalendarClock,
  ChevronDown,
  Download,
  ExternalLink,
  GitCompare,
  Heart,
  Home,
  ImageOff,
  Loader2,
  MapPin,
  MessageCircle,
  RefreshCw,
  Ruler,
  Search,
  RotateCcw,
  ShieldCheck,
  TrendingDown,
  Trash2,
  Trophy,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type {
  GeocodeResult,
  PropertyJob,
  PropertyJobSchedule,
  PropertyJobStatus,
  PropertyListingWithHistory,
  PropertyPlatform,
  PropertyPurpose,
  PropertySearchResult,
  PropertySortOrder,
  PropertyStatus,
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
// Actually running a browser session — distinct from merely 'queued'. At most one job PER
// PLATFORM is ever RUNNING at a time (server-enforced, 2026-08-23) — dubizzle and propertyfinder
// can run concurrently (independent sites, independent Playwright pages), so up to 2 jobs total
// may show RUNNING at once; any number may be 'queued' behind either.
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

const PROPERTY_STATUS_OPTIONS: { value: PropertyStatus; label: string }[] = [
  { value: "ready", label: "Ready only" },
  { value: "offplan", label: "Off-plan only" },
  { value: "any", label: "Any" },
];

// The SOURCE SITE's own sort order (applied before scraping) — empirically confirmed live against
// both real sites' own sort UI (see the worker adapters' _SORT_PARAM comments). "Rating"/"review"
// don't exist as a concept on either platform (no listing carries one) — "newest" and "price" are
// the two dimensions BOTH dubizzle and propertyfinder genuinely support server-side.
const SORT_ORDER_OPTIONS: { value: PropertySortOrder; label: string }[] = [
  { value: "default", label: "Site default" },
  { value: "newest", label: "Newest first" },
  { value: "price_low_high", label: "Price: Low to High" },
  { value: "price_high_low", label: "Price: High to Low" },
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

// Property Age — real (detail-page-scraped) age_years always wins when present; otherwise falls
// back to the region building-age reference table's mapped estimate (see
// backend/api/src/db/propertyBuildingAges.ts). The mapped value is prefixed "~" and its title
// names the matched building, so it's visually distinct from a confirmed real age at a glance.
function propertyAgeDisplay(l: {
  age_years: number | null;
  mapped_age_years?: number | null;
  mapped_age_is_estimated?: boolean;
  mapped_building_name?: string | null;
}): { text: string; title?: string } {
  if (l.age_years !== null) return { text: `${l.age_years} yrs` };
  if (l.mapped_age_years != null) {
    const est = l.mapped_age_is_estimated ? " (estimated completion year)" : "";
    return {
      text: `~${l.mapped_age_years} yrs`,
      title: `Estimated from building-age reference: ${l.mapped_building_name ?? "matched building"}${est}`,
    };
  }
  return { text: "—" };
}

type SortKey =
  "distress_score" | "price" | "price_per_sqft" | "area_sqft" | "listed_days_ago" | "average_rent";

// The search criteria a job was launched with, condensed to one line for the recent-jobs list —
// so each row shows what was actually searched for, not just platform + location.
// Shared with scheduleFilterSummary below — omits "default" (the common case) to avoid cluttering
// every job/schedule row with a label that's true most of the time.
function sortOrderLabel(sort: PropertySortOrder): string | null {
  const found = SORT_ORDER_OPTIONS.find((opt) => opt.value === sort);
  return found && found.value !== "default" ? found.label : null;
}

function jobFilterSummary(j: PropertyJob): string {
  const parts: string[] = [
    j.property_type,
    j.purpose,
    j.bedrooms !== null ? (j.bedrooms === 0 ? "Studio" : `${j.bedrooms}BR`) : null,
    j.bathrooms !== null ? `${j.bathrooms} bath` : null,
    j.property_status !== "any"
      ? j.property_status === "ready"
        ? "ready only"
        : "off-plan only"
      : null,
    sortOrderLabel(j.sort_order),
  ].filter((p): p is string => p !== null);
  return parts.join(" · ");
}

function PropertyCrawl() {
  const [platform, setPlatform] = useState<PropertyPlatform>("dubizzle");
  const [location, setLocation] = useState("");
  const [propertyType, setPropertyType] = useState<PropertyType>("apartment");
  const [bedrooms, setBedrooms] = useState("any");
  const [bathrooms, setBathrooms] = useState("any");
  const [purpose, setPurpose] = useState<PropertyPurpose>("buy");
  // Confirmed preference: ready-only by default (see createPropertyJobSchema's own default).
  const [propertyStatus, setPropertyStatus] = useState<PropertyStatus>("ready");
  const [sortOrder, setSortOrder] = useState<PropertySortOrder>("default");
  const [maxPages, setMaxPages] = useState(20);
  const [maxListings, setMaxListings] = useState(100);
  const [detailScrapeTopN, setDetailScrapeTopN] = useState(10);
  const [whatsappTemplate, setWhatsappTemplate] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [sortKey, setSortKey] = useState<SortKey>("price");

  // Client-side results filters — applied AFTER a job's listings are captured, on top of
  // whatever the job's own search criteria (location/bedrooms/bathrooms/property type) already
  // narrowed. Empty communityFilter = no community restriction; empty sqftMin/sqftMax = no bound.
  const [communityFilter, setCommunityFilter] = useState<Set<string>>(new Set());
  const [sqftMin, setSqftMin] = useState("");
  const [sqftMax, setSqftMax] = useState("");
  // Free-text search against the Listing column's own visible content (title, community/
  // location_text, building name) — a plain substring match, case-insensitive.
  const [searchQuery, setSearchQuery] = useState("");

  // Compare selection — deliberately GLOBAL (not scoped to the currently-focused job): stores the
  // full listing snapshot, keyed by listing id, so a listing checked while viewing one job's
  // results stays comparable after switching to a DIFFERENT job's results (which unmounts the
  // first job's `results` array entirely) — comparing across two separate searches only works if
  // the compared rows' own data is held here, not re-derived from whichever job is on screen now.
  const [compareSelection, setCompareSelection] = useState<Map<string, PropertyListingWithHistory>>(
    new Map(),
  );
  const [compareOpen, setCompareOpen] = useState(false);
  const [wishlistOpen, setWishlistOpen] = useState(false);
  const [schedulesOpen, setSchedulesOpen] = useState(false);
  const [buildingAgesOpen, setBuildingAgesOpen] = useState(false);
  const { data: buildingAgeRegions = [] } = usePropertyBuildingAgeRegions();
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false);
  // Stable identity (never a new function per render) — GlobalSearchModal is wrapped in
  // React.memo specifically so an inline arrow function here would defeat the whole point: while
  // a job is active, usePropertyJobs()/usePropertyJob() poll every 2s and re-render this entire
  // component, and a fresh onClose reference on every one of those re-renders would make React
  // treat "props changed" as true and re-render (recreating the underlying <input> DOM node) the
  // modal every 2s too — which is exactly what was making it feel impossible to type into while
  // a search was running. Confirmed useCallback([]) — this function never needs to change.
  const closeGlobalSearch = useCallback(() => setGlobalSearchOpen(false), []);
  // 24h default — a daily re-check is the use case the user described ("fetching the same area
  // listing on daily basis"); the field stays editable per-schedule.
  const [scheduleIntervalHours, setScheduleIntervalHours] = useState(24);

  const { data: jobs = [] } = usePropertyJobs();
  // Up to one RUNNING job per platform now (2026-08-23 — dubizzle/propertyfinder run concurrently,
  // see RUNNING's own comment) — runningJobs may hold 0, 1, or 2 entries.
  const runningJobs = jobs.filter((j) => RUNNING.has(j.status));
  const queuedCount = jobs.filter((j) => j.status === "queued").length;
  const focusId = selectedId ?? runningJobs[0]?.id ?? jobs[0]?.id;
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

  const { data: schedules = [] } = usePropertyJobSchedules();
  const createSchedule = useCreatePropertyJobSchedule();

  const { data: wishlist = [] } = usePropertyWishlist();
  // Membership keyed by listing_url — the wishlist's own real, stable identity (see
  // propertyWishlist.ts's header) — so a listing shows as "saved" consistently across different
  // jobs that happened to capture the SAME real ad, not just within one job's results.
  const wishlistedUrls = useMemo(
    () => new Set(wishlist.map((w) => w.listing_url).filter((u): u is string => u !== null)),
    [wishlist],
  );

  // Distinct community/building names actually present in this job's captured listings — always
  // accurate to what was really scraped, never a fabricated/static list. A listing with neither
  // `community` nor `location_text` set contributes nothing here (still shown by default; only
  // excluded once the community filter is non-empty, same as every other listing that doesn't
  // match a selected value).
  const availableCommunities = useMemo(() => {
    const set = new Set<string>();
    for (const l of results) {
      const c = l.community ?? l.location_text;
      if (c) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [results]);

  const filtered = useMemo(() => {
    const min = sqftMin.trim() === "" ? null : Number(sqftMin);
    const max = sqftMax.trim() === "" ? null : Number(sqftMax);
    const query = searchQuery.trim().toLowerCase();
    return results.filter((l) => {
      if (communityFilter.size > 0) {
        const c = l.community ?? l.location_text;
        if (!c || !communityFilter.has(c)) return false;
      }
      if (min !== null && Number.isFinite(min)) {
        const area = num(l.area_sqft);
        if (area === null || area < min) return false;
      }
      if (max !== null && Number.isFinite(max)) {
        const area = num(l.area_sqft);
        if (area === null || area > max) return false;
      }
      if (query !== "") {
        const haystack = [l.title, l.community, l.location_text]
          .filter((v): v is string => v !== null)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
  }, [results, communityFilter, sqftMin, sqftMax, searchQuery]);

  const sorted = useMemo(() => {
    const rows = [...filtered];
    rows.sort((a, b) => {
      if (sortKey === "price") return (num(a.price) ?? Infinity) - (num(b.price) ?? Infinity);
      if (sortKey === "price_per_sqft")
        return (num(a.price_per_sqft) ?? Infinity) - (num(b.price_per_sqft) ?? Infinity);
      if (sortKey === "area_sqft")
        return (num(b.area_sqft) ?? -Infinity) - (num(a.area_sqft) ?? -Infinity);
      if (sortKey === "listed_days_ago")
        return (b.listed_days_ago ?? -Infinity) - (a.listed_days_ago ?? -Infinity);
      if (sortKey === "average_rent")
        return (num(b.average_rent) ?? -Infinity) - (num(a.average_rent) ?? -Infinity);
      return (b.distress_score ?? -Infinity) - (a.distress_score ?? -Infinity);
    });
    return rows;
  }, [filtered, sortKey]);

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
        propertyStatus,
        sortOrder,
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

  function handleSaveSchedule() {
    if (location.trim() === "") {
      toast.error("Enter a location (e.g. JVC, Dubai Marina, Al Barsha)");
      return;
    }
    createSchedule.mutate(
      {
        platform,
        location: location.trim(),
        propertyType,
        bedrooms: bedrooms === "any" ? undefined : Number(bedrooms),
        bathrooms: bathrooms === "any" ? undefined : Number(bathrooms),
        purpose,
        propertyStatus,
        sortOrder,
        maxPages,
        maxListings,
        detailScrapeTopN,
        whatsappMessageTemplate: whatsappTemplate.trim() || undefined,
        intervalHours: scheduleIntervalHours,
      },
      {
        onSuccess: () => {
          toast.success(
            `Saved — will re-run every ${scheduleIntervalHours}h for "${location.trim()}"`,
          );
          setSchedulesOpen(true);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  }

  // "Refresh" a job = re-run the SAME search criteria as a brand-new job (not to be confused with
  // the per-row RefreshListingButton, which re-checks one already-captured listing's live price).
  // No new backend endpoint needed: the new job is an ordinary createPropertyJob call, and once it
  // captures listings, the EXISTING cross-job price-drop matching (propertyListings.ts's
  // listPropertyListingsWithHistory, matched on listing_url — the site's own stable identity)
  // automatically compares each newly-captured listing's price against whatever this SAME real ad
  // last showed in an earlier job, including this one — so "compare old vs new, highlight price
  // drops" falls out of the existing mechanism for free; this button just saves re-typing the
  // whole search form for a daily re-check of the same area.
  function handleRefreshSearch(job: PropertyJob) {
    createJob.mutate(
      {
        platform: job.platform,
        location: job.location,
        propertyType: job.property_type,
        bedrooms: job.bedrooms ?? undefined,
        bathrooms: job.bathrooms ?? undefined,
        purpose: job.purpose,
        propertyStatus: job.property_status,
        sortOrder: job.sort_order,
        maxPages: job.max_pages,
        maxListings: job.max_listings,
        detailScrapeTopN: job.detail_scrape_top_n,
        whatsappMessageTemplate: job.whatsapp_message_template ?? undefined,
        scoreWeights: job.score_weights ?? undefined,
      },
      {
        onSuccess: ({ job: newJob, queuePosition }) => {
          toast.success(
            queuePosition > 0
              ? `Refresh queued behind ${queuePosition} job${queuePosition > 1 ? "s" : ""} — new listings will show price drops vs this search`
              : `Refreshing "${job.location}" — new listings will show price drops vs this search`,
          );
          setSelectedId(newJob.id);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  }

  function toggleCompare(l: PropertyListingWithHistory) {
    setCompareSelection((prev) => {
      const next = new Map(prev);
      if (next.has(l.id)) next.delete(l.id);
      else next.set(l.id, l);
      return next;
    });
  }

  return (
    <AppShell
      title="Property Research"
      subtitle="Search dubizzle/propertyfinder for a location + bedroom/bathroom filter, capture every listing, and rank the top deals by price-per-sqft, distress-sale language, freshness, and verification — best value for money first."
    >
      <RunnerStatusBanner runnerNames={["property"]} />
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
            <label className="text-xs text-muted-foreground">Status</label>
            <Select
              value={propertyStatus}
              onValueChange={(v) => setPropertyStatus(v as PropertyStatus)}
            >
              <SelectTrigger className="mt-1 h-9 bg-input">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROPERTY_STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Sort by</label>
            <Select value={sortOrder} onValueChange={(v) => setSortOrder(v as PropertySortOrder)}>
              <SelectTrigger className="mt-1 h-9 bg-input">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SORT_ORDER_OPTIONS.map((opt) => (
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

        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <label className="text-xs text-muted-foreground">Repeat every</label>
          <Input
            type="number"
            min={6}
            max={720}
            value={scheduleIntervalHours}
            onChange={(e) =>
              setScheduleIntervalHours(Math.min(720, Math.max(6, Number(e.target.value) || 6)))
            }
            className="h-9 w-20 bg-input"
            title="Recurrence interval in hours (6–720)"
          />
          <span className="text-xs text-muted-foreground">hours</span>
          <Button
            variant="outline"
            className="gap-1.5"
            disabled={createSchedule.isPending}
            onClick={handleSaveSchedule}
          >
            <CalendarClock className="h-3.5 w-3.5" />
            Save as recurring
          </Button>
          <Button className="gap-1.5" disabled={createJob.isPending} onClick={handleLaunch}>
            <Home className="h-3.5 w-3.5" />
            Launch
          </Button>
        </div>

        {runningJobs.length > 0 && (
          <p className="mt-2 text-[11px] text-muted-foreground">
            {runningJobs.length === 1
              ? `${runningJobs[0]!.platform} is running now`
              : `Running now: ${runningJobs.map((j) => j.platform).join(" + ")} (in parallel)`}
            {queuedCount > 0 && ` (${queuedCount} more queued behind)`} — new jobs queue and
            auto-run in order per platform, no need to wait.
          </p>
        )}
      </Card>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          onClick={() => setWishlistOpen((v) => !v)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <Heart
            className={`h-4 w-4 ${wishlist.length > 0 ? "fill-destructive text-destructive" : ""}`}
          />
          Wishlist{wishlist.length > 0 ? ` (${wishlist.length})` : ""}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${wishlistOpen ? "rotate-180" : ""}`}
          />
        </button>
        <button
          onClick={() => setSchedulesOpen((v) => !v)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <CalendarClock
            className={`h-4 w-4 ${schedules.some((s) => s.enabled) ? "text-primary" : ""}`}
          />
          Scheduled Searches{schedules.length > 0 ? ` (${schedules.length})` : ""}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${schedulesOpen ? "rotate-180" : ""}`}
          />
        </button>
        <button
          onClick={() => setGlobalSearchOpen(true)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <Search className="h-4 w-4" />
          Global Search
        </button>
        <button
          onClick={() => setBuildingAgesOpen((v) => !v)}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <Building2 className="h-4 w-4" />
          Property Age Data{buildingAgeRegions.length > 0 ? ` (${buildingAgeRegions.length})` : ""}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${buildingAgesOpen ? "rotate-180" : ""}`}
          />
        </button>
      </div>
      {wishlistOpen && <WishlistPanel />}
      {schedulesOpen && <SchedulesPanel />}
      {buildingAgesOpen && <BuildingAgesPanel />}
      {globalSearchOpen && <GlobalSearchModal onClose={closeGlobalSearch} />}

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
              {!ACTIVE.has(focus.status) && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 gap-1.5 border-border"
                  disabled={createJob.isPending}
                  title="Re-run this same search as a new job — new listings will be checked for price drops against this one"
                  onClick={() => handleRefreshSearch(focus)}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh Search
                </Button>
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
                  { key: "price", label: "Price ↑" },
                  { key: "distress_score", label: "Best value" },
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
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="text-[11px] text-muted-foreground">Filter</span>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search listing, building, community…"
                  className="h-8 w-56 bg-input pl-7 text-xs"
                />
              </div>
              <CommunityMultiSelect
                options={availableCommunities}
                selected={communityFilter}
                onChange={setCommunityFilter}
              />
              <Input
                type="number"
                value={sqftMin}
                onChange={(e) => setSqftMin(e.target.value)}
                placeholder="Min sqft"
                className="h-8 w-24 bg-input text-xs"
              />
              <span className="text-[11px] text-muted-foreground">–</span>
              <Input
                type="number"
                value={sqftMax}
                onChange={(e) => setSqftMax(e.target.value)}
                placeholder="Max sqft"
                className="h-8 w-24 bg-input text-xs"
              />
              {(searchQuery.trim() !== "" ||
                communityFilter.size > 0 ||
                sqftMin.trim() !== "" ||
                sqftMax.trim() !== "") && (
                <>
                  <button
                    onClick={() => {
                      setSearchQuery("");
                      setCommunityFilter(new Set());
                      setSqftMin("");
                      setSqftMax("");
                    }}
                    className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" /> Clear filters
                  </button>
                  <span className="text-[11px] text-muted-foreground">
                    {sorted.length} of {results.length} shown
                  </span>
                </>
              )}
            </div>
          )}

          {showResults && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-[11px] uppercase tracking-wide text-muted-foreground">
                    <th className="px-2 py-2 text-left font-medium">
                      <span className="sr-only">Compare</span>
                    </th>
                    <th className="px-2 py-2 text-left font-medium">Photo</th>
                    <th className="px-2 py-2 text-left font-medium">Listing</th>
                    <SortHeader label="Price" col="price" sortKey={sortKey} onSort={setSortKey} />
                    <SortHeader
                      label="Area"
                      col="area_sqft"
                      sortKey={sortKey}
                      onSort={setSortKey}
                    />
                    <SortHeader
                      label="AED/sqft"
                      col="price_per_sqft"
                      sortKey={sortKey}
                      onSort={setSortKey}
                    />
                    <th className="px-2 py-2 text-left font-medium">Beds/Baths</th>
                    <SortHeader
                      label="Rented for"
                      col="average_rent"
                      sortKey={sortKey}
                      onSort={setSortKey}
                    />
                    <th className="px-2 py-2 text-left font-medium">Property Age</th>
                    <SortHeader
                      label="Score"
                      col="distress_score"
                      sortKey={sortKey}
                      onSort={setSortKey}
                    />
                    <th className="px-2 py-2 text-left font-medium">Contact</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sorted.length === 0 && (
                    <tr>
                      <td colSpan={11} className="px-2 py-8 text-center text-muted-foreground">
                        No listings parsed.
                      </td>
                    </tr>
                  )}
                  {sorted.map((l) => (
                    <ResultRow
                      key={l.id}
                      l={l}
                      jobId={focus.id}
                      compareChecked={compareSelection.has(l.id)}
                      onToggleCompare={() => toggleCompare(l)}
                      wishlisted={l.listing_url !== null && wishlistedUrls.has(l.listing_url)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {compareSelection.size > 0 && (
        <div className="fixed bottom-4 left-1/2 z-30 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-card px-4 py-2 shadow-lg">
          <GitCompare className="h-4 w-4 text-primary" />
          <span className="text-sm">
            {compareSelection.size} listing{compareSelection.size === 1 ? "" : "s"} selected
          </span>
          <Button size="sm" className="h-7" onClick={() => setCompareOpen(true)}>
            Compare
          </Button>
          <button
            onClick={() => setCompareSelection(new Map())}
            className="text-muted-foreground hover:text-foreground"
            title="Clear compare selection"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {compareOpen && (
        <CompareModal
          listings={Array.from(compareSelection.values())}
          onRemove={(id) =>
            setCompareSelection((prev) => {
              const next = new Map(prev);
              next.delete(id);
              return next;
            })
          }
          onClose={() => setCompareOpen(false)}
        />
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
              className={`flex w-full flex-col gap-1 px-4 py-2.5 text-left text-sm hover:bg-accent/30 ${
                j.id === focusId ? "bg-accent/20" : ""
              }`}
            >
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
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
              </div>
              <span className="truncate text-[11px] text-muted-foreground">
                {jobFilterSummary(j)}
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

// Building/community multi-select — options come from `availableCommunities` (distinct values
// actually present in this job's captured listings, see the useMemo above), never a fabricated
// static list. Selecting several communities shows listings matching ANY of them (union), not
// all — the usual "faceted filter" semantics.
function CommunityMultiSelect({
  options,
  selected,
  onChange,
}: {
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);

  function toggle(value: string) {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  }

  const label =
    selected.size === 0
      ? "Building / community"
      : selected.size === 1
        ? Array.from(selected)[0]
        : `${selected.size} communities`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] ${
            selected.size > 0
              ? "border-primary bg-primary/10 text-primary"
              : "border-border text-muted-foreground hover:text-foreground"
          }`}
        >
          <MapPin className="h-3 w-3" />
          <span className="max-w-[160px] truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search building / community…" className="h-8 text-xs" />
          <CommandList>
            <CommandEmpty className="py-4 text-center text-xs text-muted-foreground">
              No communities captured yet.
            </CommandEmpty>
            <CommandGroup>
              {options.map((opt) => (
                <CommandItem
                  key={opt}
                  onSelect={() => toggle(opt)}
                  className="flex items-center gap-2 text-xs"
                >
                  <Checkbox checked={selected.has(opt)} onCheckedChange={() => toggle(opt)} />
                  <span className="truncate">{opt}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Clickable column header — mirrors routes/ecom-crawl.tsx's own SortHeader exactly, so both
// modules' results tables behave identically. Each column sorts in its own fixed direction (see
// the `sorted` useMemo's comparator) rather than toggling asc/desc on repeated clicks.
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
  l,
  jobId,
  compareChecked,
  onToggleCompare,
  wishlisted,
}: {
  l: PropertyListingWithHistory;
  jobId: string;
  compareChecked: boolean;
  onToggleCompare: () => void;
  wishlisted: boolean;
}) {
  const shotUrl = propertyImageUrl(jobId, l.source_images[0]);
  const thumb = l.image_urls[0] ?? shotUrl;
  const score = l.distress_score;
  const addToWishlist = useAddToWishlist();

  return (
    <tr className={`hover:bg-accent/20 ${l.price_dropped ? "bg-success/10" : ""}`}>
      <td className="px-2 py-2">
        <Checkbox
          checked={compareChecked}
          onCheckedChange={onToggleCompare}
          aria-label="Select for comparison"
        />
      </td>
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
            {l.is_offplan && (
              <span
                title="Off-plan listing"
                className="shrink-0 rounded bg-primary/15 px-1 text-[9px] uppercase text-primary"
              >
                off-plan
              </span>
            )}
            {l.price_dropped && (
              <span
                title="Price dropped since it was last seen"
                className="flex shrink-0 items-center gap-0.5 rounded bg-success/20 px-1 text-[9px] uppercase text-success"
              >
                <TrendingDown className="h-2.5 w-2.5" /> price drop
              </span>
            )}
            {l.possible_duplicate && (
              <a
                href={l.possible_duplicate.listingUrl ?? undefined}
                target={l.possible_duplicate.listingUrl ? "_blank" : undefined}
                rel={l.possible_duplicate.listingUrl ? "noreferrer" : undefined}
                title={`Likely the same unit on ${l.possible_duplicate.platform}: "${l.possible_duplicate.title}" (${formatMoney(l.possible_duplicate.price, l.currency)}) — same community/beds/baths, close price+area`}
                className="flex shrink-0 items-center gap-0.5 rounded bg-warning/20 px-1 text-[9px] uppercase text-warning hover:underline"
              >
                <GitCompare className="h-2.5 w-2.5" /> also on {l.possible_duplicate.platform}
              </a>
            )}
            <button
              onClick={() => {
                if (wishlisted) return;
                addToWishlist.mutate(l.id, {
                  onSuccess: ({ alreadySaved }) =>
                    toast.success(alreadySaved ? "Already in wishlist" : "Saved to wishlist"),
                  onError: (e) => toast.error(e.message),
                });
              }}
              disabled={addToWishlist.isPending}
              title={wishlisted ? "In your wishlist" : "Save to wishlist"}
              className="shrink-0"
            >
              <Heart
                className={`h-3.5 w-3.5 ${wishlisted ? "fill-destructive text-destructive" : "text-muted-foreground hover:text-destructive"}`}
              />
            </button>
            <RefreshListingButton listing={l} />
          </div>
          <span className="truncate text-[11px] text-muted-foreground">
            {l.community ?? l.location_text ?? "—"}
          </span>
          {/* Detail-page-only field (see rule: only populated for the job's top-N scraped
              listings) — shown only when present, never a placeholder "—" for every other row.
              average_rent has its own dedicated "Rented for" table column instead of appearing
              here too — no need to duplicate it. */}
          {l.age_years !== null && (
            <span className="text-[11px] text-muted-foreground">
              {l.age_years} yr{l.age_years === 1 ? "" : "s"} old
            </span>
          )}
          {l.listed_date !== null && (
            <span className="text-[11px] text-muted-foreground">Posted {l.listed_date}</span>
          )}
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
      <td className="px-2 py-2 text-xs">
        {(() => {
          const priorPrice = l.previous_price ?? l.latest_refresh?.old_price ?? null;
          return (
            <div className="flex flex-col">
              <span className={l.price_dropped ? "font-medium text-success" : undefined}>
                {formatMoney(l.price, l.currency)}
              </span>
              {l.price_dropped && priorPrice !== null && (
                <span className="text-[10px] text-muted-foreground line-through">
                  {formatMoney(priorPrice, l.currency)}
                </span>
              )}
            </div>
          );
        })()}
      </td>
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
        {l.average_rent !== null ? (
          <span title="Detail-page-only field — populated for the job's top-ranked listings">
            {formatMoney(l.average_rent, l.currency)}/yr
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="px-2 py-2 text-xs" title={propertyAgeDisplay(l).title}>
        {propertyAgeDisplay(l).text}
      </td>
      <td className="px-2 py-2">
        {score !== null ? (
          <div
            className="flex items-center gap-1.5"
            title={
              l.distress_confidence !== null
                ? `Confidence: ${l.distress_confidence.toFixed(0)}% of this score is backed by real data (price/area/rent/freshness) rather than a neutral fallback`
                : undefined
            }
          >
            <Progress value={Math.max(0, Math.min(100, score))} className="h-1.5 w-14" />
            <span className="font-mono text-[11px]">{score.toFixed(0)}</span>
            {l.distress_confidence !== null && (
              <span className="text-[9px] text-muted-foreground">
                ({l.distress_confidence.toFixed(0)}% conf.)
              </span>
            )}
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

// Per-row "re-check this exact listing's live price" button — queues a refresh, polls it to a
// terminal state, then re-fetches the job's results so the row shows the fresh price (and, if it
// came down, the green price-drop highlight) without a full page reload.
function RefreshListingButton({ listing }: { listing: PropertyListingWithHistory }) {
  const [refreshId, setRefreshId] = useState<string | undefined>(undefined);
  const refreshListing = useRefreshListing();
  const { data: statusData } = useListingRefreshStatus(listing.id, refreshId);
  const status = statusData?.refresh.status;
  const queryClient = useQueryClient();
  const pending = status === "queued" || status === "running" || refreshListing.isPending;

  useEffect(() => {
    if (status === "done" || status === "failed") {
      void queryClient.invalidateQueries({ queryKey: propertyKeys.results(listing.job_id) });
      if (status === "failed") {
        toast.error(statusData?.refresh.error_message ?? "Refresh failed");
      } else {
        const oldP = statusData?.refresh.old_price;
        const newP = statusData?.refresh.new_price;
        toast.success(
          oldP !== null && newP !== null && oldP !== undefined && newP !== undefined
            ? `Refreshed — ${Number(newP) < Number(oldP) ? "price dropped" : "price checked"} (${Number(newP).toLocaleString()})`
            : "Refreshed",
        );
      }
      setRefreshId(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when status flips
  }, [status]);

  return (
    <button
      onClick={() =>
        refreshListing.mutate(listing.id, {
          onSuccess: ({ refresh }) => setRefreshId(refresh.id),
          onError: (e) => toast.error(e.message),
        })
      }
      disabled={pending}
      title="Re-check this listing's current price"
      className="shrink-0"
    >
      <RefreshCw
        className={`h-3.5 w-3.5 text-muted-foreground hover:text-foreground ${pending ? "animate-spin" : ""}`}
      />
    </button>
  );
}

// Side-by-side comparison of every checked listing — works across jobs (the caller passes the
// snapshot held in compareSelection, not a re-fetch of the current job's results) since a listing
// stays comparable after switching to a different search's results.
function CompareModal({
  listings,
  onRemove,
  onClose,
}: {
  listings: PropertyListingWithHistory[];
  onRemove: (id: string) => void;
  onClose: () => void;
}) {
  const rows: { label: string; render: (l: PropertyListingWithHistory) => ReactNode }[] = [
    { label: "Price", render: (l) => formatMoney(l.price, l.currency) },
    {
      label: "Area",
      render: (l) => (l.area_sqft !== null ? `${Number(l.area_sqft).toLocaleString()} sqft` : "—"),
    },
    {
      label: "AED/sqft",
      render: (l) => (l.price_per_sqft !== null ? Number(l.price_per_sqft).toLocaleString() : "—"),
    },
    { label: "Beds", render: (l) => l.bedrooms ?? "—" },
    { label: "Baths", render: (l) => l.bathrooms ?? "—" },
    { label: "Type", render: (l) => l.property_type ?? "—" },
    { label: "Community", render: (l) => l.community ?? l.location_text ?? "—" },
    { label: "Status", render: (l) => (l.is_offplan ? "Off-plan" : "Ready") },
    { label: "Property Age", render: (l) => propertyAgeDisplay(l).text },
    {
      label: "Avg. rent",
      render: (l) =>
        l.average_rent !== null ? `AED ${Number(l.average_rent).toLocaleString()}/yr` : "—",
    },
    {
      label: "Rented for",
      render: (l) =>
        l.average_rent !== null ? `${formatMoney(l.average_rent, l.currency)}/yr` : "—",
    },
    {
      label: "Score",
      render: (l) =>
        l.distress_score !== null
          ? `${l.distress_score.toFixed(0)}${l.distress_confidence !== null ? ` (${l.distress_confidence.toFixed(0)}% conf.)` : ""}`
          : "—",
    },
    { label: "Verified", render: (l) => (l.verified ? "Yes" : "—") },
  ];

  // z-[60], not z-40: every shadcn overlay in src/components/ui/* (Popover/Select/DropdownMenu/
  // Tooltip/etc.) uses z-50 — a lower z-index here let a still-mounted library overlay elsewhere on
  // the page render on top of this one and silently swallow every click meant for it.
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[85vh] w-full max-w-4xl overflow-auto rounded-lg border border-border bg-card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <GitCompare className="h-4 w-4" /> Compare listings
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
        {listings.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No listings selected — check a few rows to compare them here.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="w-28 px-2 py-1.5 text-left text-muted-foreground"></th>
                {listings.map((l) => (
                  <th key={l.id} className="min-w-[160px] px-2 py-1.5 text-left align-top">
                    <div className="flex items-start justify-between gap-1">
                      <span className="line-clamp-2 font-medium" title={l.title}>
                        {l.title}
                      </span>
                      <button
                        onClick={() => onRemove(l.id)}
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                    {l.listing_url && (
                      <a
                        href={l.listing_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-0.5 flex items-center gap-1 text-[10px] text-primary hover:underline"
                      >
                        View listing <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((row) => (
                <tr key={row.label}>
                  <td className="px-2 py-1.5 font-medium text-muted-foreground">{row.label}</td>
                  {listings.map((l) => (
                    <td key={l.id} className="px-2 py-1.5">
                      {row.render(l)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Saved-for-later listings — a lightweight variant of the results table (no sort/filter, since
// this is a small hand-picked list, not a big captured batch).
function WishlistPanel() {
  const { data: items = [], isLoading } = usePropertyWishlist();
  const removeItem = useRemoveFromWishlist();

  return (
    <Card className="mt-2 border-border bg-card p-4">
      {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
      {!isLoading && items.length === 0 && (
        <p className="text-xs text-muted-foreground">
          Nothing saved yet — click the heart icon on any listing to save it here.
        </p>
      )}
      {items.length > 0 && (
        <div className="grid gap-2">
          {items.map((w) => (
            <div
              key={w.id}
              className="flex items-center justify-between gap-3 rounded border border-border px-3 py-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate font-medium" title={w.title}>
                    {w.title}
                  </span>
                  <span className="shrink-0 rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">
                    {w.platform}
                  </span>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {formatMoney(w.price, w.currency)}
                  {(w.community ?? w.location_text) ? ` · ${w.community ?? w.location_text}` : ""}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {w.listing_url && (
                  <a href={w.listing_url} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                  </a>
                )}
                <button
                  onClick={() =>
                    removeItem.mutate(w.id, { onError: (e) => toast.error(e.message) })
                  }
                  disabled={removeItem.isPending}
                  title="Remove from wishlist"
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// Same shape/logic as jobFilterSummary above, just against a PropertyJobSchedule's own field
// names — kept as a separate tiny function rather than genericizing jobFilterSummary, since the
// two types only coincidentally share these 5 field names today and a future divergence
// shouldn't force either call site to fight a shared signature.
function scheduleFilterSummary(s: PropertyJobSchedule): string {
  const parts: string[] = [
    s.property_type,
    s.purpose,
    s.bedrooms !== null ? (s.bedrooms === 0 ? "Studio" : `${s.bedrooms}BR`) : null,
    s.bathrooms !== null ? `${s.bathrooms} bath` : null,
    s.property_status !== "any"
      ? s.property_status === "ready"
        ? "ready only"
        : "off-plan only"
      : null,
    sortOrderLabel(s.sort_order),
  ].filter((p): p is string => p !== null);
  return parts.join(" · ");
}

function hoursUntil(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "due now";
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return "in <1h";
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

// Recurring searches — checked server-side every 5 minutes (services/propertyScheduler.ts) and
// materialized into a real property_jobs row when due, no different from clicking Launch by hand.
function SchedulesPanel() {
  const { data: schedules = [], isLoading } = usePropertyJobSchedules();
  const setEnabled = useSetPropertyJobScheduleEnabled();
  const deleteSchedule = useDeletePropertyJobSchedule();

  return (
    <Card className="mt-2 border-border bg-card p-4">
      {isLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
      {!isLoading && schedules.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No recurring searches yet — set a location/filters above and click "Save as recurring" to
          have it re-run automatically (e.g. daily, to catch new listings and price drops).
        </p>
      )}
      {schedules.length > 0 && (
        <div className="grid gap-2">
          {schedules.map((s) => (
            <div
              key={s.id}
              className="flex items-center justify-between gap-3 rounded border border-border px-3 py-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate font-medium" title={s.location}>
                    {s.location}
                  </span>
                  <span className="shrink-0 rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">
                    {s.platform}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    every {s.interval_hours}h
                  </span>
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {scheduleFilterSummary(s)}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {s.enabled ? `Next run ${hoursUntil(s.next_run_at)}` : "Paused"}
                  {s.last_run_at && ` · last fired ${timeAgo(s.last_run_at)}`}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <Switch
                  checked={s.enabled}
                  onCheckedChange={(checked) =>
                    setEnabled.mutate(
                      { id: s.id, enabled: checked },
                      { onError: (e) => toast.error(e.message) },
                    )
                  }
                  disabled={setEnabled.isPending}
                  title={s.enabled ? "Pause this schedule" : "Resume this schedule"}
                />
                <button
                  onClick={() =>
                    deleteSchedule.mutate(s.id, { onError: (e) => toast.error(e.message) })
                  }
                  disabled={deleteSchedule.isPending}
                  title="Delete this schedule"
                >
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground hover:text-destructive" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// Property Age reference data — manually curated per region: the user pastes a building-name ->
// completion-year table (e.g. copied from a spreadsheet), and it fills in the Property Age column
// for any listing that was never individually detail-scraped (real age_years is detail-page-only,
// sparse). See backend/api/src/db/propertyBuildingAges.ts / buildingAgeTableParser.ts.
function BuildingAgesPanel() {
  const { data: regions = [], isLoading: regionsLoading } = usePropertyBuildingAgeRegions();
  const [expandedRegion, setExpandedRegion] = useState<string | null>(null);
  const [importRegion, setImportRegion] = useState("");
  const [importText, setImportText] = useState("");
  const bulkImport = useBulkImportBuildingAges();
  const deleteRegion = useDeleteBuildingAgeRegion();

  function handleImport() {
    const region = importRegion.trim();
    if (!region) {
      toast.error('Enter a region name first (e.g. "Dubai Sports City")');
      return;
    }
    if (!importText.trim()) {
      toast.error("Paste the building-name / completion-year table first");
      return;
    }
    bulkImport.mutate(
      { region, rawText: importText },
      {
        onSuccess: ({ imported }) => {
          toast.success(
            `Imported ${imported} building${imported === 1 ? "" : "s"} for "${region}"`,
          );
          setImportText("");
        },
        onError: (e) => toast.error(e.message),
      },
    );
  }

  return (
    <Card className="mt-2 border-border bg-card p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
        <Input
          value={importRegion}
          onChange={(e) => setImportRegion(e.target.value)}
          placeholder='Region (e.g. "Dubai Sports City")'
          className="h-9 text-xs"
        />
        <div className="flex flex-col gap-2 sm:flex-row">
          <Textarea
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="Paste the building name / completion year table here — tab-separated (from a spreadsheet) or space-aligned both work. e.g.:&#10;1&#9;Amal Tower&#9;2025&#9;1 yr&#10;2&#9;Golf Tower&#9;2010&#9;16 yrs"
            className="min-h-20 flex-1 text-xs"
          />
          <Button
            onClick={handleImport}
            disabled={bulkImport.isPending}
            size="sm"
            className="h-9 shrink-0 self-start"
          >
            {bulkImport.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Import"}
          </Button>
        </div>
      </div>

      <div className="mt-4 border-t border-border pt-3">
        {regionsLoading && <p className="text-xs text-muted-foreground">Loading…</p>}
        {!regionsLoading && regions.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No building-age data yet — paste a region's table above to fill in Property Age for
            listings that were never individually detail-scraped.
          </p>
        )}
        {regions.length > 0 && (
          <div className="grid gap-1.5">
            {regions.map((r) => (
              <div key={r.region}>
                <div className="flex items-center justify-between gap-3 rounded border border-border px-3 py-2 text-xs">
                  <button
                    onClick={() => setExpandedRegion((cur) => (cur === r.region ? null : r.region))}
                    className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-foreground"
                  >
                    <ChevronDown
                      className={`h-3 w-3 shrink-0 transition-transform ${expandedRegion === r.region ? "rotate-180" : ""}`}
                    />
                    <span className="truncate font-medium">{r.region}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground">
                      {r.count} building{r.count === 1 ? "" : "s"}
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      deleteRegion.mutate(r.region, {
                        onSuccess: ({ removed }) =>
                          toast.success(`Removed ${removed} entries for "${r.region}"`),
                        onError: (e) => toast.error(e.message),
                      });
                      if (expandedRegion === r.region) setExpandedRegion(null);
                    }}
                    disabled={deleteRegion.isPending}
                    title={`Delete all building-age data for ${r.region}`}
                  >
                    <Trash2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground hover:text-destructive" />
                  </button>
                </div>
                {expandedRegion === r.region && <BuildingAgeRegionDetail region={r.region} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}

function BuildingAgeRegionDetail({ region }: { region: string }) {
  const { data: buildings = [], isLoading } = usePropertyBuildingAges(region);
  const deleteOne = useDeleteBuildingAge();

  if (isLoading) return <p className="mt-1.5 px-3 text-xs text-muted-foreground">Loading…</p>;

  return (
    <div className="mt-1.5 max-h-64 overflow-y-auto rounded border border-border">
      <table className="w-full text-xs">
        <tbody className="divide-y divide-border">
          {buildings.map((b) => (
            <tr key={b.id}>
              <td className="px-3 py-1.5">{b.building_name}</td>
              <td className="px-3 py-1.5 text-muted-foreground">
                {b.completion_year !== null
                  ? `${b.completion_year}${b.is_estimated ? " (est.)" : ""}`
                  : "unknown year"}
              </td>
              <td className="px-3 py-1.5 text-right">
                <button
                  onClick={() => deleteOne.mutate(b.id, { onError: (e) => toast.error(e.message) })}
                  disabled={deleteOne.isPending}
                  title="Delete this entry"
                >
                  <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Global search — across EVERY captured listing (not scoped to one job), matched against the
// listing's title/community/location_text (a tower/building name usually shows up in one of
// those). Self-contained: owns its own query input + debounce, rather than syncing with the
// toolbar trigger button — simpler than keeping two components' state in lockstep, and matches
// WishlistPanel/CompareModal's own self-contained-panel convention in this file.
//
// Wrapped in memo() (paired with PropertyCrawl's stable closeGlobalSearch callback, see its own
// comment) so PropertyCrawl's frequent re-renders while a job is active (usePropertyJobs/
// usePropertyJob poll every 2s) never touch this component's subtree at all — the fix for "can't
// type in Global Search while a search is running" (2026-08-24).
const GlobalSearchModal = memo(function GlobalSearchModal({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 350);
  const trimmed = debouncedQuery.trim();
  const { data: results = [], isLoading, isFetching } = usePropertySearch(trimmed, true);
  const { data: wishlist = [] } = usePropertyWishlist();
  const wishlistedUrls = useMemo(
    () => new Set(wishlist.map((w) => w.listing_url).filter((u): u is string => u !== null)),
    [wishlist],
  );
  const addToWishlist = useAddToWishlist();

  // z-[60], not z-40 — see CompareModal's identical comment: every shadcn overlay in
  // src/components/ui/* is z-50, and a still-mounted one elsewhere on the page (a Popover/Select
  // left open) would otherwise render on top of this and swallow every click into the input.
  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/50 p-4 pt-[8vh]">
      <div className="max-h-[80vh] w-full max-w-3xl overflow-hidden rounded-lg border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border p-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tower or building name (e.g. Marina Gate 2, Damac Hills 2)…"
            className="h-9 flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
          <button
            onClick={onClose}
            className="shrink-0 text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[calc(80vh-56px)] overflow-y-auto p-3">
          {trimmed.length > 0 && trimmed.length < 2 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Keep typing — at least 2 characters.
            </p>
          )}
          {trimmed.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Searches every listing ever captured, across all searches/platforms — type a tower,
              building, or community name.
            </p>
          )}
          {trimmed.length >= 2 && isLoading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching…
            </div>
          )}
          {trimmed.length >= 2 && !isLoading && results.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No listings matched "{trimmed}" in anything captured so far.
            </p>
          )}
          {results.length > 0 && (
            <div className="grid gap-3">
              {isFetching && !isLoading && (
                <p className="text-[11px] text-muted-foreground">Updating…</p>
              )}
              {results.map((l, index) => (
                <GlobalSearchResultCard
                  key={l.id}
                  l={l}
                  defaultExpanded={index === 0}
                  wishlisted={l.listing_url !== null && wishlistedUrls.has(l.listing_url)}
                  onAddToWishlist={() =>
                    addToWishlist.mutate(l.id, {
                      onSuccess: ({ alreadySaved }) =>
                        toast.success(alreadySaved ? "Already in wishlist" : "Saved to wishlist"),
                      onError: (e) => toast.error(e.message),
                    })
                  }
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

// One matched listing rendered as a full detail card (a modal's list naturally reads better as
// vertical cards than the compact table rows the main results view uses) — every field the main
// ResultRow shows, plus which job/platform/search it came from since a global-search result can
// be from any of them.
function GlobalSearchResultCard({
  l,
  wishlisted,
  defaultExpanded,
  onAddToWishlist,
}: {
  l: PropertySearchResult;
  wishlisted: boolean;
  defaultExpanded: boolean;
  onAddToWishlist: () => void;
}) {
  const thumb = l.image_urls[0] ?? propertyImageUrl(l.job_id, l.source_images[0]);
  const priorPrice = l.previous_price ?? l.latest_refresh?.old_price ?? null;
  // Only the first result opens by default (the strongest match) — every other card starts
  // collapsed to keep a long results list scannable; the header row toggles it either way.
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <div
      className={`flex gap-3 rounded-md border border-border p-3 ${l.price_dropped ? "bg-success/10" : ""}`}
    >
      {thumb ? (
        <img
          src={thumb}
          alt={l.title}
          className="h-20 w-20 shrink-0 rounded border border-border object-cover"
        />
      ) : (
        <span className="flex h-20 w-20 shrink-0 items-center justify-center rounded border border-border bg-muted/40 text-muted-foreground">
          <ImageOff className="h-4 w-4" />
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div
          onClick={() => setExpanded((v) => !v)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setExpanded((v) => !v);
            }
          }}
          className="flex cursor-pointer flex-wrap items-center gap-1.5"
        >
          {l.listing_url ? (
            <a
              href={l.listing_url}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 truncate text-sm font-medium text-primary hover:underline"
              title={l.title}
            >
              {l.title}
              <ExternalLink className="h-3 w-3 shrink-0" />
            </a>
          ) : (
            <span className="truncate text-sm font-medium" title={l.title}>
              {l.title}
            </span>
          )}
          <span className="shrink-0 rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground">
            {l.platform}
          </span>
          {l.verified && (
            <span title="Verified listing">
              <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-success" />
            </span>
          )}
          {l.is_offplan && (
            <span className="shrink-0 rounded bg-primary/15 px-1 text-[9px] uppercase text-primary">
              off-plan
            </span>
          )}
          {l.price_dropped && (
            <span className="flex shrink-0 items-center gap-0.5 rounded bg-success/20 px-1 text-[9px] uppercase text-success">
              <TrendingDown className="h-2.5 w-2.5" /> price drop
            </span>
          )}
          {l.possible_duplicate && (
            <span
              title={`Likely the same unit on ${l.possible_duplicate.platform}: "${l.possible_duplicate.title}"`}
              className="flex shrink-0 items-center gap-0.5 rounded bg-warning/20 px-1 text-[9px] uppercase text-warning"
            >
              <GitCompare className="h-2.5 w-2.5" /> also on {l.possible_duplicate.platform}
            </span>
          )}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (!wishlisted) onAddToWishlist();
            }}
            title={wishlisted ? "In your wishlist" : "Save to wishlist"}
            className="ml-auto shrink-0"
          >
            <Heart
              className={`h-3.5 w-3.5 ${wishlisted ? "fill-destructive text-destructive" : "text-muted-foreground hover:text-destructive"}`}
            />
          </button>
          <ChevronDown
            className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </div>

        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          Captured under "{l.job_location}" search · {timeAgo(l.created_at)}
        </p>

        {expanded && (
          <>
            <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Price</div>
                <div className={l.price_dropped ? "font-medium text-success" : undefined}>
                  {formatMoney(l.price, l.currency)}
                </div>
                {l.price_dropped && priorPrice !== null && (
                  <div className="text-[10px] text-muted-foreground line-through">
                    {formatMoney(priorPrice, l.currency)}
                  </div>
                )}
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">AED/sqft</div>
                <div>
                  {l.price_per_sqft !== null ? Number(l.price_per_sqft).toLocaleString() : "—"}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Area</div>
                <div>
                  {l.area_sqft !== null ? `${Number(l.area_sqft).toLocaleString()} sqft` : "—"}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Beds/Baths</div>
                <div className="inline-flex items-center gap-2">
                  <span className="inline-flex items-center gap-0.5">
                    <Bed className="h-3 w-3 text-muted-foreground" />
                    {l.bedrooms ?? "—"}
                  </span>
                  <span className="inline-flex items-center gap-0.5">
                    <Bath className="h-3 w-3 text-muted-foreground" />
                    {l.bathrooms ?? "—"}
                  </span>
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Rented for</div>
                <div>
                  {l.average_rent !== null ? `${formatMoney(l.average_rent, l.currency)}/yr` : "—"}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Property Age</div>
                <div title={propertyAgeDisplay(l).title}>{propertyAgeDisplay(l).text}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Score</div>
                <div>
                  {l.distress_score !== null ? l.distress_score.toFixed(0) : "—"}
                  {l.distress_confidence !== null && (
                    <span className="text-[10px] text-muted-foreground">
                      {" "}
                      ({l.distress_confidence.toFixed(0)}% conf.)
                    </span>
                  )}
                </div>
              </div>
              <div>
                <div className="text-[10px] uppercase text-muted-foreground">Community</div>
                <div className="truncate">{l.community ?? l.location_text ?? "—"}</div>
              </div>
            </div>

            {l.distress_keywords.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {l.distress_keywords.map((k) => (
                  <Badge key={k} variant="secondary" className="px-1.5 py-0 text-[9px]">
                    {k}
                  </Badge>
                ))}
              </div>
            )}

            {l.description && (
              <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{l.description}</p>
            )}

            {(l.agent_name || l.whatsapp_link) && (
              <div className="mt-2 flex items-center gap-2 text-xs">
                {l.agent_name && <span className="text-muted-foreground">{l.agent_name}</span>}
                {l.whatsapp_link && (
                  <a href={l.whatsapp_link} target="_blank" rel="noreferrer">
                    <Button
                      size="sm"
                      className="h-6 gap-1 bg-success px-2 text-success-foreground hover:bg-success/90"
                    >
                      <MessageCircle className="h-3 w-3" /> WhatsApp
                    </Button>
                  </a>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
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
