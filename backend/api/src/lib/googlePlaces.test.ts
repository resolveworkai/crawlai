/** Authored by: Mohit Singh */
//
// Pure unit tests — fetch is fully mocked, no real Google API or Postgres involved. Each test
// reloads the module fresh (vi.resetModules) so GOOGLE_API_KEY can be toggled per test despite
// config.ts being a module-level singleton parsed once at import time.
import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

async function loadModule(apiKey: string | undefined) {
  vi.resetModules();
  if (apiKey === undefined) delete process.env.GOOGLE_API_KEY;
  else process.env.GOOGLE_API_KEY = apiKey;
  return import("./googlePlaces.js");
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  if (ORIGINAL_GOOGLE_API_KEY === undefined) delete process.env.GOOGLE_API_KEY;
  else process.env.GOOGLE_API_KEY = ORIGINAL_GOOGLE_API_KEY;
  vi.resetModules();
});

describe("isGoogleEnrichmentConfigured", () => {
  it("is false when GOOGLE_API_KEY is unset", async () => {
    const mod = await loadModule(undefined);
    expect(mod.isGoogleEnrichmentConfigured()).toBe(false);
  });

  it("is true when GOOGLE_API_KEY is set", async () => {
    const mod = await loadModule("test-key");
    expect(mod.isGoogleEnrichmentConfigured()).toBe(true);
  });
});

describe("findPlaceId", () => {
  it("throws when GOOGLE_API_KEY is not configured", async () => {
    const mod = await loadModule(undefined);
    await expect(mod.findPlaceId("Some Gym", 52.5, 13.4)).rejects.toThrow(
      "GOOGLE_API_KEY is not configured",
    );
  });

  it("returns the place_id on a successful match", async () => {
    const mod = await loadModule("test-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ status: "OK", candidates: [{ place_id: "abc123" }] }));
    vi.stubGlobal("fetch", fetchMock);

    const placeId = await mod.findPlaceId("Some Gym", 52.5, 13.4);
    expect(placeId).toBe("abc123");

    const calledUrl = new URL(fetchMock.mock.calls[0]?.[0] as string | URL);
    expect(calledUrl.pathname).toContain("findplacefromtext");
    expect(calledUrl.searchParams.get("input")).toBe("Some Gym");
    expect(calledUrl.searchParams.get("locationbias")).toBe("circle:200@52.5,13.4");
  });

  it("returns null on ZERO_RESULTS (a normal, expected outcome)", async () => {
    const mod = await loadModule("test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "ZERO_RESULTS" })));

    const placeId = await mod.findPlaceId("Unknown Business", 0, 0);
    expect(placeId).toBeNull();
  });

  it("throws GoogleQuotaError on OVER_QUERY_LIMIT", async () => {
    const mod = await loadModule("test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "OVER_QUERY_LIMIT" })));

    await expect(mod.findPlaceId("Some Gym", 52.5, 13.4)).rejects.toBeInstanceOf(
      mod.GoogleQuotaError,
    );
  });

  it("throws GoogleQuotaError on REQUEST_DENIED", async () => {
    const mod = await loadModule("test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "REQUEST_DENIED" })));

    await expect(mod.findPlaceId("Some Gym", 52.5, 13.4)).rejects.toBeInstanceOf(
      mod.GoogleQuotaError,
    );
  });

  it("throws a plain Error on an unexpected non-OK status", async () => {
    const mod = await loadModule("test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "INVALID_REQUEST" })));

    await expect(mod.findPlaceId("Some Gym", 52.5, 13.4)).rejects.toThrow(
      "Google Find Place returned status INVALID_REQUEST",
    );
  });

  it("throws when the HTTP call itself fails", async () => {
    const mod = await loadModule("test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, false)));

    await expect(mod.findPlaceId("Some Gym", 52.5, 13.4)).rejects.toThrow(
      "Google Find Place request failed: 500",
    );
  });
});

describe("getPlaceDetails", () => {
  it("maps rating/review fields and builds up to 5 photo URLs", async () => {
    const mod = await loadModule("test-key");
    const photos = Array.from({ length: 8 }, (_, i) => ({ photo_reference: `ref-${i}` }));
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          status: "OK",
          result: {
            rating: 4.5,
            user_ratings_total: 120,
            url: "https://maps.google.com/?cid=1",
            photos,
          },
        }),
      ),
    );

    const details = await mod.getPlaceDetails("abc123");
    expect(details.rating).toBe(4.5);
    expect(details.reviewCount).toBe(120);
    expect(details.reviewUrl).toBe("https://maps.google.com/?cid=1");
    expect(details.photoUrls).toHaveLength(5);
    expect(details.photoUrls[0]).toContain("ref-0");
    expect(details.photoUrls[0]).toContain("key=test-key");
  });

  it("returns nulls and no photos when result fields are absent", async () => {
    const mod = await loadModule("test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "OK", result: {} })));

    const details = await mod.getPlaceDetails("abc123");
    expect(details.rating).toBeNull();
    expect(details.reviewCount).toBeNull();
    expect(details.reviewUrl).toBeNull();
    expect(details.photoUrls).toEqual([]);
  });

  it("throws GoogleQuotaError on quota/denied statuses", async () => {
    const mod = await loadModule("test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ status: "OVER_QUERY_LIMIT" })));

    await expect(mod.getPlaceDetails("abc123")).rejects.toBeInstanceOf(mod.GoogleQuotaError);
  });
});
