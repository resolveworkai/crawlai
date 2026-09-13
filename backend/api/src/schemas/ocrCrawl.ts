/** Authored by: Mohit Singh */
import { z } from "zod";
import { config } from "../config.js";

// 1000 is the absolute type-level ceiling (matches crawl_settings.ocr_max_results' CHECK
// constraint) — the operator-configured limit (defaults to 1000, adjustable down via the
// Settings screen) is enforced at request time in routes/ocrCrawl.ts via getCrawlSettings(),
// since a static zod schema can't read the DB.
export const createOcrJobSchema = z
  .object({
    query: z.string().min(1).max(120),
    location: z.string().min(1).max(200),
    maxResults: z.coerce
      .number()
      .int()
      .positive()
      .max(1000)
      .default(config.OCR_CRAWL_MAX_RESULTS),
    expandHours: z.boolean().default(false),
    langs: z
      .string()
      .regex(
        /^[a-z]{3}(\+[a-z]{3})*$/,
        "langs must be 3-letter codes joined by '+' (e.g. eng, eng+ara)",
      )
      .default("eng"),
    // Optional center point + radius: when given, the worker enforces radiusKm as a hard
    // haversine filter on each business's OWN href-derived coordinates (see capture.py) — not
    // just a Maps-viewport bias. Both centerLat and centerLng must be provided together; radiusKm
    // is meaningless without a center. 300km ceiling matches capture.py's MAX_GRID_CELLS safety —
    // above ~2km the search auto-tiles into a grid, and MAX_GRID_CELLS auto-widens each cell as
    // radiusKm grows so job duration stays bounded even at this ceiling (trading some per-cell
    // exhaustiveness for a predictable runtime on very large areas).
    centerLat: z.coerce.number().min(-90).max(90).optional(),
    centerLng: z.coerce.number().min(-180).max(180).optional(),
    radiusKm: z.coerce.number().positive().max(300).optional(),
  })
  .refine((v) => (v.centerLat === undefined) === (v.centerLng === undefined), {
    message: "centerLat and centerLng must be provided together",
    path: ["centerLat"],
  })
  .refine(
    (v) => v.radiusKm === undefined || (v.centerLat !== undefined && v.centerLng !== undefined),
    { message: "radiusKm requires centerLat and centerLng", path: ["radiusKm"] },
  );

export type CreateOcrJobInput = z.infer<typeof createOcrJobSchema>;

export const ocrJobIdParamsSchema = z.object({ id: z.string().uuid() });

export const ocrJobBusinessParamsSchema = z.object({
  id: z.string().uuid(),
  businessId: z.string().uuid(),
});

export const ocrExportQuerySchema = z.object({ format: z.enum(["csv", "xlsx"]).default("csv") });
