/** Authored by: Mohit Singh */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";

export function createQueryWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return { Wrapper, queryClient };
}

interface MockResponse {
  body?: unknown;
  status?: number;
}

function toResponse({ body, status = 200 }: MockResponse): Response {
  if (status === 204 || body === undefined) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stubs global fetch to return each response in order, one per call. */
export function mockFetchSequence(...responses: MockResponse[]) {
  const fn = vi.fn();
  responses.forEach((r) => fn.mockResolvedValueOnce(toResponse(r)));
  vi.stubGlobal("fetch", fn);
  return fn;
}
