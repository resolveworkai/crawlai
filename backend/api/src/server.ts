/** Authored by: Mohit Singh */
import { createApp } from "./app.js";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { pool } from "./db/pool.js";

const app = createApp();

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT, env: config.NODE_ENV }, "backend-api listening");
});

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
