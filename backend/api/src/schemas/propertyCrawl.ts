/** Authored by: Mohit Singh */
import { z } from "zod";

// Property Research (Property-Crawl) module. Both platforms REQUIRE_CDP (confirmed 2026-08-22:
// dubizzle returns an empty-body 200, propertyfinder a bare 403 under plain headless Chromium) —
// they only ever run via the host runner attached to the operator's real Chrome
// (backend/worker/run_property_host.py), which polls for new 'queued' jobs (no pg_notify channel
// exists for this module — see propertyJobs.ts's createPropertyJob comment). The UI still queues
// them normally; the worker picks a new job up within its poll interval.
export const createPropertyJobSchema = z.object({
  platform: z.enum(["dubizzle", "propertyfinder"]),
  location: z.string().trim().min(1).max(200),
  // Absent = any bedroom count. 0 = studio (also settable via propertyType: "studio", which
  // forces bedrooms to 0 server-side in the adapter regardless of what's passed here).
  bedrooms: z.coerce.number().int().min(0).max(10).optional(),
  bathrooms: z.coerce.number().int().min(0).max(10).optional(),
  propertyType: z
    .enum(["apartment", "villa", "townhouse", "penthouse", "studio"])
    .default("apartment"),
  purpose: z.enum(["buy", "rent"]).default("buy"),
  // No confirmed server-side URL param for either platform — enforced client-side at capture time
  // against each listing's own is_offplan flag. Defaults to "ready" (confirmed preference).
  propertyStatus: z.enum(["ready", "offplan", "any"]).default("ready"),
  maxPages: z.coerce.number().int().min(1).max(20).default(3),
  maxListings: z.coerce.number().int().positive().max(500).default(100),
  // How many of the top-ranked (by distress_score) listings get a detail-page visit to reveal a
  // phone number + build a WhatsApp link. 0 disables the detail stage entirely.
  detailScrapeTopN: z.coerce.number().int().min(0).max(20).default(10),
  // Optional custom WhatsApp message — may reference {title}/{price}/{community}/{url}
  // placeholders (see property/whatsapp.py DEFAULT_MESSAGE_TEMPLATE for the default). Absent =>
  // worker's own default template.
  whatsappMessageTemplate: z.string().trim().min(1).max(1000).optional(),
  // Absent => worker applies its own defaults (property/analysis.py DEFAULT_WEIGHTS). Partial so
  // a caller may override just one weight.
  scoreWeights: z
    .object({
      value: z.number().min(0).max(1),
      keywords: z.number().min(0).max(1),
      freshness: z.number().min(0).max(1),
      verified: z.number().min(0).max(1),
    })
    .partial()
    .optional(),
});

export type CreatePropertyJobInput = z.infer<typeof createPropertyJobSchema>;

export const propertyJobIdParamsSchema = z.object({ id: z.string().uuid() });

export const propertyExportQuerySchema = z.object({
  format: z.enum(["csv", "xlsx", "json"]).default("csv"),
});

// --- Wishlist (save-for-later) ---------------------------------------------------------------

export const addToWishlistSchema = z.object({
  listingId: z.string().uuid(),
});

export type AddToWishlistInput = z.infer<typeof addToWishlistSchema>;

export const wishlistItemIdParamsSchema = z.object({ id: z.string().uuid() });

// --- Per-listing refresh -----------------------------------------------------------------------

export const listingRefreshStatusParamsSchema = z.object({
  id: z.string().uuid(),
  refreshId: z.string().uuid(),
});

// --- Recurring search (schedule) -----------------------------------------------------------------
// Same criteria fields as createPropertyJobSchema, extended with a recurrence interval — reuses
// that schema (.extend) rather than duplicating every field's own validation.

export const createPropertyJobScheduleSchema = createPropertyJobSchema.extend({
  // 6h floor — this is a recurring background job, not a one-off; anything tighter risks
  // overlapping the previous run's own capture time for a large search. 30 days ceiling — beyond
  // that, just relaunch manually; a schedule this infrequent isn't really "recurring" in practice.
  intervalHours: z.coerce.number().int().min(6).max(720),
});

export type CreatePropertyJobScheduleInput = z.infer<typeof createPropertyJobScheduleSchema>;

export const propertyJobScheduleIdParamsSchema = z.object({ id: z.string().uuid() });

export const setPropertyJobScheduleEnabledSchema = z.object({ enabled: z.boolean() });
