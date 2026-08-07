/** Authored by: Mohit Singh */
import { z } from "zod";

// Product Research (Ecom-Crawl) module. All three platforms are creatable. noon + aliexpress are
// REQUIRES_CDP (Akamai-blocked to automated launch) — they run only via the host runner attached
// to the operator's real Chrome (backend/worker/run_noon_host.py), not the container daemon; the
// UI still queues them normally. amazon runs headless in the container.
export const createEcomJobSchema = z.object({
  platform: z.enum(["noon", "amazon", "aliexpress"]),
  query: z.string().min(1).max(200),
  sortMode: z
    .enum(["rating_desc", "price_asc", "price_desc", "relevance"])
    .default("rating_desc"),
  maxPages: z.coerce.number().int().min(1).max(10).default(3),
  maxProducts: z.coerce.number().int().positive().default(90),
  // Phase 2b: optional detail-page deep scrape. 0 (default) = disabled — see the migration's
  // comment on ecom_jobs.detail_scrape_top_n.
  detailScrapeTopN: z.coerce.number().int().min(0).max(10).default(0),
  // Absent => worker applies its own defaults (ecom/analysis.py DEFAULT_WEIGHTS). Partial so a
  // caller may override just one weight.
  scoreWeights: z
    .object({
      reviews: z.number().min(0).max(1),
      rating: z.number().min(0).max(1),
      demand: z.number().min(0).max(1),
      value: z.number().min(0).max(1),
    })
    .partial()
    .optional(),
});

export type CreateEcomJobInput = z.infer<typeof createEcomJobSchema>;

export const ecomJobIdParamsSchema = z.object({ id: z.string().uuid() });

// json is NEW here — the OCR export schema deliberately does not gain it (see schemas/ocrCrawl.ts).
export const ecomExportQuerySchema = z.object({
  format: z.enum(["csv", "xlsx", "json"]).default("csv"),
});
