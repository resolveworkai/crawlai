/** Authored by: Mohit Singh */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, sseUrl } from "@/lib/api-client";
import type { CrawlJob, CrawlLog } from "@/types/api";

export const jobKeys = {
  all: ["jobs"] as const,
  list: () => [...jobKeys.all, "list"] as const,
  detail: (id: string) => [...jobKeys.all, "detail", id] as const,
};

interface CreateJobInput {
  businessType: string;
  radiusKm: number;
  location?: string;
  centerLat?: number;
  centerLng?: number;
}

export function useJobs() {
  return useQuery({
    queryKey: jobKeys.list(),
    queryFn: async () => (await api.get<{ jobs: CrawlJob[] }>("/jobs")).jobs,
    refetchInterval: 5_000,
  });
}

export function useJob(id: string | undefined) {
  return useQuery({
    queryKey: jobKeys.detail(id ?? ""),
    queryFn: async () => (await api.get<{ job: CrawlJob }>(`/jobs/${id}`)).job,
    enabled: id !== undefined,
  });
}

export function useCreateJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateJobInput) =>
      (await api.post<{ job: CrawlJob }>("/jobs", input)).job,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: jobKeys.list() });
    },
  });
}

function useJobAction(action: "pause" | "resume" | "retry" | "cancel") {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await api.post<{ job: CrawlJob }>(`/jobs/${id}/${action}`)).job,
    onSuccess: (_data, id) => {
      void queryClient.invalidateQueries({ queryKey: jobKeys.list() });
      void queryClient.invalidateQueries({ queryKey: jobKeys.detail(id) });
    },
  });
}

export const usePauseJob = () => useJobAction("pause");
export const useResumeJob = () => useJobAction("resume");
export const useRetryJob = () => useJobAction("retry");
export const useCancelJob = () => useJobAction("cancel");

export function useDeleteJob() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/jobs/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: jobKeys.list() });
    },
  });
}

/** Live per-job progress + log tail via SSE — see routes/jobs.ts's "job"/"logs" event names. */
export function useJobStream(id: string | undefined) {
  const [job, setJob] = useState<CrawlJob | null>(null);
  const [logs, setLogs] = useState<CrawlLog[]>([]);
  const queryClient = useQueryClient();

  useEffect(() => {
    setJob(null);
    setLogs([]);
    if (id === undefined) return;
    const source = new EventSource(sseUrl(`/jobs/${id}/stream`), { withCredentials: true });

    source.addEventListener("job", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as CrawlJob;
      setJob(data);
      queryClient.setQueryData(jobKeys.detail(id), data);
    });
    source.addEventListener("logs", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as CrawlLog[];
      setLogs((prev) => [...data, ...prev].slice(0, 200));
    });
    source.onerror = () => {
      // EventSource auto-reconnects; nothing to do here beyond letting it retry.
    };

    return () => source.close();
  }, [id, queryClient]);

  return { job, logs };
}

/** Global recent-activity log stream (Overview dashboard + Jobs console panel). */
export function useGlobalLogStream() {
  const [logs, setLogs] = useState<CrawlLog[]>([]);

  useEffect(() => {
    const source = new EventSource(sseUrl("/logs/stream"), { withCredentials: true });
    source.addEventListener("logs", (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as CrawlLog[];
      setLogs((prev) => [...data, ...prev].slice(0, 200));
    });
    source.onerror = () => {
      // EventSource auto-reconnects.
    };
    return () => source.close();
  }, []);

  return logs;
}
