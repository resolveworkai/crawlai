/** Authored by: Mohit Singh */
//
// Pure unit tests — config.ts's API_KEYS is toggled per test via vi.resetModules (module-level
// singleton, same pattern as lib/googlePlaces.test.ts).
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";

const ORIGINAL_API_KEYS = process.env.API_KEYS;

async function loadModule(apiKeys: string | undefined) {
  vi.resetModules();
  if (apiKeys === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = apiKeys;
  return import("./apiKeyAuth.js");
}

function req(headers: Record<string, string | string[]>): Request {
  return { headers } as unknown as Request;
}

afterEach(() => {
  if (ORIGINAL_API_KEYS === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = ORIGINAL_API_KEYS;
  vi.resetModules();
});

describe("requireApiKey", () => {
  it("rejects every request when no API_KEYS are configured", async () => {
    const mod = await loadModule(undefined);
    const next = vi.fn();
    // Not `.toThrow(UnauthorizedError)` — vi.resetModules() gives errors.js a fresh module
    // instance per loadModule() call, so a statically-imported UnauthorizedError class here
    // would fail `instanceof` against the dynamically-imported one apiKeyAuth.js actually
    // throws, despite it being "the same" error type.
    expect(() => mod.requireApiKey(req({}), {} as Response, next)).toThrow(
      "Public API is not configured",
    );
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a request with no key header", async () => {
    const mod = await loadModule("key-a,key-b");
    const next = vi.fn();
    expect(() => mod.requireApiKey(req({}), {} as Response, next)).toThrow(
      "Invalid or missing API key",
    );
  });

  it("rejects an unrecognized key", async () => {
    const mod = await loadModule("key-a,key-b");
    const next = vi.fn();
    expect(() =>
      mod.requireApiKey(req({ "x-api-key": "wrong-key" }), {} as Response, next),
    ).toThrow("Invalid or missing API key");
  });

  it("accepts a valid key via X-API-Key header", async () => {
    const mod = await loadModule("key-a,key-b");
    const next = vi.fn();
    mod.requireApiKey(req({ "x-api-key": "key-b" }), {} as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("accepts a valid key via Authorization: Bearer", async () => {
    const mod = await loadModule("key-a,key-b");
    const next = vi.fn();
    mod.requireApiKey(req({ authorization: "Bearer key-a" }), {} as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("trims whitespace around configured keys", async () => {
    const mod = await loadModule(" key-a , key-b ");
    const next = vi.fn();
    mod.requireApiKey(req({ "x-api-key": "key-a" }), {} as Response, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("ignores an Authorization header that isn't a Bearer token", async () => {
    const mod = await loadModule("key-a");
    const next = vi.fn();
    expect(() =>
      mod.requireApiKey(req({ authorization: "Basic dXNlcjpwYXNz" }), {} as Response, next),
    ).toThrow("Invalid or missing API key");
  });
});
