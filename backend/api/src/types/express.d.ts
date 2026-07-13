/** Authored by: Mohit Singh */
import type { AppRole } from "./db.js";

declare global {
  namespace Express {
    interface Request {
      // Attached by middleware/auth.ts's requireAuth — every downstream handler reads
      // req.user instead of re-verifying the JWT itself.
      user?: {
        id: string;
        email: string;
        roles: AppRole[];
      };
      // Attached by middleware/validate.ts for source:"query" — Express 5's req.query has
      // no setter, so validated/coerced query data lands here instead. See validate.ts.
      validatedQuery?: Record<string, unknown>;
    }
  }
}

export {};
