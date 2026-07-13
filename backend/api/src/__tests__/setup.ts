/** Authored by: Mohit Singh */
// Loaded once before the test suite — sets the minimal env config.ts requires to boot, so
// pure-unit tests (mocked DB) never need a real .env file. Integration tests (src/db/__tests__)
// need this to be a genuinely reachable Postgres — port 5436 matches docker-compose.yml's
// current host mapping (5432-5435 were already taken by other local projects; see
// .claude/skills/skills_devops.md "Host port collisions").
process.env.DATABASE_URL ??= "postgresql://postgres:1234@localhost:5436/master_db_crawler";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
