/** Authored by: Mohit Singh */
import { z } from "zod";

export const createExportSchema = z.object({
  format: z.enum(["xlsx", "csv", "json"]),
  // Mirrors listBusinessesQuerySchema's filter fields (no limit/offset — an export always
  // covers every matching row, streamed in batches, see services/exportService.ts).
  category: z.string().min(1).optional(),
  city: z.string().min(1).optional(),
  enrichmentStatus: z.enum(["queued", "crawling", "enriched", "failed"]).optional(),
  hasEmail: z.coerce.boolean().optional(),
  search: z.string().min(1).max(200).optional(),
});

export type CreateExportInput = z.infer<typeof createExportSchema>;

export const exportIdParamsSchema = z.object({ id: z.string().uuid() });
