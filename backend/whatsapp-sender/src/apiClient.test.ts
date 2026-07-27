/** Authored by: Mohit Singh */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClient, ApiError } from "./apiClient.js";

const BASE_URL = "http://localhost:4010";

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("ApiClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("login captures the Set-Cookie header and replays it on later requests", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        200,
        { user: { id: "u1" } },
        { "set-cookie": "access_token=abc; HttpOnly; Path=/" },
      ),
    );
    const client = new ApiClient(BASE_URL);
    await client.login("op@example.com", "pw");

    fetchMock.mockResolvedValueOnce(jsonResponse(200, { campaign: { id: "c1" }, recipients: [] }));
    await client.getCampaign("c1");

    const secondCallInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const headers = secondCallInit.headers as Record<string, string>;
    expect(headers.Cookie).toContain("access_token=abc");
  });

  it("login throws ApiError when the request fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { message: "bad creds" } }));
    const client = new ApiClient(BASE_URL);
    await expect(client.login("op@example.com", "wrong")).rejects.toThrow(ApiError);
  });

  it("getCampaign returns the parsed campaign + recipients", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        campaign: {
          id: "c1",
          channel: "whatsapp",
          status: "draft",
          total_count: 1,
          sent_count: 0,
          failed_count: 0,
          skipped_count: 0,
        },
        recipients: [
          {
            id: "r1",
            business_name: "Gym A",
            phone: "+911111111111",
            wa_link: "https://wa.me/911111111111?text=hi",
            status: "pending",
          },
        ],
      }),
    );
    const client = new ApiClient(BASE_URL);
    const result = await client.getCampaign("c1");
    expect(result.campaign.id).toBe("c1");
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0]!.wa_link).toContain("wa.me");
  });

  it("markSent and markFailed hit the expected endpoints", async () => {
    const client = new ApiClient(BASE_URL);
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        recipient: { id: "r1", status: "sent" },
        campaign: { sent_count: 1 },
      }),
    );
    await client.markSent("c1", "r1");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `${BASE_URL}/marketing/campaigns/c1/recipients/r1/mark-sent`,
    );

    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
        recipient: { id: "r2", status: "failed", error: "chat never loaded" },
        campaign: { failed_count: 1 },
      }),
    );
    await client.markFailed("c1", "r2", "chat never loaded");
    const call = fetchMock.mock.calls[1];
    expect(call?.[0]).toBe(`${BASE_URL}/marketing/campaigns/c1/recipients/r2/mark-failed`);
    const init = call?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ error: "chat never loaded" });
  });

  it("wraps a non-2xx response in ApiError with the server's message", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(404, { error: { message: "Recipient not found" } }),
    );
    const client = new ApiClient(BASE_URL);
    await expect(client.markSent("c1", "missing")).rejects.toMatchObject({
      status: 404,
      message: "Recipient not found",
    });
  });
});
