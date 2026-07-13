/** Authored by: Mohit Singh */
import type { NextFunction, Request, Response } from "express";
import { ACCESS_COOKIE } from "../auth/cookies.js";
import { verifyAccessToken } from "../auth/jwt.js";
import { ForbiddenError, UnauthorizedError } from "../errors.js";
import type { AppRole } from "../types/db.js";

// Deny-by-default: every route is unauthenticated/unauthorized unless explicitly guarded with
// requireAuth (and requireRole where a specific role floor applies). See
// .claude/skills/skills_security.md "Auth".
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token: unknown = req.cookies?.[ACCESS_COOKIE];
  if (typeof token !== "string" || token.length === 0) {
    throw new UnauthorizedError("Not authenticated");
  }
  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email, roles: payload.roles };
    next();
  } catch {
    throw new UnauthorizedError("Invalid or expired session");
  }
}

// This is a single shared team workspace, not a multi-tenant app (see users_and_roles
// migration): role governs WHAT actions a user may take, never WHICH rows they can see.
const ROLE_RANK: Record<AppRole, number> = { viewer: 0, operator: 1, admin: 2 };

export function requireRole(minRole: AppRole) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) throw new UnauthorizedError("Not authenticated");
    const hasSufficientRole = req.user.roles.some((r) => ROLE_RANK[r] >= ROLE_RANK[minRole]);
    if (!hasSufficientRole) {
      throw new ForbiddenError(`Requires ${minRole} role or higher`);
    }
    next();
  };
}
