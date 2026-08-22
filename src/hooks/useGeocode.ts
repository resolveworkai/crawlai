/** Authored by: Mohit Singh */
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { GeocodeResult } from "@/types/api";

/** Nominatim proxy — used by Discover's location box and the header's quick-launch modal. */
export function useGeocode() {
  return useMutation({
    mutationFn: (query: string) =>
      api.get<{ result: GeocodeResult }>(`/geocode?q=${encodeURIComponent(query)}`),
  });
}

// Multi-result variant for as-you-type autocomplete (e.g. the Property Research location field —
// routes/property-crawl.tsx). `query` should already be debounced by the caller; this hook only
// gates on length so it never fires a request for a 1-character query. Same Nominatim proxy as
// useGeocode() above — see backend/api/src/lib/geocode.ts.
export function useGeocodeSuggestions(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ["geocode-suggest", q],
    queryFn: async () =>
      (
        await api.get<{ results: GeocodeResult[] }>(
          `/geocode/suggest?q=${encodeURIComponent(q)}&limit=5`,
        )
      ).results,
    enabled: q.length >= 2,
    staleTime: 60_000,
  });
}
