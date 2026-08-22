/** Authored by: Mohit Singh */
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { geocodeQuerySchema, geocodeSuggestQuerySchema } from "../schemas/geocode.js";
import { geocode, geocodeSuggestions } from "../lib/geocode.js";

export const geocodeRouter = Router();

// Nominatim proxy for the Discover screen's location box / the header's quick-launch modal —
// the frontend never calls Nominatim directly (keeps the descriptive User-Agent + usage-policy
// throttling in one place). See .claude/skills/skills_backend_node.md.
geocodeRouter.get(
  "/geocode",
  requireAuth,
  validate(geocodeQuerySchema, "query"),
  async (req, res) => {
    const { q } = req.validatedQuery as unknown as { q: string };
    const result = await geocode(q);
    res.json({ result });
  },
);

// Multi-result variant for as-you-type location autocomplete — same Nominatim proxy as /geocode
// above, just returns up to `limit` candidates instead of collapsing to the single best match.
// Used by the Property Research location field (routes/property-crawl.tsx).
geocodeRouter.get(
  "/geocode/suggest",
  requireAuth,
  validate(geocodeSuggestQuerySchema, "query"),
  async (req, res) => {
    const { q, limit } = req.validatedQuery as unknown as { q: string; limit: number };
    const results = await geocodeSuggestions(q, limit);
    res.json({ results });
  },
);
