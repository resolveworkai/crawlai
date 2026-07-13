/** Authored by: Mohit Singh */
// Silences request logging for integration test runs by default — override by setting
// LOG_LEVEL before the run (e.g. `LOG_LEVEL=error npm run test:integration`) to debug a
// failure. DATABASE_URL is deliberately left untouched here (unlike src/__tests__/setup.ts's
// unit-test setup) since integration tests need the real, live Postgres from the environment.
process.env.LOG_LEVEL ??= "silent";
