// Authored by: Mohit Singh
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests hit a real Postgres and run under vitest.integration.config.ts instead.
    exclude: ["**/node_modules/**", "src/**/*.integration.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
  },
});
