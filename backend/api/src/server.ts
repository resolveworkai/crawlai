/** Authored by: Mohit Singh */
import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./db/pool.js";
import { cleanupExpiredExports } from "./services/exportService.js";
import { purgeExpiredOcrCaptures } from "./lib/ocrRetention.js";

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, "backend-api listening");
});

// Node's http server defaults keepAliveTimeout to 5s — any client that reuses a connection
// (every browser, and curl within a session) can race the server closing that socket right as a
// new request goes out on it, producing an intermittent ECONNRESET/"recv failure" with no
// application-level error logged (the request never reaches Express). Docker Desktop's
// Windows/WSL2 network translation adds enough extra latency to make this race hit often in
// practice. headersTimeout must stay greater than keepAliveTimeout (Node enforces this).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

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

// Crawl-OCR capture retention (§2) — same boot + daily-interval pattern as exports above.
const OCR_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function runOcrCleanup(): void {
  purgeExpiredOcrCaptures().catch((err: unknown) => {
    logger.error({ err }, "ocr-crawl capture purge failed");
  });
}

runOcrCleanup();
const ocrCleanupTimer = setInterval(runOcrCleanup, OCR_CLEANUP_INTERVAL_MS);

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  clearInterval(exportCleanupTimer);
  clearInterval(ocrCleanupTimer);
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
