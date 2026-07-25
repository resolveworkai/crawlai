/** Authored by: Mohit Singh */
//
// Pure unit test — services/authService.ts is mocked (always rejects, as if the credentials
// are wrong) so this proves the rate limiter itself kicks in after enough attempts, without a
// live Postgres or real password hashing.
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

const login = vi.fn();
vi.mock("../services/authService.js", () => ({
  login: (...args: unknown[]) => login(...args),
  getAuthenticatedUser: vi.fn(),
  refreshAccessToken: vi.fn(),
}));

const { createApp } = await import("../app.js");
const app = createApp();

describe("POST /auth/login rate limiting", () => {
  it("allows the configured number of attempts, then 429s", async () => {
    login.mockRejectedValue(new Error("invalid credentials"));

    let lastStatus = 0;
    for (let i = 0; i < 11; i += 1) {
      const res = await request(app)
        .post("/auth/login")
        .send({ email: "attacker@example.com", password: "wrong" });
      lastStatus = res.status;
    }

    expect(lastStatus).toBe(429);
  });
});
