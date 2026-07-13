/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type { User } from "../types/db.js";

export async function findUserByEmail(email: string): Promise<User | null> {
  const { rows } = await pool.query<User>("SELECT * FROM users WHERE email = $1", [email]);
  return rows[0] ?? null;
}

export async function findUserById(id: string): Promise<User | null> {
  const { rows } = await pool.query<User>("SELECT * FROM users WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function createUser(input: {
  email: string;
  passwordHash: string;
  fullName?: string | null;
}): Promise<User> {
  const { rows } = await pool.query<User>(
    `INSERT INTO users (email, password_hash, full_name)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.email, input.passwordHash, input.fullName ?? null],
  );
  const user = rows[0];
  if (!user) throw new Error("createUser: insert returned no row");
  return user;
}
