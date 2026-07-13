/** Authored by: Mohit Singh */
import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  createDynamicFieldSchema,
  dynamicFieldIdParamsSchema,
  updateDynamicFieldSchema,
  type CreateDynamicFieldInput,
  type UpdateDynamicFieldInput,
} from "../schemas/dynamicFields.js";
import {
  createDynamicField,
  deleteDynamicField,
  listDynamicFields,
  updateDynamicField,
} from "../db/dynamicFields.js";
import { ConflictError, NotFoundError } from "../errors.js";

export const dynamicFieldsRouter = Router();

// requireAuth applied per-route, not via router.use() — see jobs.ts for why a path-unscoped
// router.use(requireAuth) is a real bug (turns unrelated 404s into 401s).

dynamicFieldsRouter.get("/dynamic-fields", requireAuth, async (_req, res) => {
  const fields = await listDynamicFields();
  res.json({ fields });
});

dynamicFieldsRouter.post(
  "/dynamic-fields",
  requireAuth,
  requireRole("operator"),
  validate(createDynamicFieldSchema),
  async (req, res) => {
    try {
      const body = req.body as CreateDynamicFieldInput;
      const field = await createDynamicField({ ...body, createdBy: req.user!.id });
      res.status(201).json({ field });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(`A dynamic field with key "${(req.body as { key: string }).key}" already exists`);
      }
      throw err;
    }
  },
);

dynamicFieldsRouter.patch(
  "/dynamic-fields/:id",
  requireAuth,
  requireRole("operator"),
  validate(dynamicFieldIdParamsSchema, "params"),
  validate(updateDynamicFieldSchema),
  async (req, res) => {
    const field = await updateDynamicField(req.params.id as string, req.body as UpdateDynamicFieldInput);
    if (!field) throw new NotFoundError("Dynamic field not found");
    res.json({ field });
  },
);

dynamicFieldsRouter.delete(
  "/dynamic-fields/:id",
  requireAuth,
  requireRole("operator"),
  validate(dynamicFieldIdParamsSchema, "params"),
  async (req, res) => {
    const deleted = await deleteDynamicField(req.params.id as string);
    if (!deleted) throw new NotFoundError("Dynamic field not found");
    res.status(204).send();
  },
);

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "23505";
}
