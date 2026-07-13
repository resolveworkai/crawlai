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

// Manual Google enrichment (POST /businesses/:id/enrich-google) is Phase 6 — its hook lands
// with that endpoint, not before.
