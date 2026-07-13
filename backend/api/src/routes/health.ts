/** Authored by: Mohit Singh */
import { Router } from "express";
import { pingDatabase } from "../db/pool.js";
import { ServiceUnavailableError } from "../errors.js";

export const healthRouter = Router();

healthRouter.get("/health", async (_req, res) => {
  const dbHealthy = await pingDatabase();
  if (!dbHealthy) {
    throw new ServiceUnavailableError("Database unreachable");
  }
  res.json({ status: "ok", service: "business-scout-ai-backend-api" });
});
