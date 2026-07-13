/** Authored by: Mohit Singh */
import { describe, expect, it } from "vitest";
import { config } from "./config.js";

describe("config", () => {
  it("loads with sane defaults from the test environment", () => {
    expect(config.NODE_ENV).toBe("test");
    expect(config.PORT).toBeGreaterThan(0);
    expect(config.DATABASE_URL).toMatch(/^postgresql:\/\//);
  });
});
