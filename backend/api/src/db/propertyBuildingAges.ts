/** Authored by: Mohit Singh */
//
// Region building-age reference table (2026-08-25) — see db/migrations/
// 1786300000000_property-building-ages.sql for the schema/rationale. Manually curated: the user
// supplies a real building-name -> completion-year table per region (starting with Dubai Sports
// City), used to fill in a "Property Age" for listings that were never individually detail-
// scraped (real age_years is detail-page-only, sparse).
import { pool } from "./pool.js";
import type { PropertyBuildingAge, PropertyListing } from "../types/db.js";

export interface BuildingAgeEntry {
  buildingName: string;
  completionYear: number | null;
  isEstimated: boolean;
}

// Upserts every entry for ONE region in a single pass — re-importing the same region's table
// updates existing rows (matched case-insensitively on region+buildingName) rather than
// duplicating them, so re-pasting a corrected table is always safe.
export async function bulkUpsertBuildingAges(
  region: string,
  entries: BuildingAgeEntry[],
): Promise<number> {
  if (entries.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let count = 0;
    for (const entry of entries) {
      await client.query(
        `INSERT INTO property_building_ages (region, building_name, completion_year, is_estimated)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (lower(region), lower(building_name)) DO UPDATE SET
           completion_year = EXCLUDED.completion_year,
           is_estimated = EXCLUDED.is_estimated,
           updated_at = now()`,
        [region, entry.buildingName, entry.completionYear, entry.isEstimated],
      );
      count += 1;
    }
    await client.query("COMMIT");
    return count;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listBuildingAges(region?: string): Promise<PropertyBuildingAge[]> {
  if (region) {
    const { rows } = await pool.query<PropertyBuildingAge>(
      "SELECT * FROM property_building_ages WHERE lower(region) = lower($1) ORDER BY building_name ASC",
      [region],
    );
    return rows;
  }
  const { rows } = await pool.query<PropertyBuildingAge>(
    "SELECT * FROM property_building_ages ORDER BY region ASC, building_name ASC",
  );
  return rows;
}

// Distinct regions + how many buildings each has — for the management panel's region list.
export async function listBuildingAgeRegions(): Promise<{ region: string; count: number }[]> {
  const { rows } = await pool.query<{ region: string; count: string }>(
    "SELECT region, count(*)::text AS count FROM property_building_ages GROUP BY region ORDER BY region ASC",
  );
  return rows.map((r) => ({ region: r.region, count: Number(r.count) }));
}

export async function deleteBuildingAge(id: string): Promise<boolean> {
  const { rowCount } = await pool.query("DELETE FROM property_building_ages WHERE id = $1", [id]);
  return (rowCount ?? 0) > 0;
}

export async function deleteBuildingAgeRegion(region: string): Promise<number> {
  const { rowCount } = await pool.query(
    "DELETE FROM property_building_ages WHERE lower(region) = lower($1)",
    [region],
  );
  return rowCount ?? 0;
}

interface MappedAge {
  mapped_age_years: number | null;
  mapped_age_is_estimated: boolean;
  mapped_building_name: string | null;
}

const NO_MATCH: MappedAge = {
  mapped_age_years: null,
  mapped_age_is_estimated: false,
  mapped_building_name: null,
};

function ageFromCompletionYear(completionYear: number | null): number | null {
  if (completionYear === null) return null;
  const currentYear = new Date().getFullYear();
  // A future/this-year completion (an off-plan or freshly-handed-over building) reads as 0, never
  // negative — "New" in the source table's own vocabulary.
  return Math.max(0, currentYear - completionYear);
}

// In-memory matcher — the whole reference table is small (hundreds of rows across every region,
// not per-listing), so it's fetched ONCE per results/search request and matched against every
// listing in JS rather than attempting a per-listing SQL join (a reliable "does this title CONTAIN
// this building name" match isn't expressible as a simple SQL ILIKE join — it needs the longest-
// match-wins tie-break below, e.g. "Golf Tower" vs "The Golf Tower" are both real, distinct
// buildings in the same source table).
export class BuildingAgeMatcher {
  private readonly all: PropertyBuildingAge[];

  constructor(all: PropertyBuildingAge[]) {
    // Longest building_name first, so a more specific match (e.g. "Elite Sports Residence 9")
    // always wins over a shorter one that's also a substring of it (e.g. "Elite Sports Residence").
    this.all = [...all].sort((a, b) => b.building_name.length - a.building_name.length);
  }

  // `haystack` is the listing's own title+community+location_text joined together;
  // `regionHint` is the job's own location (or the listing's community) — matches scoped to a
  // region whose name appears in the hint are tried FIRST, falling back to a name-only match
  // against every region if nothing region-scoped hit (a listing's own community field is often
  // null/inconsistent, so a global fallback avoids losing real matches over that gap).
  match(haystack: string, regionHint: string | null): MappedAge {
    const haystackLower = haystack.toLowerCase();
    const hintLower = regionHint?.toLowerCase() ?? "";

    const scoped = hintLower
      ? this.all.filter((b) => hintLower.includes(b.region.toLowerCase()))
      : [];
    const found =
      scoped.find((b) => haystackLower.includes(b.building_name.toLowerCase())) ??
      this.all.find((b) => haystackLower.includes(b.building_name.toLowerCase()));

    if (!found) return NO_MATCH;
    return {
      mapped_age_years: ageFromCompletionYear(found.completion_year),
      mapped_age_is_estimated: found.is_estimated,
      mapped_building_name: found.building_name,
    };
  }
}

let cachedMatcher: { matcher: BuildingAgeMatcher; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

// The reference table changes rarely (a manual bulk-import), so a short in-process cache avoids
// re-fetching the whole table on every single results/search request while still picking up a
// fresh import within a minute.
async function getMatcher(): Promise<BuildingAgeMatcher> {
  const now = Date.now();
  if (cachedMatcher && now - cachedMatcher.fetchedAt < CACHE_TTL_MS) {
    return cachedMatcher.matcher;
  }
  const all = await listBuildingAges();
  const matcher = new BuildingAgeMatcher(all);
  cachedMatcher = { matcher, fetchedAt: now };
  return matcher;
}

export function invalidateBuildingAgeCache(): void {
  cachedMatcher = null;
}

// Enriches a batch of already-fetched listings with a mapped age — call after the main query, for
// every listing whose own real age_years is null (a mapped estimate never overrides a real one).
// Skips fetching the reference table entirely when every listing already has a real age (common
// for a fully detail-scraped small batch) — no DB round-trip for nothing.
export async function attachMappedAges<
  T extends PropertyListing & Partial<MappedAge> & { job_location?: string },
>(listings: T[], jobLocationFallback?: string): Promise<(T & MappedAge)[]> {
  if (listings.length === 0) return listings as (T & MappedAge)[];
  if (listings.every((l) => l.age_years !== null)) {
    return listings.map((listing) => ({ ...listing, ...NO_MATCH }));
  }
  const matcher = await getMatcher();
  return listings.map((listing) => {
    if (listing.age_years !== null) {
      // Real detail-scraped age always wins — no mapped estimate needed or shown.
      return { ...listing, ...NO_MATCH };
    }
    const haystack = [listing.title, listing.community, listing.location_text]
      .filter((v): v is string => v !== null && v !== undefined)
      .join(" ");
    const regionHint = listing.job_location ?? listing.community ?? jobLocationFallback ?? null;
    return { ...listing, ...matcher.match(haystack, regionHint) };
  });
}
