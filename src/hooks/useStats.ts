/** Authored by: Mohit Singh */
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { OverviewResponse } from "@/types/api";

export function useOverviewStats() {
  return useQuery({
    queryKey: ["stats", "overview"],
    queryFn: () => api.get<OverviewResponse>("/stats/overview"),
    refetchInterval: 30_000,
  });
}
