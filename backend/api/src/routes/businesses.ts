/** Authored by: Mohit Singh */
import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { businessIdParamsSchema, listBusinessesQuerySchema } from "../schemas/businesses.js";
import { deleteBusiness, findBusinessById, listBusinessesFiltered } from "../db/businesses.js";
import { NotFoundError } from "../errors.js";
import type { BusinessFilters } from "../db/businesses.js";

export const businessesRouter = Router();

// requireAuth applied per-route, not via router.use() — see jobs.ts for why a path-unscoped
// router.use(requireAuth) is a real bug (turns unrelated 404s into 401s).

businessesRouter.get(
  "/businesses",
  requireAuth,
  validate(listBusinessesQuerySchema, "query"),
  async (req, res) => {
    const filters = req.validatedQuery as unknown as BusinessFilters;
    const { businesses, total } = await listBusinessesFiltered(filters);
    res.json({ businesses, total, limit: filters.limit, offset: filters.offset });
  },
);

businessesRouter.get(
  "/businesses/:id",
  requireAuth,
  validate(businessIdParamsSchema, "params"),
  async (req, res) => {
    const business = await findBusinessById(req.params.id as string);
    if (!business) throw new NotFoundError("Business not found");
    res.json({ business });
  },
);

businessesRouter.delete(
  "/businesses/:id",
  requireAuth,
  requireRole("operator"),
  validate(businessIdParamsSchema, "params"),
  async (req, res) => {
    const deleted = await deleteBusiness(req.params.id as string);
    if (!deleted) throw new NotFoundError("Business not found");
    res.status(204).send();
  },
);
