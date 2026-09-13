/** Authored by: Mohit Singh */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fileUrl } from "@/lib/api-client";
import type { OcrBusiness, OcrJob } from "@/types/api";

export const ocrKeys = {
  all: ["ocr-crawl"] as const,
  list: () => [...ocrKeys.all, "list"] as const,
  detail: (id: string) => [...ocrKeys.all, "detail", id] as const,
  results: (id: string) => [...ocrKeys.all, "results", id] as const,
};

interface CreateOcrJobInput {
  query: string;
  location: string;
  maxResults: number;
  expandHours: boolean;
  langs?: string;
  centerLat?: number;
  centerLng?: number;
  radiusKm?: number;
}

const ACTIVE: ReadonlySet<string> = new Set(["queued", "capturing", "ocr", "parsing"]);

export function useOcrJobs() {
  return useQuery({
    queryKey: ocrKeys.list(),
    queryFn: async () => (await api.get<{ jobs: OcrJob[] }>("/ocr-crawl/jobs")).jobs,
    // Poll while any job is active so the list reflects live status.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((j) => ACTIVE.has(j.status)) ? 2_000 : false,
  });
}

interface OcrJobDetail {
  job: OcrJob;
  progress: { total: number; captured: number; ocrDone: number };
}

export function useOcrJob(id: string | undefined) {
  return useQuery({
    queryKey: ocrKeys.detail(id ?? ""),
    queryFn: () => api.get<OcrJobDetail>(`/ocr-crawl/jobs/${id}`),
    enabled: id !== undefined,
    refetchInterval: (query) =>
      query.state.data && ACTIVE.has(query.state.data.job.status) ? 2_000 : false,
  });
}

export function useOcrResults(id: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ocrKeys.results(id ?? ""),
    queryFn: async () =>
      (await api.get<{ businesses: OcrBusiness[] }>(`/ocr-crawl/jobs/${id}/results`)).businesses,
    enabled: id !== undefined && enabled,
  });
}

export function useCreateOcrJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOcrJobInput) =>
      api.post<{ job: OcrJob; queuePosition: number }>("/ocr-crawl/jobs", input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ocrKeys.list() });
    },
  });
}

// Resumable retry — the worker picks up from wherever the prior attempt left off (see
// md/OCR_CRAWL.md's retry section), never from zero. Capped server-side at 3 (routes/ocrCrawl.ts).
export function useRetryOcrJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ job: OcrJob; queuePosition: number }>(`/ocr-crawl/jobs/${id}/retry`),
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: ocrKeys.list() });
      void queryClient.invalidateQueries({ queryKey: ocrKeys.detail(id) });
    },
  });
}

export function useDeleteOcrJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/ocr-crawl/jobs/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ocrKeys.list() });
    },
  });
}

export function ocrExportUrl(id: string, format: "csv" | "xlsx"): string {
  return fileUrl(`/ocr-crawl/jobs/${id}/export?format=${format}`);
}

// Row-level export — one business as a single-line CSV/XLSX, same columns as the whole-job export.
export function ocrBusinessExportUrl(
  jobId: string,
  businessId: string,
  format: "csv" | "xlsx",
): string {
  return fileUrl(`/ocr-crawl/jobs/${jobId}/businesses/${businessId}/export?format=${format}`);
}

export function ocrImageUrl(id: string, relPath: string): string {
  // relPath is like "raw/001_slug_p1.png" — served by GET /ocr-crawl/jobs/:id/images/*
  return fileUrl(`/ocr-crawl/jobs/${id}/images/${relPath}`);
}
