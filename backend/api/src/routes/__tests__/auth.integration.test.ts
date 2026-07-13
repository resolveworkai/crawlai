/** Authored by: Mohit Singh */
//
// Real-Postgres integration test for the auth flow. Requires DATABASE_URL to point at a live,
// migrated Postgres. Run with: npm run test:integration.
import { randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../app.js";
import { pool } from "../../db/pool.js";
import { hashPassword } from "../../auth/password.js";
import { createUser } from "../../db/users.js";

const app = createApp();
const email = `auth-test-${randomUUID().slice(0, 8)}@example.com`;
const password = "correct-horse-battery-staple";
let userId: string;

beforeAll(async () => {
  const user = await createUser({ email, passwordHash: await hashPassword(password) });
  userId = user.id;
});

afterAll(async () => {
  await pool.query("DELETE FROM users WHERE id = $1", [userId]);
  await pool.end();
});

describe("POST /auth/login", () => {
  it("rejects an unknown email", async () => {
    const res = await request(app).post("/auth/login").send({ email: "nobody@example.com", password });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong password", async () => {
    const res = await request(app).post("/auth/login").send({ email, password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("rejects a malformed body (validation)", async () => {
    const res = await request(app).post("/auth/login").send({ email: "not-an-email" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("logs in with correct credentials and sets httpOnly cookies", async () => {
    const res = await request(app).post("/auth/login").send({ email, password });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    const cookies = res.headers["set-cookie"] as unknown as string[];
    expect(cookies.some((c) => c.startsWith("access_token=") && c.includes("HttpOnly"))).toBe(true);
    expect(cookies.some((c) => c.startsWith("refresh_token=") && c.includes("HttpOnly"))).toBe(true);
  });
});

describe("GET /auth/me", () => {
  it("rejects when unauthenticated (no cookie)", async () => {
    const res = await request(app).get("/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns the user when authenticated", async () => {
    const agent = request.agent(app);
    await agent.post("/auth/login").send({ email, password });

    const res = await agent.get("/auth/me");
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe(email);
    expect(res.body.user.roles).toEqual([]);
  });
});

describe("POST /auth/refresh + logout", () => {
  it("issues a new access token from a valid refresh cookie", async () => {
    const agent = request.agent(app);
    await agent.post("/auth/login").send({ email, password });

    const refreshRes = await agent.post("/auth/refresh");
    expect(refreshRes.status).toBe(204);

    const meRes = await agent.get("/auth/me");
    expect(meRes.status).toBe(200);
  });

  it("clears cookies on logout, and /auth/me then rejects", async () => {
    const agent = request.agent(app);
    await agent.post("/auth/login").send({ email, password });

    const logoutRes = await agent.post("/auth/logout");
    expect(logoutRes.status).toBe(204);

    const meRes = await agent.get("/auth/me");
    expect(meRes.status).toBe(401);
  });
});
