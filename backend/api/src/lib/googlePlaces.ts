/** Authored by: Mohit Singh */
//
// Google Places client for Phase 6's manual, on-demand enrichment (requirements 5/6/9 — rating,
// review count, photos). OSM gives no Google `place_id`, so this first resolves one via Find
// Place From Text (business name + stored lat/lng, biased to a tight radius so the right branch
// of a chain is found), then fetches Place Details for the fields the UI actually shows. Never
// called automatically — only from services/googleEnrichmentService.ts's per-business endpoint.
// See .claude/skills/skills_backend_node.md and md/plans/0001-*.md "Phase 6".
import { config } from "../config.js";

const PLACES_BASE_URL = "https://maps.googleapis.com/maps/api/place";
const FIND_PLACE_BIAS_RADIUS_METERS = 200;

export function isGoogleEnrichmentConfigured(): boolean {
  return typeof config.GOOGLE_API_KEY === "string" && config.GOOGLE_API_KEY.length > 0;
}

export class GoogleQuotaError extends Error {}

interface FindPlaceResponse {
  status: string;
  candidates?: Array<{ place_id: string }>;
}

interface PlaceDetailsResponse {
  status: string;
  result?: {
    rating?: number;
    user_ratings_total?: number;
    url?: string;
    photos?: Array<{ photo_reference: string }>;
  };
}

/** Returns null when Google has no matching place (a normal, expected outcome for many small
 * businesses) — never throws for a plain not-found. Throws GoogleQuotaError on
 * OVER_QUERY_LIMIT/REQUEST_DENIED so the caller can surface a clear message instead of a
 * generic 500. */
export async function findPlaceId(
  name: string,
  latitude: number,
  longitude: number,
): Promise<string | null> {
  const apiKey = requireApiKey();
  const url = new URL(`${PLACES_BASE_URL}/findplacefromtext/json`);
  url.searchParams.set("input", name);
  url.searchParams.set("inputtype", "textquery");
  url.searchParams.set("fields", "place_id");
  url.searchParams.set(
    "locationbias",
    `circle:${FIND_PLACE_BIAS_RADIUS_METERS}@${latitude},${longitude}`,
  );
  url.searchParams.set("key", apiKey);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google Find Place request failed: ${res.status}`);
  }
  const body = (await res.json()) as FindPlaceResponse;
  assertNotQuotaError(body.status);
  if (body.status === "ZERO_RESULTS") return null;
  if (body.status !== "OK") {
    throw new Error(`Google Find Place returned status ${body.status}`);
  }
  return body.candidates?.[0]?.place_id ?? null;
}

export interface GooglePlaceDetails {
  rating: number | null;
  reviewCount: number | null;
  reviewUrl: string | null;
  photoUrls: string[];
}

export async function getPlaceDetails(placeId: string): Promise<GooglePlaceDetails> {
  const apiKey = requireApiKey();
  const url = new URL(`${PLACES_BASE_URL}/details/json`);
  url.searchParams.set("place_id", placeId);
  url.searchParams.set("fields", "rating,user_ratings_total,url,photos");
  url.searchParams.set("key", apiKey);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google Place Details request failed: ${res.status}`);
  }
  const body = (await res.json()) as PlaceDetailsResponse;
  assertNotQuotaError(body.status);
  if (body.status !== "OK") {
    throw new Error(`Google Place Details returned status ${body.status}`);
  }

  const result = body.result ?? {};
  const photoUrls = (result.photos ?? [])
    .slice(0, 5)
    .map((photo) => photoUrl(photo.photo_reference, apiKey));

  return {
    rating: result.rating ?? null,
    reviewCount: result.user_ratings_total ?? null,
    reviewUrl: result.url ?? null,
    photoUrls,
  };
}

function photoUrl(photoReference: string, apiKey: string): string {
  const url = new URL(`${PLACES_BASE_URL}/photo`);
  url.searchParams.set("maxwidth", "800");
  url.searchParams.set("photo_reference", photoReference);
  url.searchParams.set("key", apiKey);
  return url.toString();
}

function assertNotQuotaError(status: string): void {
  if (status === "OVER_QUERY_LIMIT" || status === "REQUEST_DENIED") {
    throw new GoogleQuotaError(`Google Places API error: ${status}`);
  }
}

function requireApiKey(): string {
  if (!isGoogleEnrichmentConfigured()) {
    throw new Error("GOOGLE_API_KEY is not configured");
  }
  // isGoogleEnrichmentConfigured() already proved this is a non-empty string.
  return config.GOOGLE_API_KEY as string;
}
