/** Authored by: Mohit Singh */
//
// Aggregate market-analysis view for a Property Research job — price/sqft bands, community
// breakdown, and the top-10 best-value-for-money (distress_score) listings the whole feature
// exists to surface. Mirrors ecomAnalysisService.ts's shape/conventions.
import { pool } from "../db/pool.js";
import { findPropertyJobById } from "../db/propertyJobs.js";
import { NotFoundError } from "../errors.js";

export interface PropertyAnalysisSummary {
  listingCount: number;
  needsReviewCount: number;
  detailScrapedCount: number;
  price: {
    min: number | null;
    max: number | null;
    p25: number | null;
    median: number | null;
    p75: number | null;
  };
  pricePerSqft: {
    min: number | null;
    max: number | null;
    median: number | null;
  };
  avgListedDaysAgo: number | null;
  pctVerified: number | null;
}

export interface PropertyCommunityBreakdown {
  community: string;
  count: number;
  medianPrice: number | null;
  medianPricePerSqft: number | null;
}

export interface PropertyTopListing {
  id: string;
  idx: number;
  title: string;
  price: number | null;
  areaSqft: number | null;
  pricePerSqft: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  community: string | null;
  distressScore: number | null;
  distressKeywords: string[];
  listingUrl: string | null;
  imageUrl: string | null;
  whatsappLink: string | null;
  phoneNumber: string | null;
}

export interface PropertyAnalysis {
  jobId: string;
  summary: PropertyAnalysisSummary;
  communityBreakdown: PropertyCommunityBreakdown[];
  // The core deliverable per the original brief: "rate top 10 in the region best value for
  // money" — ranked by distress_score, best deal first.
  top10: PropertyTopListing[];
}

interface SummaryRow {
  listing_count: string;
  needs_review_count: string;
  detail_scraped_count: string;
  min_price: string | null;
  max_price: string | null;
  p25_price: string | null;
  median_price: string | null;
  p75_price: string | null;
  min_pps: string | null;
  max_pps: string | null;
  median_pps: string | null;
  avg_listed_days_ago: string | null;
  pct_verified: string | null;
}

function toNumOrNull(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function buildPropertyAnalysis(jobId: string): Promise<PropertyAnalysis> {
  const job = await findPropertyJobById(jobId);
  if (!job) throw new NotFoundError("Property job not found");

  const [summaryResult, communityResult, topResult] = await Promise.all([
    pool.query<SummaryRow>(
      `SELECT
         count(*)::text AS listing_count,
         count(*) FILTER (WHERE needs_review)::text AS needs_review_count,
         count(*) FILTER (WHERE detail_scraped)::text AS detail_scraped_count,
         min(price)::text AS min_price,
         max(price)::text AS max_price,
         percentile_cont(0.25) WITHIN GROUP (ORDER BY price)::text AS p25_price,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::text AS median_price,
         percentile_cont(0.75) WITHIN GROUP (ORDER BY price)::text AS p75_price,
         min(price_per_sqft)::text AS min_pps,
         max(price_per_sqft)::text AS max_pps,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_sqft)::text AS median_pps,
         avg(listed_days_ago)::text AS avg_listed_days_ago,
         (count(*) FILTER (WHERE verified) * 100.0 / NULLIF(count(*), 0))::text AS pct_verified
       FROM property_listings
       WHERE job_id = $1`,
      [jobId],
    ),
    pool.query<{
      community: string;
      n: string;
      median_price: string | null;
      median_pps: string | null;
    }>(
      `SELECT
         coalesce(community, location_text, 'Unknown') AS community,
         count(*)::text AS n,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::text AS median_price,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY price_per_sqft)::text AS median_pps
       FROM property_listings
       WHERE job_id = $1
       GROUP BY coalesce(community, location_text, 'Unknown')
       ORDER BY count(*) DESC
       LIMIT 20`,
      [jobId],
    ),
    pool.query<{
      id: string;
      idx: number;
      title: string;
      price: string | null;
      area_sqft: string | null;
      price_per_sqft: string | null;
      bedrooms: number | null;
      bathrooms: number | null;
      community: string | null;
      location_text: string | null;
      distress_score: string | null;
      distress_keywords: string[];
      listing_url: string | null;
      image_urls: string[];
      whatsapp_link: string | null;
      phone_number: string | null;
    }>(
      `SELECT id, idx, title, price, area_sqft, price_per_sqft, bedrooms, bathrooms,
              community, location_text, distress_score, distress_keywords, listing_url,
              image_urls, whatsapp_link, phone_number
       FROM property_listings
       WHERE job_id = $1
       ORDER BY distress_score DESC NULLS LAST
       LIMIT 10`,
      [jobId],
    ),
  ]);

  const s = summaryResult.rows[0];
  const summary: PropertyAnalysisSummary = {
    listingCount: Number(s?.listing_count ?? 0),
    needsReviewCount: Number(s?.needs_review_count ?? 0),
    detailScrapedCount: Number(s?.detail_scraped_count ?? 0),
    price: {
      min: toNumOrNull(s?.min_price),
      max: toNumOrNull(s?.max_price),
      p25: toNumOrNull(s?.p25_price),
      median: toNumOrNull(s?.median_price),
      p75: toNumOrNull(s?.p75_price),
    },
    pricePerSqft: {
      min: toNumOrNull(s?.min_pps),
      max: toNumOrNull(s?.max_pps),
      median: toNumOrNull(s?.median_pps),
    },
    avgListedDaysAgo: toNumOrNull(s?.avg_listed_days_ago),
    pctVerified: toNumOrNull(s?.pct_verified),
  };

  return {
    jobId,
    summary,
    communityBreakdown: communityResult.rows.map((r) => ({
      community: r.community,
      count: Number(r.n),
      medianPrice: toNumOrNull(r.median_price),
      medianPricePerSqft: toNumOrNull(r.median_pps),
    })),
    top10: topResult.rows.map((r) => ({
      id: r.id,
      idx: r.idx,
      title: r.title,
      price: toNumOrNull(r.price),
      areaSqft: toNumOrNull(r.area_sqft),
      pricePerSqft: toNumOrNull(r.price_per_sqft),
      bedrooms: r.bedrooms,
      bathrooms: r.bathrooms,
      community: r.community ?? r.location_text,
      distressScore: toNumOrNull(r.distress_score),
      distressKeywords: Array.isArray(r.distress_keywords) ? r.distress_keywords : [],
      listingUrl: r.listing_url,
      imageUrl: Array.isArray(r.image_urls) ? (r.image_urls[0] ?? null) : null,
      whatsappLink: r.whatsapp_link,
      phoneNumber: r.phone_number,
    })),
  };
}
