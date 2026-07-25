/** Authored by: Mohit Singh */
//
// Auth for /api/v1/* — the public surface external consumers (e.g. a future myhub integration)
// use, entirely separate from the frontend's cookie-based JWT session (auth/jwt.ts). Deny-by-
// default: no configured keys means every request is rejected, never silently open. See
// .claude/skills/skills_backend_node.md and md/plans/0001-*.md "Phase 7".
import type { NextFunction, Request, Response } from "express";
import { config } from "../config.js";
import { UnauthorizedError } from "../errors.js";

function configuredApiKeys(): Set<string> {
  return new Set(
    (config.API_KEYS ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key.length > 0),
  );
}

// Accepts either `Authorization: Bearer <key>` or `X-API-Key: <key>` — both are common
// conventions for a static API key and cost nothing extra to support both.
export function requireApiKey(req: Request, _res: Response, next: NextFunction): void {
  const keys = configuredApiKeys();
  if (keys.size === 0) {
    throw new UnauthorizedError("Public API is not configured (no API_KEYS set)");
  }

  const authHeader = req.headers.authorization;
  const bearerKey = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : undefined;
  const headerKeyRaw = req.headers["x-api-key"];
  const headerKey = (Array.isArray(headerKeyRaw) ? headerKeyRaw[0] : headerKeyRaw)?.trim();
  const providedKey = bearerKey || headerKey;

  if (!providedKey || !keys.has(providedKey)) {
    throw new UnauthorizedError("Invalid or missing API key");
  }
  next();
}
