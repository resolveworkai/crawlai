/** Authored by: Mohit Singh */
//
// Real-Postgres integration test for POST /ocr-crawl/jobs/:id/retry — the resumable-retry cap
// and state-guard logic. Requires DATABASE_URL to point at a live, migrated Postgres. Run with:
// npm run test:integration.
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
const cleanupJobIds: string[] = [];

let operatorAgent: ReturnType<typeof request.agent>;
let viewerAgent: ReturnType<typeof request.agent>;
let operatorId: string;

async function insertJob(status: "failed" | "blocked" | "queued", retryCount = 0): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ocr_jobs (created_by, query, location, status, retry_count, captured_count)
     VALUES ($1, 'gym', 'Dubai', $2, $3, 4)
     RETURNING id`,
    [operatorId, status, retryCount],
  );
  const id = rows[0]!.id;
  cleanupJobIds.push(id);
  return id;
}

beforeAll(async () => {
  const operator = await createUser({
    email: `ocr-retry-operator-${runId}@example.com`,
    passwordHash: await hashPassword(password),
  });
  await assignRole(operator.id, "operator");
  cleanupUserIds.push(operator.id);
  operatorId = operator.id;

  const viewer = await createUser({
    email: `ocr-retry-viewer-${runId}@example.com`,
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
  await pool.query("DELETE FROM ocr_jobs WHERE id = ANY($1)", [cleanupJobIds]);
  await pool.query("DELETE FROM users WHERE id = ANY($1)", [cleanupUserIds]);
  await pool.end();
});

describe("POST /ocr-crawl/jobs/:id/retry", () => {
  it("rejects an unauthenticated request", async () => {
    const id = await insertJob("failed");
    const res = await request(app).post(`/ocr-crawl/jobs/${id}/retry`);
    expect(res.status).toBe(401);
  });

  it("rejects a viewer (403 — deny-by-default authz)", async () => {
    const id = await insertJob("failed");
    const res = await viewerAgent.post(`/ocr-crawl/jobs/${id}/retry`);
    expect(res.status).toBe(403);
  });

  it("404s on an unknown job id", async () => {
    const res = await operatorAgent.post(
      `/ocr-crawl/jobs/${randomUUID()}/retry`,
    );
    expect(res.status).toBe(404);
  });

  it("rejects retrying a job that isn't failed/blocked", async () => {
    const id = await insertJob("queued");
    const res = await operatorAgent.post(`/ocr-crawl/jobs/${id}/retry`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("failed or blocked");
  });

  it("resumes a failed job: flips to queued, clears error, increments retry_count", async () => {
    const id = await insertJob("failed");
    await pool.query("UPDATE ocr_jobs SET error_message = 'boom' WHERE id = $1", [id]);

    const res = await operatorAgent.post(`/ocr-crawl/jobs/${id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe("queued");
    expect(res.body.job.retry_count).toBe(1);
    expect(res.body.job.error_message).toBeNull();
    // Real progress (captured_count) is preserved, not reset — that's what makes the worker's
    // resume-from-manifest actually meaningful instead of a disguised restart.
    expect(res.body.job.captured_count).toBe(4);
  });

  it("resumes a blocked job the same way as failed", async () => {
    const id = await insertJob("blocked");
    const res = await operatorAgent.post(`/ocr-crawl/jobs/${id}/retry`);
    expect(res.status).toBe(200);
    expect(res.body.job.status).toBe("queued");
  });

  it("rejects once the retry cap (3) is reached, keeping the job's data intact", async () => {
    const id = await insertJob("failed", 3);
    const res = await operatorAgent.post(`/ocr-crawl/jobs/${id}/retry`);
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain("Max retries");
    // Confirm the guard didn't silently mutate the row despite rejecting the request.
    const { rows } = await pool.query<{ status: string; retry_count: number }>(
      "SELECT status, retry_count FROM ocr_jobs WHERE id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ status: "failed", retry_count: 3 });
  });
});
