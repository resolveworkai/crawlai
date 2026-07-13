/** Authored by: Mohit Singh */
import type { NextFunction, Request, Response } from "express";
import type { ZodType } from "zod";
import { ValidationError } from "../errors.js";

type Source = "body" | "params" | "query";

// Every external input is validated at the route boundary before it reaches a controller —
// see .claude/skills/skills_backend_node.md "Conventions". Reject with 400, never let bad
// input propagate into a service/db call.
//
// Express 5 made req.query a getter-only property (no setter) — reassigning it throws
// "Cannot set property query ... which has only a getter". body/params remain writable.
// Validated/coerced query data is exposed via req.validatedQuery instead; route handlers
// read from there when they need zod's defaults/coercions applied.
export function validate(schema: ZodType, source: Source = "body") {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const message = result.error.issues
        .map((issue) => `${issue.path.join(".") || source}: ${issue.message}`)
        .join("; ");
      throw new ValidationError(message);
    }
    if (source === "query") {
      req.validatedQuery = result.data as Record<string, unknown>;
    } else {
      req[source] = result.data;
    }
    next();
  };
}
