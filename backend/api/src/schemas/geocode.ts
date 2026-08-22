/** Authored by: Mohit Singh */
import { z } from "zod";

export const geocodeQuerySchema = z.object({
  q: z.string().min(1).max(300),
});

export const geocodeSuggestQuerySchema = z.object({
  q: z.string().min(1).max(300),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});
