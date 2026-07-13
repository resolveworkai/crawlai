/** Authored by: Mohit Singh */
//
// Real-Postgres integration test for the jobs endpoints, including the deny-by-default authz
// (a viewer-only user gets 403 on mutating routes). Requires DATABASE_URL to point at a live,
// migrated Postgres. Run with: npm run test:integration.
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

let operatorAgent: ReturnType<typeof request.agent>;
let viewerAgent: ReturnType<typeof request.agent>;

beforeAll(async () => {
  const operator = await createUser({
    email: `jobs-operator-${runId}@example.com`,
    passwordHash: await hashPassword(password),
  });
  await assignRole(operator.id, "operator");
  cleanupUserIds.push(operator.id);

  const viewer = await createUser({
    email: `jobs-viewer-${runId}@example.com`,
    passwordHash: await hashPassword(password),
  });
  await assignRole(viewer.id, "viewer");
  cleanupUserIds.push(viewer.id);

  operatorAgent = request.agent(app);
  await operatorAgent.post("/auth/login").send({ email: operator.email, password });

  viewerAgent = request.agent(app);
  await viewerAgent.post("/auth/login").send({ email: viewer.email, password });
});

afterAll(async () => {
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [cleanupUserIds]);
  await pool.end();
});

describe("POST /jobs", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await request(app).post("/jobs").send({ businessType: "gym", radiusKm: 5 });
    expect(res.status).toBe(401);
  });

  it("rejects a viewer (403 — deny-by-default authz)", async () => {
    const res = await viewerAgent
      .post("/jobs")
      .send({ businessType: "gym", radiusKm: 5, centerLat: 25.2048, centerLng: 55.2708 });
    expect(res.status).toBe(403);
  });

  it("rejects a body with neither location nor coordinates (validation)", async () => {
    const res = await operatorAgent.post("/jobs").send({ businessType: "gym", radiusKm: 5 });
    expect(res.status).toBe(400);
  });

  it("creates a job from direct coordinates as a pending job", async () => {
    const res = await operatorAgent
      .post("/jobs")
      .send({ businessType: "gym", radiusKm: 5, centerLat: 25.2048, centerLng: 55.2708 });
    expect(res.status).toBe(201);
    expect(res.body.job.status).toBe("pending");
    expect(res.body.job.center_lat).toBeCloseTo(25.2048, 3);

    await pool.query("DELETE FROM crawl_jobs WHERE id = $1", [res.body.job.id]);
  });

  // Single live geocode call — respects Nominatim's usage policy (one request, not a loop).
  it("creates a job from a location string via Nominatim geocoding", async () => {
    const res = await operatorAgent
      .post("/jobs")
      .send({ businessType: "library", radiusKm: 3, location: "Berlin, Germany" });
    expect(res.status).toBe(201);
    expect(res.body.job.center_lat).toBeGreaterThan(52);
    expect(res.body.job.center_lat).toBeLessThan(53);

    await pool.query("DELETE FROM crawl_jobs WHERE id = $1", [res.body.job.id]);
  }, 15_000);
});

describe("job lifecycle: pause/resume/cancel/retry/delete", () => {
  it("walks a job through pause -> resume -> cancel, then delete", async () => {
    const createRes = await operatorAgent
      .post("/jobs")
      .send({ businessType: "gym", radiusKm: 5, centerLat: 1, centerLng: 1 });
    const jobId = createRes.body.job.id as string;

    // pause/resume only apply to active jobs (pending/discovering/crawling) — the job is
    // 'pending' right after creation, so pause is valid here.
    const pauseRes = await operatorAgent.post(`/jobs/${jobId}/pause`);
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.job.pause_requested).toBe(true);

    await pool.query("UPDATE crawl_jobs SET status = 'paused' WHERE id = $1", [jobId]);

    const resumeRes = await operatorAgent.post(`/jobs/${jobId}/resume`);
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.job.pause_requested).toBe(false);

    const cancelRes = await operatorAgent.post(`/jobs/${jobId}/cancel`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.job.cancel_requested).toBe(true);

    const deleteRes = await operatorAgent.delete(`/jobs/${jobId}`);
    expect(deleteRes.status).toBe(204);

    const getRes = await operatorAgent.get(`/jobs/${jobId}`);
    expect(getRes.status).toBe(404);
  });

  it("retries a terminal (failed) job back to pending with counters reset", async () => {
    const createRes = await operatorAgent
      .post("/jobs")
      .send({ businessType: "gym", radiusKm: 5, centerLat: 1, centerLng: 1 });
    const jobId = createRes.body.job.id as string;

    await pool.query(
      "UPDATE crawl_jobs SET status = 'failed', found_count = 10, error_message = 'boom' WHERE id = $1",
      [jobId],
    );

    const retryRes = await operatorAgent.post(`/jobs/${jobId}/retry`);
    expect(retryRes.status).toBe(200);
    expect(retryRes.body.job.status).toBe("pending");
    expect(retryRes.body.job.found_count).toBe(0);
    expect(retryRes.body.job.error_message).toBeNull();

    await pool.query("DELETE FROM crawl_jobs WHERE id = $1", [jobId]);
  });

  it("rejects retry on a non-terminal job", async () => {
    const createRes = await operatorAgent
      .post("/jobs")
      .send({ businessType: "gym", radiusKm: 5, centerLat: 1, centerLng: 1 });
    const jobId = createRes.body.job.id as string;

    const retryRes = await operatorAgent.post(`/jobs/${jobId}/retry`);
    expect(retryRes.status).toBe(404);

    await pool.query("DELETE FROM crawl_jobs WHERE id = $1", [jobId]);
  });
});

describe("GET /jobs and GET /jobs/:id", () => {
  it("lists jobs and fetches one by id (any authenticated role, including viewer)", async () => {
    const createRes = await operatorAgent
      .post("/jobs")
      .send({ businessType: "coaching", radiusKm: 2, centerLat: 1, centerLng: 1 });
    const jobId = createRes.body.job.id as string;

    const listRes = await viewerAgent.get("/jobs");
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.jobs)).toBe(true);

    const getRes = await viewerAgent.get(`/jobs/${jobId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.job.id).toBe(jobId);

    await pool.query("DELETE FROM crawl_jobs WHERE id = $1", [jobId]);
  });

  it("404s for a well-formed but nonexistent id", async () => {
    const res = await operatorAgent.get(`/jobs/${randomUUID()}`);
    expect(res.status).toBe(404);
  });
});
