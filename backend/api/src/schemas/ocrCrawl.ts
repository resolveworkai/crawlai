/** Authored by: Mohit Singh */
import { z } from "zod";
import { config } from "../config.js";

export const createOcrJobSchema = z.object({
  query: z.string().min(1).max(120),
  location: z.string().min(1).max(200),
  maxResults: z.coerce
    .number()
    .int()
    .positive()
    .max(config.OCR_CRAWL_MAX_RESULTS * 8)
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
