/** Authored by: Mohit Singh */
//
// Property Research (Property-Crawl) — SEPARATE hook module mirroring useEcomCrawl.ts's
// structure exactly (query keys, polling pattern, mutations, file-url helpers). Do not merge
// with useEcomCrawl.ts — the two are deliberately parallel modules (see routes/propertyCrawl.ts's
// header).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fileUrl } from "@/lib/api-client";
import type {
  PropertyAnalysis,
  PropertyJob,
  PropertyJobSchedule,
  PropertyListingRefresh,
  PropertyListingWithHistory,
  PropertyPlatform,
  PropertyPurpose,
  PropertyScoreWeights,
  PropertyStatus,
  PropertyType,
  PropertyWishlistItem,
} from "@/types/api";

export const propertyKeys = {
  all: ["property-crawl"] as const,
  list: () => [...propertyKeys.all, "list"] as const,
  detail: (id: string) => [...propertyKeys.all, "detail", id] as const,
  results: (id: string) => [...propertyKeys.all, "results", id] as const,
  analysis: (id: string) => [...propertyKeys.all, "analysis", id] as const,
  wishlist: () => [...propertyKeys.all, "wishlist"] as const,
  refresh: (listingId: string, refreshId: string) =>
    [...propertyKeys.all, "refresh", listingId, refreshId] as const,
  schedules: () => [...propertyKeys.all, "schedules"] as const,
};

interface CreatePropertyJobInput {
  platform: PropertyPlatform;
  location: string;
  bedrooms?: number;
  bathrooms?: number;
  propertyType?: PropertyType;
  purpose?: PropertyPurpose;
  propertyStatus?: PropertyStatus;
  maxPages?: number;
  maxListings?: number;
  detailScrapeTopN?: number;
  whatsappMessageTemplate?: string;
  scoreWeights?: PropertyScoreWeights;
}

// Same shape as CreatePropertyJobInput plus the recurrence interval — mirrors
// backend/api/src/schemas/propertyCrawl.ts's createPropertyJobScheduleSchema (.extend).
interface CreatePropertyJobScheduleInput extends CreatePropertyJobInput {
  intervalHours: number;
}

// Non-terminal statuses — mirrors property_jobs.status's CHECK constraint.
const ACTIVE: ReadonlySet<string> = new Set([
  "queued",
  "capturing",
  "parsing",
  "detail",
  "scoring",
]);

export function usePropertyJobs() {
  return useQuery({
    queryKey: propertyKeys.list(),
    queryFn: async () => (await api.get<{ jobs: PropertyJob[] }>("/property-crawl/jobs")).jobs,
    // Poll while any job is active so the list reflects live status.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((j) => ACTIVE.has(j.status)) ? 2_000 : false,
  });
}

interface PropertyJobDetail {
  job: PropertyJob;
  progress: { total: number; captured: number; detailDone: number };
}

export function usePropertyJob(id: string | undefined) {
  return useQuery({
    queryKey: propertyKeys.detail(id ?? ""),
    queryFn: () => api.get<PropertyJobDetail>(`/property-crawl/jobs/${id}`),
    enabled: id !== undefined,
    refetchInterval: (query) =>
      query.state.data && ACTIVE.has(query.state.data.job.status) ? 2_000 : false,
  });
}

export function usePropertyResults(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: propertyKeys.results(id ?? ""),
    queryFn: async () =>
      (
        await api.get<{ listings: PropertyListingWithHistory[] }>(
          `/property-crawl/jobs/${id}/results`,
        )
      ).listings,
    enabled: id !== undefined && enabled,
  });
}

export function usePropertyAnalysis(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: propertyKeys.analysis(id ?? ""),
    queryFn: async () =>
      (await api.get<{ analysis: PropertyAnalysis }>(`/property-crawl/jobs/${id}/analysis`))
        .analysis,
    enabled: id !== undefined && enabled,
  });
}

export function useCreatePropertyJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePropertyJobInput) =>
      api.post<{ job: PropertyJob; queuePosition: number }>("/property-crawl/jobs", input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: propertyKeys.list() });
    },
  });
}

// Resumable retry — the worker picks up from wherever the prior attempt left off. Capped
// server-side at 3 (routes/propertyCrawl.ts's MAX_PROPERTY_RETRIES).
export function useRetryPropertyJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ job: PropertyJob; queuePosition: number }>(`/property-crawl/jobs/${id}/retry`),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: propertyKeys.list() });
      void queryClient.invalidateQueries({ queryKey: propertyKeys.detail(id) });
    },
  });
}

export function useDeletePropertyJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/property-crawl/jobs/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: propertyKeys.list() });
    },
  });
}

export function propertyExportUrl(id: string, format: "csv" | "xlsx" | "json"): string {
  return fileUrl(`/property-crawl/jobs/${id}/export?format=${format}`);
}

// relPath is a captured-screenshot path — served by GET /property-crawl/jobs/:id/images/*.
// Returns undefined for an empty/missing relPath so callers can fall back to the listing's own
// site photo (image_urls[0]) or a placeholder instead of requesting a guaranteed-404.
export function propertyImageUrl(id: string, relPath: string | undefined): string | undefined {
  if (relPath === undefined || relPath === "") return undefined;
  return fileUrl(`/property-crawl/jobs/${id}/images/${relPath}`);
}

// --- Wishlist (save-for-later) -------------------------------------------------------------------

export function usePropertyWishlist() {
  return useQuery({
    queryKey: propertyKeys.wishlist(),
    queryFn: async () =>
      (await api.get<{ items: PropertyWishlistItem[] }>("/property-crawl/wishlist")).items,
  });
}

export function useAddToWishlist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (listingId: string) =>
      api.post<{ item: PropertyWishlistItem; alreadySaved: boolean }>("/property-crawl/wishlist", {
        listingId,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: propertyKeys.wishlist() });
    },
  });
}

export function useRemoveFromWishlist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/property-crawl/wishlist/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: propertyKeys.wishlist() });
    },
  });
}

// --- Per-listing refresh --------------------------------------------------------------------------
// Two-step: POST creates (or reuses an already-pending) refresh request, then the caller polls its
// status via useListingRefreshStatus until it's done/failed — same "queue + poll" shape as job
// creation/polling above, just for a single row instead of a whole job.

export function useRefreshListing() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (listingId: string) =>
      api.post<{ refresh: PropertyListingRefresh }>(
        `/property-crawl/listings/${listingId}/refresh`,
      ),
    onSuccess: () => {
      // The refresh itself updates the listing's row once done — results are re-fetched by the
      // status poller below reaching a terminal state, not from this call directly.
      void queryClient.invalidateQueries({ queryKey: propertyKeys.all });
    },
  });
}

const REFRESH_TERMINAL: ReadonlySet<string> = new Set(["done", "failed"]);

export function useListingRefreshStatus(
  listingId: string | undefined,
  refreshId: string | undefined,
) {
  return useQuery({
    queryKey: propertyKeys.refresh(listingId ?? "", refreshId ?? ""),
    queryFn: () =>
      api.get<{ refresh: PropertyListingRefresh }>(
        `/property-crawl/listings/${listingId}/refresh/${refreshId}`,
      ),
    enabled: listingId !== undefined && refreshId !== undefined,
    refetchInterval: (query) =>
      query.state.data && !REFRESH_TERMINAL.has(query.state.data.refresh.status) ? 2_000 : false,
  });
}

// --- Recurring search (schedule) -------------------------------------------------------------
// Fired server-side every 5 minutes by backend/api/src/services/propertyScheduler.ts — the
// frontend only ever CRUDs the schedule row itself, never triggers a run directly.

export function usePropertyJobSchedules() {
  return useQuery({
    queryKey: propertyKeys.schedules(),
    queryFn: async () =>
      (await api.get<{ schedules: PropertyJobSchedule[] }>("/property-crawl/schedules")).schedules,
    // Slow poll — next_run_at/last_run_at only change on a 5-minute server tick, so anything
    // faster is pure waste. Refreshing at all (rather than not polling) keeps "next run" times
    // and a just-fired schedule's job link visibly up to date without a manual page reload.
    refetchInterval: 30_000,
  });
}

export function useCreatePropertyJobSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreatePropertyJobScheduleInput) =>
      api.post<{ schedule: PropertyJobSchedule }>("/property-crawl/schedules", input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: propertyKeys.schedules() });
    },
  });
}

export function useSetPropertyJobScheduleEnabled() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.patch<{ schedule: PropertyJobSchedule }>(`/property-crawl/schedules/${id}/enabled`, {
        enabled,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: propertyKeys.schedules() });
    },
  });
}

export function useDeletePropertyJobSchedule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/property-crawl/schedules/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: propertyKeys.schedules() });
    },
  });
}
