/** Authored by: Mohit Singh */
import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { config } from "./config.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import { logger } from "./logger.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { jobsRouter } from "./routes/jobs.js";
import { businessesRouter } from "./routes/businesses.js";
import { dynamicFieldsRouter } from "./routes/dynamicFields.js";
import { settingsRouter } from "./routes/settings.js";
import { statsRouter } from "./routes/stats.js";
import { geocodeRouter } from "./routes/geocode.js";

// App assembly only — no listen() here (see server.ts). Keeping the two apart lets tests
// import the app directly (supertest) without binding a real port.
export function createApp(): Express {
  const app = express();

  app.use(helmet());
  // credentials:true + an explicit origin (never "*") — auth cookies require both.
  app.use(cors({ origin: config.FRONTEND_ORIGIN, credentials: true }));
  app.use(express.json());
  app.use(cookieParser());
  app.use(pinoHttp({ logger }));

  app.use(healthRouter);
  app.use(authRouter);
  app.use(jobsRouter);
  app.use(businessesRouter);
  app.use(dynamicFieldsRouter);
  app.use(settingsRouter);
  app.use(statsRouter);
  app.use(geocodeRouter);
  // Future routers (exports — Phase 7; public /api/v1 — Phase 7) mount here later,
  // versioned under /api/v1 where public.

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
