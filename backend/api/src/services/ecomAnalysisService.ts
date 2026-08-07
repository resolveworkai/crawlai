/** Authored by: Mohit Singh */
//
// Aggregate market-analysis view for a Product Research (Ecom-Crawl) job — price bands, rating
// distribution, badge frequency and top opportunity-score products. Sponsored listings are
// excluded from the stats/rankings (they're paid placement, not organic market signal) but
// counted separately so the UI can still show "N sponsored" alongside the organic totals.
import { pool } from "../db/pool.js";
import { findEcomJobById } from "../db/ecomJobs.js";
import { NotFoundError } from "../errors.js";

export interface EcomAnalysisSummary {
  productCount: number;
  sponsoredCount: number;
  price: {
    min: number | null;
    max: number | null;
    p25: number | null;
    median: number | null;
    p75: number | null;
  };
  rating: {
    avg: number | null;
    median: number | null;
  };
  reviews: {
    total: number | null;
    median: number | null;
  };
  pctFreeDelivery: number | null;
  boughtPastMonth: {
    productsWithData: number;
    total: number | null;
  };
}

export interface EcomRatingBucket {
  star: number;
  count: number;
}

export interface EcomBadgeFrequency {
  badge: string;
  count: number;
}

export interface EcomTopOpportunity {
  id: string;
  idx: number;
  title: string;
  price: number | null;
  rating: number | null;
  reviewCount: number | null;
  opportunityScore: number | null;
  imageUrl: string | null;
  productUrl: string | null;
}

export interface EcomAnalysis {
  jobId: string;
  summary: EcomAnalysisSummary;
  priceBands: { p25: number | null; median: number | null; p75: number | null };
  ratingDistribution: EcomRatingBucket[];
  badgeFrequency: EcomBadgeFrequency[];
  topOpportunities: EcomTopOpportunity[];
}

interface SummaryRow {
  product_count: string;
  min_price: string | null;
  max_price: string | null;
  p25_price: string | null;
  median_price: string | null;
  p75_price: string | null;
  avg_rating: string | null;
  median_rating: string | null;
  total_reviews: string | null;
  median_reviews: string | null;
  pct_free_delivery: string | null;
  bought_data_count: string;
  total_bought_past_month: string | null;
}

function toNumOrNull(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function buildEcomAnalysis(jobId: string): Promise<EcomAnalysis> {
  const job = await findEcomJobById(jobId);
  if (!job) throw new NotFoundError("Ecom job not found");

  const [summaryResult, sponsoredResult, ratingResult, badgeResult, topResult] =
    await Promise.all([
      pool.query<SummaryRow>(
        `SELECT
           count(*)::text AS product_count,
           min(price)::text AS min_price,
           max(price)::text AS max_price,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY price)::text AS p25_price,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY price)::text AS median_price,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY price)::text AS p75_price,
           avg(rating)::text AS avg_rating,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY rating)::text AS median_rating,
           sum(review_count)::text AS total_reviews,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY review_count)::text AS median_reviews,
           (count(*) FILTER (WHERE free_delivery) * 100.0 / NULLIF(count(*), 0))::text
             AS pct_free_delivery,
           count(*) FILTER (WHERE bought_past_month IS NOT NULL)::text AS bought_data_count,
           sum(bought_past_month)::text AS total_bought_past_month
         FROM ecom_products
         WHERE job_id = $1 AND sponsored = false`,
        [jobId],
      ),
      pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ecom_products WHERE job_id = $1 AND sponsored = true`,
        [jobId],
      ),
      pool.query<{ star: number; n: string }>(
        `SELECT floor(rating)::int AS star, count(*)::text AS n
         FROM ecom_products
         WHERE job_id = $1 AND sponsored = false AND rating IS NOT NULL
         GROUP BY floor(rating)
         ORDER BY star DESC`,
        [jobId],
      ),
      pool.query<{ badge: string; n: string }>(
        `SELECT badge, count(*)::text AS n
         FROM ecom_products, LATERAL jsonb_array_elements_text(badges) AS badge
         WHERE job_id = $1 AND sponsored = false
         GROUP BY badge
         ORDER BY count(*) DESC
         LIMIT 20`,
        [jobId],
      ),
      pool.query<{
        id: string;
        idx: number;
        title: string;
        price: string | null;
        rating: string | null;
        review_count: number | null;
        opportunity_score: string | null;
        image_url: string | null;
        product_url: string | null;
      }>(
        `SELECT id, idx, title, price, rating, review_count, opportunity_score, image_url,
                product_url
         FROM ecom_products
         WHERE job_id = $1 AND sponsored = false
         ORDER BY opportunity_score DESC NULLS LAST
         LIMIT 10`,
        [jobId],
      ),
    ]);

  const s = summaryResult.rows[0];
  const summary: EcomAnalysisSummary = {
    productCount: Number(s?.product_count ?? 0),
    sponsoredCount: Number(sponsoredResult.rows[0]?.n ?? 0),
    price: {
      min: toNumOrNull(s?.min_price),
      max: toNumOrNull(s?.max_price),
      p25: toNumOrNull(s?.p25_price),
      median: toNumOrNull(s?.median_price),
      p75: toNumOrNull(s?.p75_price),
    },
    rating: {
      avg: toNumOrNull(s?.avg_rating),
      median: toNumOrNull(s?.median_rating),
    },
    reviews: {
      total: toNumOrNull(s?.total_reviews),
      median: toNumOrNull(s?.median_reviews),
    },
    pctFreeDelivery: toNumOrNull(s?.pct_free_delivery),
    boughtPastMonth: {
      productsWithData: Number(s?.bought_data_count ?? 0),
      total: toNumOrNull(s?.total_bought_past_month),
    },
  };

  return {
    jobId,
    summary,
    priceBands: {
      p25: summary.price.p25,
      median: summary.price.median,
      p75: summary.price.p75,
    },
    ratingDistribution: ratingResult.rows.map((r) => ({ star: r.star, count: Number(r.n) })),
    badgeFrequency: badgeResult.rows.map((r) => ({ badge: r.badge, count: Number(r.n) })),
    topOpportunities: topResult.rows.map((r) => ({
      id: r.id,
      idx: r.idx,
      title: r.title,
      price: toNumOrNull(r.price),
      rating: toNumOrNull(r.rating),
      reviewCount: r.review_count,
      opportunityScore: toNumOrNull(r.opportunity_score),
      imageUrl: r.image_url,
      productUrl: r.product_url,
    })),
  };
}
