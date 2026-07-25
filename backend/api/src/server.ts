/** Authored by: Mohit Singh */
import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./db/pool.js";
import { cleanupExpiredExports } from "./services/exportService.js";

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, "backend-api listening");
});

// Phase 7 export retention — no external scheduler/cron dependency needed for a single-box
// deploy; runs once at boot (catches anything that expired while the process was down) and
// then on a fixed interval. Best-effort: a failed sweep just tries again next tick.
const EXPORT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function runExportCleanup(): void {
  cleanupExpiredExports()
    .then((deletedCount) => {
      if (deletedCount > 0) logger.info({ deletedCount }, "expired exports cleaned up");
    })
    .catch((err: unknown) => {
      logger.error({ err }, "export cleanup sweep failed");
    });
}

runExportCleanup();
const exportCleanupTimer = setInterval(runExportCleanup, EXPORT_CLEANUP_INTERVAL_MS);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  clearInterval(exportCleanupTimer);
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
