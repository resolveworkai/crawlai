/** Authored by: Mohit Singh */
import { pool } from "./pool.js";
import type { CrawlSettings } from "../types/db.js";

// Global singleton row (id=1) — see db/migrations crawl-settings.sql and
// .claude/skills/skills_db.md. The seed migration guarantees this row always exists.
export async function getCrawlSettings(): Promise<CrawlSettings> {
  const { rows } = await pool.query<CrawlSettings>("SELECT * FROM crawl_settings WHERE id = 1");
  const settings = rows[0];
  if (!settings) throw new Error("getCrawlSettings: singleton row missing — did migrations run?");
  return settings;
}

// Explicit `| undefined` per property (not just Partial<...>'s optional `?`) so this accepts
// zod-inferred `.optional()` input types under tsconfig's exactOptionalPropertyTypes.
type CrawlSettingsPatch = {
  [K in keyof Omit<CrawlSettings, "id" | "updated_at">]?: CrawlSettings[K] | undefined;
};

export async function updateCrawlSettings(patch: CrawlSettingsPatch): Promise<CrawlSettings> {
  const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return getCrawlSettings();

  const setClauses = entries.map(([key], i) => `${key} = $${i + 1}`);
  const values = entries.map(([, v]) => v);

  const { rows } = await pool.query<CrawlSettings>(
    `UPDATE crawl_settings SET ${setClauses.join(", ")} WHERE id = 1 RETURNING *`,
    values,
  );
  const settings = rows[0];
  if (!settings) throw new Error("updateCrawlSettings: singleton row missing");
  return settings;
}
