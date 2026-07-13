/** Authored by: Mohit Singh */
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-level: mock the DB ping so this suite never needs a live Postgres connection.
// The real end-to-end health check (against a real, dedicated Postgres) is verified via
// `docker compose up` + a live curl, not this suite — see md/plans/0001-*.md Phase 0 DoD.
vi.mock("../db/pool.js", () => ({
  pool: { end: vi.fn().mockResolvedValue(undefined) },
  pingDatabase: vi.fn(),
}));

describe("GET /health", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("returns 200 when the database is reachable", async () => {
    const db = await import("../db/pool.js");
    vi.mocked(db.pingDatabase).mockResolvedValue(true);
    const { createApp } = await import("../app.js");

    const res = await request(createApp()).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "business-scout-ai-backend-api" });
  });

  it("returns 503 when the database is unreachable", async () => {
    const db = await import("../db/pool.js");
    vi.mocked(db.pingDatabase).mockResolvedValue(false);
    const { createApp } = await import("../app.js");

    const res = await request(createApp()).get("/health");

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("SERVICE_UNAVAILABLE");
  });

  it("returns a structured 404 for unknown routes", async () => {
    const db = await import("../db/pool.js");
    vi.mocked(db.pingDatabase).mockResolvedValue(true);
    const { createApp } = await import("../app.js");

    const res = await request(createApp()).get("/does-not-exist");

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});
