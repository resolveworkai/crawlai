/** Authored by: Mohit Singh */
import { Pool } from "pg";
import { config } from "../config.js";

// Schema is owned entirely by db/migrations (node-pg-migrate, run from this package).
// This pool is read/write access to that schema — it never issues DDL. See
// .claude/skills/skills_db.md "Ownership".
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
});

export async function pingDatabase(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}
