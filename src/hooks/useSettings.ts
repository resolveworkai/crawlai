/** Authored by: Mohit Singh */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api-client";
import type { CrawlSettings } from "@/types/api";

export const settingsKeys = {
  all: ["settings"] as const,
};

// Mirrors schemas/settings.ts's updateSettingsSchema exactly (.strict() — map_provider and
// discovery_source are read-only, not patchable, so they're deliberately excluded here too).
type UpdateSettingsInput = Partial<
  Pick<
    CrawlSettings,
    | "concurrency"
    | "retry_count"
    | "timeout_ms"
    | "user_agent"
    | "max_businesses_per_job"
    | "crawl_website"
    | "respect_robots_txt"
    | "follow_sitemaps"
    | "request_delay_ms"
    | "use_ai_extraction"
    | "proxy_url"
    | "ocr_max_results"
  >
>;

export function useSettings() {
  return useQuery({
    queryKey: settingsKeys.all,
    queryFn: async () => (await api.get<{ settings: CrawlSettings }>("/settings")).settings,
  });
}

export function useUpdateSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: UpdateSettingsInput) =>
      (await api.patch<{ settings: CrawlSettings }>("/settings", patch)).settings,
    onSuccess: (data) => {
      queryClient.setQueryData(settingsKeys.all, data);
    },
  });
}
