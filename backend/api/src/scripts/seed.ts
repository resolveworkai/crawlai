/** Authored by: Mohit Singh */
//
// Idempotent local-dev seed: one admin user + a couple of sample dynamic_fields.
// crawl_settings' singleton row already seeds itself via its migration — nothing to do here.
// Run with: npm run seed (backend/api), against a real DATABASE_URL.
import bcrypt from "bcrypt";
import { pool } from "../db/pool.js";
import { createUser, findUserByEmail } from "../db/users.js";
import { assignRole } from "../db/userRoles.js";
import { createDynamicField, listDynamicFields } from "../db/dynamicFields.js";
import { logger } from "../logger.js";

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? "admin@business-scout.local";
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD ?? "change-me-dev-only";
const BCRYPT_ROUNDS = 10;

async function seedAdminAccount(email: string, password: string, fullName: string): Promise<void> {
  const existing = await findUserByEmail(email);
  if (existing) {
    logger.info({ email }, "seed: admin user already exists, skipping create");
    await assignRole(existing.id, "admin");
    return;
  }
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await createUser({ email, passwordHash, fullName });
  await assignRole(user.id, "admin");
  logger.info({ email }, "seed: created admin user");
}

async function seedAdminUser(): Promise<void> {
  await seedAdminAccount(ADMIN_EMAIL, ADMIN_PASSWORD, "Admin");
  if (!process.env.SEED_ADMIN_PASSWORD) {
    logger.warn(
      "seed: using the default dev-only admin password — set SEED_ADMIN_PASSWORD for anything beyond local dev",
    );
  }

  // Second, fixed-credential dev admin (requested directly, not env-configurable) — local/dev
  // only, guarded on NODE_ENV so a mistaken `npm run seed` against a real deployment can never
  // create an account with a known, hardcoded password.
  if (process.env.NODE_ENV !== "production") {
    await seedAdminAccount("admin@admin.com", "Test@123", "Admin");
  }
}

async function seedDynamicFields(): Promise<void> {
  const existing = await listDynamicFields();
  const existingKeys = new Set(existing.map((f) => f.key));

  const samples = [
    {
      key: "accepts_walk_ins",
      label: "Accepts Walk-Ins",
      prompt: "Does this business accept walk-in customers without an appointment?",
      fieldType: "boolean" as const,
    },
    {
      key: "years_in_business",
      label: "Years in Business",
      prompt:
        "How many years has this business been operating? Return an integer, or null if unknown.",
      fieldType: "number" as const,
    },
  ];

  for (const sample of samples) {
    if (existingKeys.has(sample.key)) {
      logger.info({ key: sample.key }, "seed: dynamic field already exists, skipping");
      continue;
    }
    await createDynamicField(sample);
    logger.info({ key: sample.key }, "seed: created dynamic field");
  }
}

async function main(): Promise<void> {
  await seedAdminUser();
  await seedDynamicFields();
  logger.info("seed: complete");
}

main()
  .catch((err: unknown) => {
    logger.error({ err }, "seed: failed");
    process.exitCode = 1;
  })
  .finally(() => {
    void pool.end();
  });
