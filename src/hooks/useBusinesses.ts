/** Authored by: Mohit Singh */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { Business, EnrichmentStatus } from "@/types/api";

export const businessKeys = {
  all: ["businesses"] as const,
  list: (filters: BusinessFilters) => [...businessKeys.all, "list", filters] as const,
  detail: (id: string) => [...businessKeys.all, "detail", id] as const,
};

export interface BusinessFilters {
  category?: string;
  city?: string;
  enrichmentStatus?: EnrichmentStatus;
  hasEmail?: boolean;
  search?: string;
  limit?: number;
  offset?: number;
}

interface BusinessListResponse {
  businesses: Business[];
  total: number;
  limit: number;
  offset: number;
}

function toQueryString(filters: BusinessFilters): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs.length > 0 ? `?${qs}` : "";
}

export function useBusinesses(filters: BusinessFilters = {}) {
  return useQuery({
    queryKey: businessKeys.list(filters),
    queryFn: () => api.get<BusinessListResponse>(`/businesses${toQueryString(filters)}`),
  });
}

export function useBusiness(id: string | undefined) {
  return useQuery({
    queryKey: businessKeys.detail(id ?? ""),
    queryFn: async () => (await api.get<{ business: Business }>(`/businesses/${id}`)).business,
    enabled: id !== undefined,
  });
}

export function useDeleteBusiness() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/businesses/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: businessKeys.all });
    },
  });
}

// Phase 6 — manual, per-business Google enrichment (rating/review-count/photos). The button
// that triggers this is hidden/disabled when `configured` is false (no GOOGLE_API_KEY on the
// backend) — see useGoogleEnrichmentStatus below and businesses.tsx.
export function useGoogleEnrichmentStatus() {
  return useQuery({
    queryKey: [...businessKeys.all, "google-enrichment-status"] as const,
    queryFn: () => api.get<{ configured: boolean }>("/businesses/google-enrichment-status"),
    staleTime: 5 * 60 * 1000, // rarely changes — only on a backend env/config change
  });
}

export function useEnrichBusinessWithGoogle() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ business: Business }>(`/businesses/${id}/enrich-google`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: businessKeys.all });
    },
  });
}
