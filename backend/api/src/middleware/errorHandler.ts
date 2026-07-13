/** Authored by: Mohit Singh */
import type { NextFunction, Request, Response } from "express";
import { AppError } from "../errors.js";
import { logger } from "../logger.js";

// Registered last in app.ts — the single place that formats error responses.
// Express 5 auto-forwards rejected promises from async handlers to this middleware,
// so route handlers do not need manual try/catch wrapping for that path.
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction, // required 4-arg Express error-middleware signature
): void {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error({ err, path: req.path }, err.message);
    }
    res.status(err.statusCode).json({ error: { code: err.code, message: err.message } });
    return;
  }

  const message = err instanceof Error ? err.message : "Unknown error";
  logger.error({ err, path: req.path }, message);
  res.status(500).json({ error: { code: "INTERNAL_SERVER_ERROR", message: "An unexpected error occurred" } });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: "NOT_FOUND", message: `No route for ${req.method} ${req.path}` } });
}
