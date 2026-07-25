/** Authored by: Mohit Singh */
//
// Crawl-OCR retention (§2). Captured PNGs are the heavy artifacts — they're purged after a
// window; the DB rows + each job's results.json survive so old jobs stay viewable/exportable.
// Runs at server boot AND on a daily interval (server.ts), so a long-running process purges
// without a restart. Deletes each job folder's `raw/` directory once its mtime is older than
// the window; a job folder with no `raw/` left is harmless (thumbnails just 404).
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";

export async function purgeExpiredOcrCaptures(): Promise<number> {
  const root = config.OCR_CAPTURES_DIR;
  const cutoffMs = Date.now() - config.OCR_CRAWL_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  let jobDirs: string[];
  try {
    jobDirs = await readdir(root);
  } catch {
    return 0; // captures dir doesn't exist yet (no job has run) — nothing to purge
  }

  let purged = 0;
  for (const jobDir of jobDirs) {
    if (jobDir.startsWith(".")) continue; // skip the persistent-profile dir (.profile)
    const rawDir = path.join(root, jobDir, "raw");
    try {
      const info = await stat(rawDir);
      if (info.mtimeMs < cutoffMs) {
        await rm(rawDir, { recursive: true, force: true });
        purged += 1;
      }
    } catch {
      // no raw/ dir (already purged, or job never captured) — skip
    }
  }
  if (purged > 0) {
    logger.info(
      { purged, retentionDays: config.OCR_CRAWL_RETENTION_DAYS },
      "ocr-crawl: purged captures",
    );
  }
  return purged;
}
