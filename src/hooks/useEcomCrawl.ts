/** Authored by: Mohit Singh */
//
// Product Research (Ecom-Crawl) — SEPARATE hook module mirroring useOcrCrawl.ts's structure
// exactly (query keys, polling pattern, mutations, file-url helpers). Do not merge with
// useOcrCrawl.ts — the two are deliberately parallel modules (see routes/ecomCrawl.ts's header).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fileUrl } from "@/lib/api-client";
import type {
  EcomAnalysis,
  EcomJob,
  EcomPlatform,
  EcomProduct,
  EcomScoreWeights,
  EcomSortMode,
} from "@/types/api";

export const ecomKeys = {
  all: ["ecom-crawl"] as const,
  list: () => [...ecomKeys.all, "list"] as const,
  detail: (id: string) => [...ecomKeys.all, "detail", id] as const,
  results: (id: string) => [...ecomKeys.all, "results", id] as const,
  analysis: (id: string) => [...ecomKeys.all, "analysis", id] as const,
};

interface CreateEcomJobInput {
  platform: EcomPlatform;
  query: string;
  sortMode?: EcomSortMode;
  maxPages?: number;
  maxProducts?: number;
  detailScrapeTopN?: number;
  scoreWeights?: EcomScoreWeights;
}

// Non-terminal statuses (queued behind the single-flight lock counts as "active" for polling
// purposes, same as OCR's ACTIVE set) — mirrors ecom_jobs.status's CHECK constraint.
const ACTIVE: ReadonlySet<string> = new Set(["queued", "capturing", "ocr", "parsing", "detail"]);

export function useEcomJobs() {
  return useQuery({
    queryKey: ecomKeys.list(),
    queryFn: async () => (await api.get<{ jobs: EcomJob[] }>("/ecom-crawl/jobs")).jobs,
    // Poll while any job is active so the list reflects live status.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((j) => ACTIVE.has(j.status)) ? 2_000 : false,
  });
}

interface EcomJobDetail {
  job: EcomJob;
  progress: { total: number; captured: number; ocrDone: number; detailDone: number };
}

export function useEcomJob(id: string | undefined) {
  return useQuery({
    queryKey: ecomKeys.detail(id ?? ""),
    queryFn: () => api.get<EcomJobDetail>(`/ecom-crawl/jobs/${id}`),
    enabled: id !== undefined,
    refetchInterval: (query) =>
      query.state.data && ACTIVE.has(query.state.data.job.status) ? 2_000 : false,
  });
}

export function useEcomResults(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ecomKeys.results(id ?? ""),
    queryFn: async () =>
      (await api.get<{ products: EcomProduct[] }>(`/ecom-crawl/jobs/${id}/results`)).products,
    enabled: id !== undefined && enabled,
  });
}

export function useEcomAnalysis(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ecomKeys.analysis(id ?? ""),
    queryFn: async () =>
      (await api.get<{ analysis: EcomAnalysis }>(`/ecom-crawl/jobs/${id}/analysis`)).analysis,
    enabled: id !== undefined && enabled,
  });
}

export function useCreateEcomJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEcomJobInput) =>
      api.post<{ job: EcomJob; queuePosition: number }>("/ecom-crawl/jobs", input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ecomKeys.list() });
    },
  });
}

// Resumable retry — the worker picks up from wherever the prior attempt left off. Capped
// server-side at 3 (routes/ecomCrawl.ts's MAX_ECOM_RETRIES).
export function useRetryEcomJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ job: EcomJob; queuePosition: number }>(`/ecom-crawl/jobs/${id}/retry`),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ecomKeys.list() });
      void queryClient.invalidateQueries({ queryKey: ecomKeys.detail(id) });
    },
  });
}

export function useDeleteEcomJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/ecom-crawl/jobs/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ecomKeys.list() });
    },
  });
}

export function ecomExportUrl(id: string, format: "csv" | "xlsx" | "json"): string {
  return fileUrl(`/ecom-crawl/jobs/${id}/export?format=${format}`);
}

// relPath is a captured-screenshot path like "raw/001_slug_p1.png" — served by
// GET /ecom-crawl/jobs/:id/images/*. Returns undefined for an empty/missing relPath so callers
// can fall back to the product's external image_url or a placeholder instead of requesting a
// guaranteed-404.
export function ecomImageUrl(id: string, relPath: string | undefined): string | undefined {
  if (relPath === undefined || relPath === "") return undefined;
  return fileUrl(`/ecom-crawl/jobs/${id}/images/${relPath}`);
}
