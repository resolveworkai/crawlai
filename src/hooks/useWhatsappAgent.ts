/** Authored by: Mohit Singh */
//
// Client for the LOCAL WhatsApp automation agent (backend/whatsapp-sender, started separately by
// the operator on their own machine via `npm run agent` — see its README). Talks directly to
// 127.0.0.1:8787, NOT the main backend API — a completely different, local-only process. It is
// normal for this to be unreachable (the operator hasn't started it, or doesn't want to); every
// caller must handle that as an expected state, not an error to surface loudly.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const AGENT_BASE_URL = "http://127.0.0.1:8787";

export interface AgentStatus {
  running: boolean;
  campaignId?: string;
  total?: number;
  sent?: number;
  failed?: number;
  remaining?: number;
  lastMessage?: string;
  done?: boolean;
}

async function agentFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${AGENT_BASE_URL}${path}`, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Agent request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

const agentStatusKey = ["whatsapp-agent", "status"] as const;

export function useAgentStatus(options: { enabled: boolean; poll: boolean }) {
  return useQuery({
    queryKey: agentStatusKey,
    queryFn: () => agentFetch<AgentStatus>("/status"),
    enabled: options.enabled,
    retry: false,
    refetchInterval: options.poll ? 2000 : false,
  });
}

export function useStartAutomatedSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { campaignId: string }) =>
      agentFetch<{ ok: true }>("/start", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentStatusKey }),
  });
}

export function useStopAutomatedSend() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => agentFetch<{ ok: true }>("/stop", { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: agentStatusKey }),
  });
}

export function useAgentTestSend() {
  return useMutation({
    mutationFn: (message?: string) =>
      agentFetch<{ ok: true }>("/test-send", {
        method: "POST",
        body: JSON.stringify(message ? { message } : {}),
      }),
  });
}
