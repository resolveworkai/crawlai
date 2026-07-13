/** Authored by: Mohit Singh */
import { z } from "zod";

// Accepts EITHER a place name to geocode (Discover screen's location box / the header's
// quick-launch modal) OR direct coordinates (Discover's click-to-pin) — the route resolves
// whichever was given to lat/lng before inserting the job, so the worker always gets
// coordinates. See .claude/skills/skills_backend_node.md.
export const createJobSchema = z
  .object({
    businessType: z.string().min(1).max(100),
    radiusKm: z.coerce.number().positive().max(500),
    location: z.string().min(1).optional(),
    centerLat: z.coerce.number().min(-90).max(90).optional(),
    centerLng: z.coerce.number().min(-180).max(180).optional(),
  })
  .refine((v) => v.location !== undefined || (v.centerLat !== undefined && v.centerLng !== undefined), {
    message: "Provide either `location` or both `centerLat` and `centerLng`",
  });

export type CreateJobInput = z.infer<typeof createJobSchema>;

export const jobIdParamsSchema = z.object({ id: z.string().uuid() });

export const listJobsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(50),
});
