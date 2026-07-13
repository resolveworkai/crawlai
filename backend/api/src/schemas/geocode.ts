/** Authored by: Mohit Singh */
import { z } from "zod";

export const geocodeQuerySchema = z.object({
  q: z.string().min(1).max(300),
});
