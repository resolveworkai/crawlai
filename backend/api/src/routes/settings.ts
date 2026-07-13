/** Authored by: Mohit Singh */
import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { updateSettingsSchema, type UpdateSettingsInput } from "../schemas/settings.js";
import { getCrawlSettings, updateCrawlSettings } from "../db/crawlSettings.js";

export const settingsRouter = Router();

// requireAuth applied per-route, not via router.use() — see jobs.ts for why a path-unscoped
// router.use(requireAuth) is a real bug (turns unrelated 404s into 401s).

settingsRouter.get("/settings", requireAuth, async (_req, res) => {
  const settings = await getCrawlSettings();
  res.json({ settings });
});

settingsRouter.patch(
  "/settings",
  requireAuth,
  requireRole("admin"),
  validate(updateSettingsSchema),
  async (req, res) => {
    const settings = await updateCrawlSettings(req.body as UpdateSettingsInput);
    res.json({ settings });
  },
);
