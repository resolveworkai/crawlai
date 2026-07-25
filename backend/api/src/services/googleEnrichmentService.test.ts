/** Authored by: Mohit Singh */
//
// Pure unit tests — db/businesses.ts, db/businessImages.ts, and lib/googlePlaces.ts are all
// mocked, so this runs with no live Postgres or Google API.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NotFoundError, ServiceUnavailableError, ValidationError } from "../errors.js";
import type { Business } from "../types/db.js";

const findBusinessById = vi.fn();
const setGoogleEnrichment = vi.fn();
const addBusinessImage = vi.fn();
const findPlaceId = vi.fn();
const getPlaceDetails = vi.fn();
const isGoogleEnrichmentConfigured = vi.fn();
const incrementMetric = vi.fn();

vi.mock("../db/businesses.js", () => ({
  findBusinessById: (...args: unknown[]) => findBusinessById(...args),
  setGoogleEnrichment: (...args: unknown[]) => setGoogleEnrichment(...args),
}));
vi.mock("../db/businessImages.js", () => ({
  addBusinessImage: (...args: unknown[]) => addBusinessImage(...args),
}));
vi.mock("../db/systemMetrics.js", () => ({
  incrementMetric: (...args: unknown[]) => incrementMetric(...args),
}));
vi.mock("../lib/googlePlaces.js", () => ({
  findPlaceId: (...args: unknown[]) => findPlaceId(...args),
  getPlaceDetails: (...args: unknown[]) => getPlaceDetails(...args),
  isGoogleEnrichmentConfigured: () => isGoogleEnrichmentConfigured(),
}));

const { enrichBusinessWithGoogle } = await import("./googleEnrichmentService.js");

function business(overrides: Partial<Business> = {}): Business {
  return {
    id: "biz-1",
    name: "Test Gym",
    latitude: 52.5,
    longitude: 13.4,
    google_enriched_at: null,
    ...overrides,
  } as Business;
}

beforeEach(() => {
  vi.clearAllMocks();
  isGoogleEnrichmentConfigured.mockReturnValue(true);
});

describe("enrichBusinessWithGoogle", () => {
  it("throws ServiceUnavailableError when Google enrichment is not configured", async () => {
    isGoogleEnrichmentConfigured.mockReturnValue(false);
    await expect(enrichBusinessWithGoogle("biz-1")).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(findBusinessById).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when the business doesn't exist", async () => {
    findBusinessById.mockResolvedValue(null);
    await expect(enrichBusinessWithGoogle("missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws ValidationError when the business has no coordinates", async () => {
    findBusinessById.mockResolvedValue(business({ latitude: null }));
    await expect(enrichBusinessWithGoogle("biz-1")).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws NotFoundError when Google has no matching place", async () => {
    findBusinessById.mockResolvedValue(business());
    findPlaceId.mockResolvedValue(null);
    await expect(enrichBusinessWithGoogle("biz-1")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("resolves place, fetches details, writes rating/reviews, and stores photos", async () => {
    findBusinessById.mockResolvedValue(business());
    findPlaceId.mockResolvedValue("place-abc");
    getPlaceDetails.mockResolvedValue({
      rating: 4.7,
      reviewCount: 88,
      reviewUrl: "https://maps.google.com/?cid=1",
      photoUrls: ["https://photo1", "https://photo2"],
    });
    const updated = business({ google_rating: "4.7" as unknown as never });
    setGoogleEnrichment.mockResolvedValue(updated);
    addBusinessImage.mockResolvedValue({});

    const result = await enrichBusinessWithGoogle("biz-1");

    expect(findPlaceId).toHaveBeenCalledWith("Test Gym", 52.5, 13.4);
    expect(setGoogleEnrichment).toHaveBeenCalledWith("biz-1", {
      googleRating: 4.7,
      reviewCount: 88,
      reviewUrl: "https://maps.google.com/?cid=1",
    });
    expect(addBusinessImage).toHaveBeenCalledTimes(2);
    expect(addBusinessImage).toHaveBeenCalledWith({
      businessId: "biz-1",
      kind: "google",
      url: "https://photo1",
    });
    expect(result).toBe(updated);
    expect(incrementMetric).toHaveBeenCalledWith("google_places_calls_total");
    expect(incrementMetric).toHaveBeenCalledTimes(2); // Phase 8: find-place + place-details
  });

  it("skips a business enriched within the last hour (cheap repeat-click no-op)", async () => {
    findBusinessById.mockResolvedValue(
      business({ google_enriched_at: new Date(Date.now() - 5 * 60 * 1000) }),
    );

    const result = await enrichBusinessWithGoogle("biz-1");

    expect(findPlaceId).not.toHaveBeenCalled();
    expect(result.id).toBe("biz-1");
    expect(incrementMetric).not.toHaveBeenCalled(); // a cooldown skip is not a real Google call
  });

  it("re-enriches a business whose Google data is more than an hour stale", async () => {
    findBusinessById.mockResolvedValue(
      business({ google_enriched_at: new Date(Date.now() - 2 * 60 * 60 * 1000) }),
    );
    findPlaceId.mockResolvedValue("place-abc");
    getPlaceDetails.mockResolvedValue({
      rating: 4.2,
      reviewCount: 10,
      reviewUrl: null,
      photoUrls: [],
    });
    setGoogleEnrichment.mockResolvedValue(business());

    await enrichBusinessWithGoogle("biz-1");

    expect(findPlaceId).toHaveBeenCalledOnce();
  });

  it("does not fail the whole request when a photo write fails", async () => {
    findBusinessById.mockResolvedValue(business());
    findPlaceId.mockResolvedValue("place-abc");
    getPlaceDetails.mockResolvedValue({
      rating: 4.0,
      reviewCount: 5,
      reviewUrl: null,
      photoUrls: ["https://photo1"],
    });
    setGoogleEnrichment.mockResolvedValue(business());
    addBusinessImage.mockRejectedValue(new Error("db write failed"));

    await expect(enrichBusinessWithGoogle("biz-1")).resolves.toBeDefined();
  });
});
