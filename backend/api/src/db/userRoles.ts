/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type { AppRole, UserRole } from "../types/db.js";

export async function listRolesForUser(userId: string): Promise<AppRole[]> {
  const { rows } = await pool.query<Pick<UserRole, "role">>(
    "SELECT role FROM user_roles WHERE user_id = $1",
    [userId],
  );
  return rows.map((r) => r.role);
}

export async function assignRole(userId: string, role: AppRole): Promise<UserRole> {
  const { rows } = await pool.query<UserRole>(
    `INSERT INTO user_roles (user_id, role)
     VALUES ($1, $2)
     ON CONFLICT (user_id, role) DO UPDATE SET role = EXCLUDED.role
     RETURNING *`,
    [userId, role],
  );
  const row = rows[0];
  if (!row) throw new Error("assignRole: insert returned no row");
  return row;
}
