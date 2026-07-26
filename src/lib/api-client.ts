/** Authored by: Mohit Singh */
//
// Thin fetch wrapper — credentials:'include' sends the httpOnly auth cookies (see
// backend/api/src/auth/cookies.ts) on every request, including cross-origin in local dev
// (frontend:3000 -> backend:4010). Base URL is baked in at build time (VITE_API_URL) since
// the browser can't resolve the Docker-internal "backend" hostname — see Dockerfile.

const API_BASE_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:4010";

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

// The access-token cookie expires after 15 minutes (auth/cookies.ts) but the refresh cookie
// lasts 7 days — without a transparent refresh-and-retry, every session would silently log
// out every 15 minutes. Coalesced so concurrent 401s trigger exactly one refresh call.
let refreshInFlight: Promise<boolean> | null = null;

function refreshAccessToken(): Promise<boolean> {
  refreshInFlight ??= fetch(`${API_BASE_URL}/auth/refresh`, {
    method: "POST",
    credentials: "include",
  })
    .then((res) => res.ok)
    .catch(() => false)
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

async function rawRequest(path: string, init: RequestInit | undefined): Promise<Response> {
  return fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
}

async function request<T>(path: string, init?: RequestInit, isRetry = false): Promise<T> {
  const res = await rawRequest(path, init);

  if (res.status === 401 && !isRetry && path !== "/auth/login" && path !== "/auth/refresh") {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request<T>(path, init, true);
  }

  if (res.status === 204) return undefined as T;

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body: unknown = isJson ? await res.json() : await res.text();

  if (!res.ok) {
    const errorBody = body as { error?: { code?: string; message?: string } };
    throw new ApiError(
      res.status,
      errorBody?.error?.code ?? "UNKNOWN_ERROR",
      errorBody?.error?.message ?? `Request failed with status ${res.status}`,
    );
  }

  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path, { method: "GET" }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "POST",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PUT",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: "PATCH",
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  delete: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// SSE base URL for EventSource — cookies are sent automatically by the browser (no
// credentials option needed/available on EventSource), which is exactly why auth uses
// httpOnly cookies rather than bearer tokens. See auth/cookies.ts.
export function sseUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

// File-download URL (Phase 7 exports) — a plain <a href> navigation, not a fetch+blob dance.
// Regular browser navigation (even a new-tab open) sends the httpOnly auth cookie the same as
// any top-level GET, so no explicit credentials handling is needed here.
export function fileUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}
