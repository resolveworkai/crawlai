/** Authored by: Mohit Singh */
//
// Real-Postgres integration tests for businesses, dynamic-fields, settings, and stats.
// Requires DATABASE_URL to point at a live, migrated Postgres. Run with: npm run test:integration.
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { pool } from "../../db/pool.js";
import { hashPassword } from "../../auth/password.js";
import { createUser } from "../../db/users.js";
import { assignRole } from "../../db/userRoles.js";

const app = createApp();
const runId = randomUUID().slice(0, 8);
const password = "correct-horse-battery-staple";
const cleanupUserIds: string[] = [];
const cleanupBusinessIds: string[] = [];

let operatorAgent: ReturnType<typeof request.agent>;
let adminAgent: ReturnType<typeof request.agent>;
let viewerAgent: ReturnType<typeof request.agent>;

beforeAll(async () => {
  const operator = await createUser({
    email: `res-operator-${runId}@example.com`,
    passwordHash: await hashPassword(password),
  });
  await assignRole(operator.id, "operator");
  cleanupUserIds.push(operator.id);

  const admin = await createUser({
    email: `res-admin-${runId}@example.com`,
    passwordHash: await hashPassword(password),
  });
  await assignRole(admin.id, "admin");
  cleanupUserIds.push(admin.id);

  const viewer = await createUser({
    email: `res-viewer-${runId}@example.com`,
    passwordHash: await hashPassword(password),
  });
  await assignRole(viewer.id, "viewer");
  cleanupUserIds.push(viewer.id);

  operatorAgent = request.agent(app);
  await operatorAgent.post("/auth/login").send({ email: operator.email, password });
  adminAgent = request.agent(app);
  await adminAgent.post("/auth/login").send({ email: admin.email, password });
  viewerAgent = request.agent(app);
  await viewerAgent.post("/auth/login").send({ email: viewer.email, password });

  // Seed a couple of real businesses to exercise list/filter/get/delete against.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO businesses (name, category, city, email, enrichment_status, osm_type, osm_id)
     VALUES
       ($1, 'gym', 'Berlin', $2, 'enriched', 'node', $3),
       ($4, 'gym', 'Munich', NULL, 'queued', 'node', $5)
     RETURNING id`,
    [
      `Res Test Gym A ${runId}`,
      `res-test-a-${runId}@example.com`,
      `${runId}-res-a`,
      `Res Test Gym B ${runId}`,
      `${runId}-res-b`,
    ],
  );
  cleanupBusinessIds.push(...rows.map((r) => r.id));
});

afterAll(async () => {
  await pool.query("DELETE FROM businesses WHERE id = ANY($1)", [cleanupBusinessIds]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [cleanupUserIds]);
  await pool.end();
});

describe("GET /businesses", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/businesses");
    expect(res.status).toBe(401);
  });

  it("lists and filters by city (any authenticated role)", async () => {
    const res = await viewerAgent.get("/businesses").query({ city: "Berlin", limit: 50 });
    expect(res.status).toBe(200);
    expect(res.body.businesses.some((b: { city: string }) => b.city === "Berlin")).toBe(true);
    expect(res.body.businesses.every((b: { city: string }) => b.city === "Berlin")).toBe(true);
  });

  it("filters by hasEmail", async () => {
    const res = await viewerAgent.get("/businesses").query({ hasEmail: "true", search: `Res Test Gym` });
    expect(res.status).toBe(200);
    expect(res.body.businesses.every((b: { email: string | null }) => b.email !== null)).toBe(true);
  });

  it("gets a single business by id, 404s for unknown id", async () => {
    const id = cleanupBusinessIds[0];
    const res = await viewerAgent.get(`/businesses/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.business.id).toBe(id);

    const missing = await viewerAgent.get(`/businesses/${randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  it("rejects a viewer deleting a business (403), allows operator", async () => {
    const [{ rows }] = [
      await pool.query<{ id: string }>(
        "INSERT INTO businesses (name, osm_type, osm_id) VALUES ($1, 'node', $2) RETURNING id",
        [`Res Delete Test ${runId}`, `${runId}-res-del`],
      ),
    ];
    const id = rows[0]!.id;

    const denied = await viewerAgent.delete(`/businesses/${id}`);
    expect(denied.status).toBe(403);

    const allowed = await operatorAgent.delete(`/businesses/${id}`);
    expect(allowed.status).toBe(204);
  });
});

describe("dynamic-fields CRUD", () => {
  const key = `res_test_field_${runId}`;

  it("rejects a viewer creating a field (403)", async () => {
    const res = await viewerAgent
      .post("/dynamic-fields")
      .send({ key, label: "Test", prompt: "Does this business do X?" });
    expect(res.status).toBe(403);
  });

  it("creates, lists, updates, and deletes a field", async () => {
    const createRes = await operatorAgent
      .post("/dynamic-fields")
      .send({ key, label: "Test Field", prompt: "Does this business do X?" });
    expect(createRes.status).toBe(201);
    const id = createRes.body.field.id as string;

    const listRes = await viewerAgent.get("/dynamic-fields");
    expect(listRes.status).toBe(200);
    expect(listRes.body.fields.some((f: { key: string }) => f.key === key)).toBe(true);

    const updateRes = await operatorAgent.patch(`/dynamic-fields/${id}`).send({ enabled: false });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.field.enabled).toBe(false);

    const deleteRes = await operatorAgent.delete(`/dynamic-fields/${id}`);
    expect(deleteRes.status).toBe(204);
  });

  it("rejects a duplicate key with 409", async () => {
    const first = await operatorAgent
      .post("/dynamic-fields")
      .send({ key: `${key}_dup`, label: "A", prompt: "A?" });
    expect(first.status).toBe(201);

    const second = await operatorAgent
      .post("/dynamic-fields")
      .send({ key: `${key}_dup`, label: "B", prompt: "B?" });
    expect(second.status).toBe(409);

    await operatorAgent.delete(`/dynamic-fields/${first.body.field.id}`);
  });
});

describe("settings", () => {
  it("any authenticated role can read settings", async () => {
    const res = await viewerAgent.get("/settings");
    expect(res.status).toBe(200);
    expect(res.body.settings.id).toBe(1);
  });

  it("rejects an operator updating settings (admin-only), allows admin", async () => {
    const denied = await operatorAgent.patch("/settings").send({ concurrency: 5 });
    expect(denied.status).toBe(403);

    const original = await adminAgent.get("/settings");
    const originalConcurrency = original.body.settings.concurrency as number;

    const allowed = await adminAgent.patch("/settings").send({ concurrency: 7 });
    expect(allowed.status).toBe(200);
    expect(allowed.body.settings.concurrency).toBe(7);

    await adminAgent.patch("/settings").send({ concurrency: originalConcurrency });
  });
});

describe("GET /stats/overview", () => {
  it("returns aggregate stats, a 7-day trend, and top-N lists", async () => {
    const res = await viewerAgent.get("/stats/overview");
    expect(res.status).toBe(200);
    expect(res.body.stats.totalBusinesses).toBeGreaterThanOrEqual(cleanupBusinessIds.length);
    expect(res.body.trend).toHaveLength(7);
    expect(Array.isArray(res.body.recentJobs)).toBe(true);
    expect(Array.isArray(res.body.recentlyEnriched)).toBe(true);
  });
});

describe("GET /geocode", () => {
  // Single live Nominatim call — respects usage policy.
  it(
    "resolves a place name to coordinates",
    async () => {
      const res = await viewerAgent.get("/geocode").query({ q: "Paris, France" });
      expect(res.status).toBe(200);
      expect(res.body.result.lat).toBeGreaterThan(48);
      expect(res.body.result.lat).toBeLessThan(49);
    },
    15_000,
  );
});
