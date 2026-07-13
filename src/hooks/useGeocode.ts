/** Authored by: Mohit Singh */
import { useMutation } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { GeocodeResult } from "@/types/api";

/** Nominatim proxy — used by Discover's location box and the header's quick-launch modal. */
export function useGeocode() {
  return useMutation({
    mutationFn: (query: string) =>
      api.get<{ result: GeocodeResult }>(`/geocode?q=${encodeURIComponent(query)}`),
  });
}
