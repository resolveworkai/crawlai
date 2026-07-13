/** Authored by: Mohit Singh */
import { z } from "zod";

export const createDynamicFieldSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z][a-z0-9_]*$/, "key must be lowercase snake_case"),
  label: z.string().min(1).max(200),
  prompt: z.string().min(1).max(2000),
  fieldType: z.enum(["text", "number", "boolean", "list", "url"]).default("text"),
});

export const updateDynamicFieldSchema = z.object({
  enabled: z.boolean().optional(),
  label: z.string().min(1).max(200).optional(),
  prompt: z.string().min(1).max(2000).optional(),
});

export const dynamicFieldIdParamsSchema = z.object({ id: z.string().uuid() });

export type CreateDynamicFieldInput = z.infer<typeof createDynamicFieldSchema>;
export type UpdateDynamicFieldInput = z.infer<typeof updateDynamicFieldSchema>;
