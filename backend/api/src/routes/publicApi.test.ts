/** Authored by: Mohit Singh */
//
// Pure unit tests — db/businesses.ts is mocked, driven through the real Express app (supertest)
// so this proves the actual route wiring (middleware order, api-key gate, validation, response
// shape), not just the underlying functions in isolation. No live Postgres involved.
process.env.API_KEYS = "test-public-key";

import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Business } from "../types/db.js";

const listBusinessesFiltered = vi.fn();
vi.mock("../db/businesses.js", () => ({
  listBusinessesFiltered: (...args: unknown[]) => listBusinessesFiltered(...args),
}));

const { createApp } = await import("../app.js");
const app = createApp();

function business(overrides: Partial<Business> = {}): Business {
  return {
    id: "biz-1",
    name: "Test Gym",
    sub_name: null,
    address_line1: null,
    address_line2: null,
    area: null,
    city: "Berlin",
    state: null,
    country: "Germany",
    postal_code: null,
    latitude: 52.5,
    longitude: 13.4,
    email: null,
    emails: [],
    phone: null,
    phones: [],
    whatsapp: null,
    website_url: null,
    about_text: null,
    google_rating: null,
    review_count: null,
    review_url: null,
    opening_hours: null,
    enrichment_status: "enriched",
    extras: {},
    created_at: new Date("2026-01-01T00:00:00Z"),
    updated_at: new Date("2026-01-02T00:00:00Z"),
    ...overrides,
  } as Business;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/v1/businesses", () => {
  it("rejects a request with no API key", async () => {
    const res = await request(app).get("/api/v1/businesses");
    expect(res.status).toBe(401);
    expect(listBusinessesFiltered).not.toHaveBeenCalled();
  });

  it("rejects an invalid API key", async () => {
    const res = await request(app).get("/api/v1/businesses").set("X-API-Key", "wrong-key");
    expect(res.status).toBe(401);
  });

  it("returns paginated, nested-JSON businesses for a valid X-API-Key", async () => {
    listBusinessesFiltered.mockResolvedValue({ businesses: [business()], total: 1 });

    const res = await request(app).get("/api/v1/businesses").set("X-API-Key", "test-public-key");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe("Test Gym");
    expect(res.body.data[0].address).toBeDefined(); // nested shape, not the flat export columns
    expect(res.body.pagination).toEqual({ total: 1, limit: 50, offset: 0 });
  });

  it("also accepts Authorization: Bearer <key>", async () => {
    listBusinessesFiltered.mockResolvedValue({ businesses: [], total: 0 });

    const res = await request(app)
      .get("/api/v1/businesses")
      .set("Authorization", "Bearer test-public-key");

    expect(res.status).toBe(200);
  });

  it("validates and applies query filters (rejects a bad enrichmentStatus with 400)", async () => {
    const res = await request(app)
      .get("/api/v1/businesses?enrichmentStatus=bogus")
      .set("X-API-Key", "test-public-key");

    expect(res.status).toBe(400);
    expect(listBusinessesFiltered).not.toHaveBeenCalled();
  });

  it("passes valid filters through to the query layer", async () => {
    listBusinessesFiltered.mockResolvedValue({ businesses: [], total: 0 });

    await request(app)
      .get("/api/v1/businesses?city=Berlin&limit=10")
      .set("X-API-Key", "test-public-key");

    expect(listBusinessesFiltered).toHaveBeenCalledWith(
      expect.objectContaining({ city: "Berlin", limit: 10, offset: 0 }),
    );
  });
});

describe("GET /api/v1/openapi.json", () => {
  it("is served without authentication", async () => {
    const res = await request(app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.info.title).toContain("business-scout-ai");
    expect(res.body.paths["/businesses"]).toBeDefined();
  });
});
