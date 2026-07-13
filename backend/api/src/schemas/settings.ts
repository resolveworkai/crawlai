/** Authored by: Mohit Singh */
import { z } from "zod";

export const updateSettingsSchema = z
  .object({
    concurrency: z.coerce.number().int().min(1).max(32).optional(),
    retry_count: z.coerce.number().int().min(0).max(10).optional(),
    timeout_ms: z.coerce.number().int().min(1000).max(120_000).optional(),
    user_agent: z.string().min(1).max(200).optional(),
    max_businesses_per_job: z.coerce.number().int().min(1).max(10_000).optional(),
    crawl_website: z.boolean().optional(),
    respect_robots_txt: z.boolean().optional(),
    follow_sitemaps: z.boolean().optional(),
    request_delay_ms: z.coerce.number().int().min(0).max(60_000).optional(),
    use_ai_extraction: z.boolean().optional(),
    proxy_url: z.string().url().nullable().optional(),
  })
  .strict();

export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
