/** Authored by: Mohit Singh */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, fileUrl } from "@/lib/api-client";
import type { ExportFormat, ExportRecord } from "@/types/api";

export const exportKeys = {
  all: ["exports"] as const,
};

export function useExports() {
  return useQuery({
    queryKey: exportKeys.all,
    queryFn: () => api.get<{ exports: ExportRecord[] }>("/exports"),
  });
}

export function useCreateExport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (format: ExportFormat) =>
      api.post<{ export: ExportRecord }>("/exports", { format }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: exportKeys.all });
    },
  });
}

// Not a fetch — a plain browser navigation to the download endpoint (cookies ride along
// automatically). See lib/api-client.ts's fileUrl() for why this is safe/simpler than a
// fetch+blob+objectURL dance.
export function downloadExportUrl(id: string): string {
  return fileUrl(`/exports/${id}/download`);
}
