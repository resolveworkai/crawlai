/** Authored by: Mohit Singh */
//
// Phase 6 — manual, on-demand Google enrichment (requirements 5/6/9: rating, review count,
// photos). Deliberately NOT part of the automatic crawl pipeline (see
// business_scout_worker/pipeline.py's docstring) — this only runs when a user clicks
// "Fetch rating" on a specific business. See .claude/skills/skills_backend_node.md.
import { findBusinessById, setGoogleEnrichment } from "../db/businesses.js";
import { addBusinessImage } from "../db/businessImages.js";
import { incrementMetric } from "../db/systemMetrics.js";
import { NotFoundError, ServiceUnavailableError, ValidationError } from "../errors.js";
import { findPlaceId, getPlaceDetails, isGoogleEnrichmentConfigured } from "../lib/googlePlaces.js";
import type { Business } from "../types/db.js";

const RE_ENRICH_COOLDOWN_MS = 60 * 60 * 1000;
// A repeat click within an hour is almost certainly accidental (the row already shows fresh
// data) — skip the API calls rather than spend quota on a no-op. Not a hard block: an hour is
// short enough that a genuinely-wanted refresh is never meaningfully delayed.

export async function enrichBusinessWithGoogle(businessId: string): Promise<Business> {
  if (!isGoogleEnrichmentConfigured()) {
    throw new ServiceUnavailableError(
      "Google enrichment is not configured (GOOGLE_API_KEY is unset)",
    );
  }

  const business = await findBusinessById(businessId);
  if (!business) throw new NotFoundError("Business not found");

  if (business.google_enriched_at) {
    const ageMs = Date.now() - new Date(business.google_enriched_at).getTime();
    if (ageMs < RE_ENRICH_COOLDOWN_MS) {
      return business; // already fresh — cheap/skippable repeat click, see cooldown note above.
    }
  }

  if (business.latitude === null || business.longitude === null) {
    throw new ValidationError("Business has no coordinates to search Google Places with");
  }

  const placeId = await findPlaceId(business.name, business.latitude, business.longitude);
  await incrementMetric("google_places_calls_total"); // Phase 8 — real call, not a cache hit
  if (!placeId) {
    throw new NotFoundError("No matching Google Place found for this business");
  }

  const details = await getPlaceDetails(placeId);
  await incrementMetric("google_places_calls_total");

  const updated = await setGoogleEnrichment(businessId, {
    googleRating: details.rating,
    reviewCount: details.reviewCount,
    reviewUrl: details.reviewUrl,
  });
  if (!updated) throw new NotFoundError("Business not found");

  // Best-effort — a photo-storage failure must not undo the rating/review write that already
  // succeeded above.
  await Promise.all(
    details.photoUrls.map((url) =>
      addBusinessImage({ businessId, kind: "google", url }).catch(() => undefined),
    ),
  );

  return updated;
}
