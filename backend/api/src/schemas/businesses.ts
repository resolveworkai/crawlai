/** Authored by: Mohit Singh */
import { z } from "zod";

export const listBusinessesQuerySchema = z.object({
  category: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  enrichmentStatus: z.enum(["queued", "crawling", "enriched", "failed"]).optional(),
  hasEmail: z.coerce.boolean().optional(),
  search: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const businessIdParamsSchema = z.object({ id: z.string().uuid() });
