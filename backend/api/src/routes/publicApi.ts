/** Authored by: Mohit Singh */
//
// Phase 7 — the public, versioned /api/v1 surface for external consumers (e.g. a future myhub
// integration), separate from the frontend's own (session-authed) /businesses route in
// routes/businesses.ts. Same underlying query (listBusinessesFiltered) but api-key-gated and
// returns the export module's nested JSON shape (Extract-friendly for a machine consumer, not
// the flat spreadsheet columns).
import { Router } from "express";
import { requireApiKey } from "../middleware/apiKeyAuth.js";
import { publicApiRateLimit } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import { listBusinessesQuerySchema } from "../schemas/businesses.js";
import { listBusinessesFiltered, type BusinessFilters } from "../db/businesses.js";
import { toNestedJson } from "../lib/businessExport.js";
import { openapiSpec } from "../lib/openapiSpec.js";

export const publicApiRouter = Router();

// Unauthenticated — a prospective consumer needs to see the contract before they have a key.
publicApiRouter.get("/api/v1/openapi.json", (_req, res) => {
  res.json(openapiSpec);
});

publicApiRouter.get(
  "/api/v1/businesses",
  publicApiRateLimit,
  requireApiKey,
  validate(listBusinessesQuerySchema, "query"),
  async (req, res) => {
    const filters = req.validatedQuery as unknown as BusinessFilters;
    const { businesses, total } = await listBusinessesFiltered(filters);
    res.json({
      data: businesses.map(toNestedJson),
      pagination: { total, limit: filters.limit, offset: filters.offset },
    });
  },
);
