/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type { DynamicField, DynamicFieldType } from "../types/db.js";

export async function listDynamicFields(): Promise<DynamicField[]> {
  const { rows } = await pool.query<DynamicField>(
    "SELECT * FROM dynamic_fields ORDER BY created_at ASC",
  );
  return rows;
}

export async function listEnabledDynamicFields(): Promise<DynamicField[]> {
  const { rows } = await pool.query<DynamicField>(
    "SELECT * FROM dynamic_fields WHERE enabled = true ORDER BY created_at ASC",
  );
  return rows;
}

export async function createDynamicField(input: {
  createdBy?: string | null;
  key: string;
  label: string;
  prompt: string;
  fieldType?: DynamicFieldType;
}): Promise<DynamicField> {
  const { rows } = await pool.query<DynamicField>(
    `INSERT INTO dynamic_fields (created_by, key, label, prompt, field_type)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [input.createdBy ?? null, input.key, input.label, input.prompt, input.fieldType ?? "text"],
  );
  const field = rows[0];
  if (!field) throw new Error("createDynamicField: insert returned no row");
  return field;
}

export async function setDynamicFieldEnabled(id: string, enabled: boolean): Promise<DynamicField | null> {
  const { rows } = await pool.query<DynamicField>(
    "UPDATE dynamic_fields SET enabled = $2 WHERE id = $1 RETURNING *",
    [id, enabled],
  );
  return rows[0] ?? null;
}

export async function updateDynamicField(
  id: string,
  patch: { enabled?: boolean | undefined; label?: string | undefined; prompt?: string | undefined },
): Promise<DynamicField | null> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) {
    const { rows } = await pool.query<DynamicField>("SELECT * FROM dynamic_fields WHERE id = $1", [id]);
    return rows[0] ?? null;
  }
  const setClauses = entries.map(([key], i) => `${key} = $${i + 2}`);
  const values = entries.map(([, v]) => v);
  const { rows } = await pool.query<DynamicField>(
    `UPDATE dynamic_fields SET ${setClauses.join(", ")} WHERE id = $1 RETURNING *`,
    [id, ...values],
  );
  return rows[0] ?? null;
}

export async function deleteDynamicField(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM dynamic_fields WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}
