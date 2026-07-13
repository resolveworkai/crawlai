// Authored by: Mohit Singh
//
// Separate from vitest.config.ts's mocked unit suite — these tests hit a REAL Postgres
// (DATABASE_URL must point at one; no setup-file placeholder override). See
// .claude/skills/skills_db.md and md/plans/0001-*.md's testing pyramid "Integration" tier.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    setupFiles: ["src/db/__tests__/integration-setup.ts"],
  },
});
