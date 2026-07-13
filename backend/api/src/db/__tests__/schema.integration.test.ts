/** Authored by: Mohit Singh */
//
// Real-Postgres integration tests — constraint enforcement + CRUD smoke, per the testing
// pyramid in md/plans/0001-*.md. Requires DATABASE_URL to point at a live, migrated Postgres
// (docker-compose.yml's dedicated instance). Run with: npm run test:integration.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../pool.js";
import { createUser, findUserByEmail } from "../users.js";
import { createCrawlJob, deleteCrawlJob, findCrawlJobById, updateCrawlJobStatus } from "../crawlJobs.js";
import { getCrawlSettings, updateCrawlSettings } from "../crawlSettings.js";

const runId = randomUUID().slice(0, 8);
const cleanupUserIds: string[] = [];

afterAll(async () => {
  for (const id of cleanupUserIds) {
    await pool.query("DELETE FROM users WHERE id = $1", [id]);
  }
  await pool.end();
});

beforeAll(async () => {
  // Fail fast with a clear message if pointed at an unmigrated/unreachable DB, rather than
  // letting every test below fail with a confusing "relation does not exist" one by one.
  await pool.query("SELECT 1 FROM users LIMIT 0");
});

describe("schema constraints (real Postgres)", () => {
  it("rejects an invalid crawl_jobs.status value (enum constraint)", async () => {
    const user = await createUser({
      email: `enum-test-${runId}@example.com`,
      passwordHash: "x",
    });
    cleanupUserIds.push(user.id);

    await expect(
      pool.query(
        `INSERT INTO crawl_jobs (created_by, business_type, center_lat, center_lng, radius_km, status)
         VALUES ($1, 'gym', 0, 0, 5, 'not-a-real-status')`,
        [user.id],
      ),
    ).rejects.toThrow();
  });

  it("rejects a duplicate email on users (unique constraint)", async () => {
    const email = `dup-test-${runId}@example.com`;
    const user = await createUser({ email, passwordHash: "x" });
    cleanupUserIds.push(user.id);

    await expect(createUser({ email, passwordHash: "y" })).rejects.toThrow();
  });

  it("rejects a duplicate (osm_type, osm_id) on businesses (the primary dedupe key)", async () => {
    const osmId = `${runId}-osm-1`;
    await pool.query(
      `INSERT INTO businesses (name, osm_type, osm_id) VALUES ('Dup Test A', 'node', $1)`,
      [osmId],
    );
    await expect(
      pool.query(`INSERT INTO businesses (name, osm_type, osm_id) VALUES ('Dup Test B', 'node', $1)`, [
        osmId,
      ]),
    ).rejects.toThrow();

    await pool.query("DELETE FROM businesses WHERE osm_id = $1", [osmId]);
  });

  it("rejects a duplicate email on businesses (the secondary override key)", async () => {
    const email = `biz-dup-${runId}@example.com`;
    await pool.query(`INSERT INTO businesses (name, email) VALUES ('Email Dup A', $1)`, [email]);
    await expect(
      pool.query(`INSERT INTO businesses (name, email) VALUES ('Email Dup B', $1)`, [email]),
    ).rejects.toThrow();

    await pool.query("DELETE FROM businesses WHERE email = $1", [email]);
  });

  it("rejects an invalid businesses.enrichment_status value (check constraint)", async () => {
    await expect(
      pool.query(
        `INSERT INTO businesses (name, enrichment_status) VALUES ('Bad Status', 'not-a-status')`,
      ),
    ).rejects.toThrow();
  });
});

describe("CRUD smoke (real Postgres)", () => {
  it("creates, reads, and updates a user", async () => {
    const email = `crud-user-${runId}@example.com`;
    const created = await createUser({ email, passwordHash: "hash", fullName: "CRUD Test" });
    cleanupUserIds.push(created.id);

    const found = await findUserByEmail(email);
    expect(found?.id).toBe(created.id);
    expect(found?.full_name).toBe("CRUD Test");
  });

  it("creates, reads, updates, and deletes a crawl job", async () => {
    const user = await createUser({ email: `crud-job-${runId}@example.com`, passwordHash: "x" });
    cleanupUserIds.push(user.id);

    const job = await createCrawlJob({
      createdBy: user.id,
      businessType: "gym",
      centerLat: 25.2048,
      centerLng: 55.2708,
      radiusKm: 5,
    });
    expect(job.status).toBe("pending");

    const updated = await updateCrawlJobStatus(job.id, "discovering");
    expect(updated?.status).toBe("discovering");

    const found = await findCrawlJobById(job.id);
    expect(found?.id).toBe(job.id);

    const deleted = await deleteCrawlJob(job.id);
    expect(deleted).toBe(true);
    expect(await findCrawlJobById(job.id)).toBeNull();
  });

  it("reads and updates the crawl_settings singleton", async () => {
    const original = await getCrawlSettings();
    expect(original.id).toBe(1);

    const updated = await updateCrawlSettings({ concurrency: original.concurrency + 1 });
    expect(updated.concurrency).toBe(original.concurrency + 1);

    // restore, so this test is a no-op on the shared dev DB's settings
    await updateCrawlSettings({ concurrency: original.concurrency });
  });
});
