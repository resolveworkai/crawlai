/** Authored by: Mohit Singh */
import { z } from "zod";
import { config } from "../config.js";

// 1000 is the absolute type-level ceiling (matches crawl_settings.ocr_max_results' CHECK
// constraint) — the operator-configured limit (defaults to 1000, adjustable down via the
// Settings screen) is enforced at request time in routes/ocrCrawl.ts via getCrawlSettings(),
// since a static zod schema can't read the DB.
export const createOcrJobSchema = z.object({
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
});

export type CreateOcrJobInput = z.infer<typeof createOcrJobSchema>;

export const ocrJobIdParamsSchema = z.object({ id: z.string().uuid() });

export const ocrExportQuerySchema = z.object({ format: z.enum(["csv", "xlsx"]).default("csv") });
