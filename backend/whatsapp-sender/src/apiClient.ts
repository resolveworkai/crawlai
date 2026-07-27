/** Authored by: Mohit Singh */
//
// Thin client for the already-shipped Marketing API — this agent is purely a consumer of
// GET /marketing/campaigns/:id, POST .../mark-sent, and POST .../mark-failed (see
// backend/api/src/routes/marketing.ts). No new backend surface exists just for automation; the
// same endpoints the manual click-to-chat UI uses. Auth is cookie-based (httpOnly access/refresh
// cookies, matching src/lib/api-client.ts's frontend convention) — logging in here captures the
// Set-Cookie response and replays it on every subsequent request.
export interface CampaignRecipientDto {
  id: string;
  business_name: string;
  phone: string | null;
  wa_link: string | null;
  status: "pending" | "sent" | "failed" | "skipped";
}

export interface CampaignDto {
  id: string;
  channel: "whatsapp" | "email";
  status: string;
  total_count: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export class ApiClient {
  private cookie = "";

  constructor(private readonly baseUrl: string) {}

  async login(email: string, password: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new ApiError(res.status, `Login failed (${res.status})`);
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie)
      throw new ApiError(res.status, "Login succeeded but no session cookie was returned");
    // Multiple Set-Cookie headers arrive folded into one string by undici; split on the
    // comma-before-name pattern is unreliable, so just forward each `name=value` pair found.
    this.cookie = setCookie
      .split(/,(?=[^;]+?=)/)
      .map((c) => c.split(";")[0])
      .join("; ");
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        Cookie: this.cookie,
      },
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      throw new ApiError(
        res.status,
        body.error?.message ?? `Request to ${path} failed (${res.status})`,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  getCampaign(
    campaignId: string,
  ): Promise<{ campaign: CampaignDto; recipients: CampaignRecipientDto[] }> {
    return this.request(`/marketing/campaigns/${campaignId}`);
  }

  markSent(
    campaignId: string,
    recipientId: string,
  ): Promise<{ recipient: CampaignRecipientDto; campaign: CampaignDto }> {
    return this.request(`/marketing/campaigns/${campaignId}/recipients/${recipientId}/mark-sent`, {
      method: "POST",
    });
  }

  markFailed(
    campaignId: string,
    recipientId: string,
    error?: string,
  ): Promise<{ recipient: CampaignRecipientDto; campaign: CampaignDto }> {
    return this.request(
      `/marketing/campaigns/${campaignId}/recipients/${recipientId}/mark-failed`,
      {
        method: "POST",
        body: JSON.stringify({ error }),
      },
    );
  }
}
