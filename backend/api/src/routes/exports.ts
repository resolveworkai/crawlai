/** Authored by: Mohit Singh */
import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  createExportSchema,
  exportIdParamsSchema,
  type CreateExportInput,
} from "../schemas/exports.js";
import { listExports } from "../db/exports.js";
import { generateExport, getExportForDownload } from "../services/exportService.js";

export const exportsRouter = Router();

// requireAuth applied per-route, not via router.use() — see jobs.ts for why a path-unscoped
// router.use(requireAuth) is a real bug (turns unrelated 404s into 401s).

exportsRouter.get("/exports", requireAuth, async (_req, res) => {
  const records = await listExports();
  res.json({ exports: records });
});

exportsRouter.post(
  "/exports",
  requireAuth,
  requireRole("operator"),
  validate(createExportSchema),
  async (req, res) => {
    const { format, ...rawFilters } = req.body as CreateExportInput;
    // zod's .optional() keeps the key present with an explicit `undefined` value, which
    // `exactOptionalPropertyTypes` treats as distinct from "the key is absent" — strip those so
    // the filters object (and the persisted filter_snapshot) only carries keys the caller
    // actually set.
    const filters = Object.fromEntries(
      Object.entries(rawFilters).filter(([, value]) => value !== undefined),
    );
    const record = await generateExport({ format, filters, createdBy: req.user?.id ?? null });
    res.status(201).json({ export: record });
  },
);

exportsRouter.get(
  "/exports/:id/download",
  requireAuth,
  validate(exportIdParamsSchema, "params"),
  async (req, res) => {
    const record = await getExportForDownload(req.params.id as string);
    res.download(record.storage_path, record.filename, (err) => {
      // res.download's error callback fires after headers may already be in flight (e.g. the
      // file existed when getExportForDownload ran but was deleted/moved a moment later) — this
      // is a stream-callback error, not a thrown one, so the errorHandler middleware never sees it.
      if (err && !res.headersSent) {
        res.status(404).json({ error: { code: "NOT_FOUND", message: "Export file not found" } });
      }
    });
  },
);
