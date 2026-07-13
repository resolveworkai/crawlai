/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type { ExportFormat, ExportRecord } from "../types/db.js";

export async function createExportRecord(input: {
  createdBy?: string | null;
  format: ExportFormat;
  filename: string;
  rowCount: number;
  sizeBytes: number;
  filterSnapshot?: Record<string, unknown>;
  storagePath: string;
  expiresAt?: Date | null;
}): Promise<ExportRecord> {
  const { rows } = await pool.query<ExportRecord>(
    `INSERT INTO exports (created_by, format, filename, row_count, size_bytes, filter_snapshot, storage_path, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      input.createdBy ?? null,
      input.format,
      input.filename,
      input.rowCount,
      input.sizeBytes,
      JSON.stringify(input.filterSnapshot ?? {}),
      input.storagePath,
      input.expiresAt ?? null,
    ],
  );
  const record = rows[0];
  if (!record) throw new Error("createExportRecord: insert returned no row");
  return record;
}

export async function listExports(limit = 50): Promise<ExportRecord[]> {
  const { rows } = await pool.query<ExportRecord>(
    "SELECT * FROM exports ORDER BY created_at DESC LIMIT $1",
    [limit],
  );
  return rows;
}

export async function findExportById(id: string): Promise<ExportRecord | null> {
  const { rows } = await pool.query<ExportRecord>("SELECT * FROM exports WHERE id = $1", [id]);
  return rows[0] ?? null;
}

// Backs the Phase 7 retention-cleanup job.
export async function deleteExpiredExports(): Promise<ExportRecord[]> {
  const { rows } = await pool.query<ExportRecord>(
    "DELETE FROM exports WHERE expires_at IS NOT NULL AND expires_at < now() RETURNING *",
  );
  return rows;
}
