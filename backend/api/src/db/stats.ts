/** Authored by: Mohit Singh */
import { pool } from "./pool.js";

export interface OverviewStats {
  totalBusinesses: number;
  crawlsThisWeek: number;
  aiExtractionsCount: number;
  activeJobsCount: number;
  // Crawl (OCR) — a separate parallel job type (Google Maps capture, see md/OCR_CRAWL.md), kept
  // as its own distinct counts rather than folded into the fields above: it has a different job
  // vocabulary, different volume profile, and conflating "Crawls this week" across both would
  // silently blur two very different pipelines.
  ocrBusinessesCount: number;
  ocrJobsThisWeek: number;
  ocrActiveJobsCount: number;
}

export interface TrendPoint {
  day: string; // YYYY-MM-DD
  discovered: number;
  enriched: number;
}

const ACTIVE_JOB_STATUSES = ["pending", "discovering", "crawling", "paused"];
const ACTIVE_OCR_JOB_STATUSES = ["queued", "capturing", "ocr", "parsing"];

export async function getOverviewStats(): Promise<OverviewStats> {
  const { rows } = await pool.query<{
    total_businesses: string;
    crawls_this_week: string;
    ai_extractions_count: string;
    active_jobs_count: string;
    ocr_businesses_count: string;
    ocr_jobs_this_week: string;
    ocr_active_jobs_count: string;
  }>(
    `SELECT
       (SELECT count(*) FROM businesses WHERE merged_into_id IS NULL) AS total_businesses,
       (SELECT count(*) FROM crawl_jobs WHERE created_at >= now() - interval '7 days') AS crawls_this_week,
       (SELECT count(*) FROM businesses
          WHERE (extras <> '{}'::jsonb OR ai_summary IS NOT NULL) AND merged_into_id IS NULL
       ) AS ai_extractions_count,
       (SELECT count(*) FROM crawl_jobs WHERE status = ANY($1)) AS active_jobs_count,
       (SELECT count(*) FROM ocr_businesses) AS ocr_businesses_count,
       (SELECT count(*) FROM ocr_jobs WHERE created_at >= now() - interval '7 days') AS ocr_jobs_this_week,
       (SELECT count(*) FROM ocr_jobs WHERE status = ANY($2)) AS ocr_active_jobs_count`,
    [ACTIVE_JOB_STATUSES, ACTIVE_OCR_JOB_STATUSES],
  );
  const row = rows[0];
  if (!row) throw new Error("getOverviewStats: aggregate query returned no row");
  return {
    totalBusinesses: Number(row.total_businesses),
    crawlsThisWeek: Number(row.crawls_this_week),
    aiExtractionsCount: Number(row.ai_extractions_count),
    activeJobsCount: Number(row.active_jobs_count),
    ocrBusinessesCount: Number(row.ocr_businesses_count),
    ocrJobsThisWeek: Number(row.ocr_jobs_this_week),
    ocrActiveJobsCount: Number(row.ocr_active_jobs_count),
  };
}

// Discovered = businesses first seen that day (created_at); enriched = businesses that
// reached enrichment_status='enriched' that day (updated_at). Powers the Overview screen's
// 7-day area chart. generate_series ensures days with zero activity still appear (no gaps).
export async function getSevenDayTrend(): Promise<TrendPoint[]> {
  const { rows } = await pool.query<{ day: string; discovered: string; enriched: string }>(
    `WITH days AS (
       SELECT generate_series(
         (now() - interval '6 days')::date, now()::date, interval '1 day'
       )::date AS day
     )
     SELECT
       days.day::text AS day,
       count(DISTINCT d.id) AS discovered,
       count(DISTINCT e.id) AS enriched
     FROM days
     LEFT JOIN businesses d ON d.created_at::date = days.day AND d.merged_into_id IS NULL
     LEFT JOIN businesses e ON e.updated_at::date = days.day AND e.enrichment_status = 'enriched'
       AND e.merged_into_id IS NULL
     GROUP BY days.day
     ORDER BY days.day`,
  );
  return rows.map((r) => ({
    day: r.day,
    discovered: Number(r.discovered),
    enriched: Number(r.enriched),
  }));
}

export interface SystemHealth {
  jobSuccessRate7d: number | null; // null when zero jobs finished in the window (no data yet)
  jobFailureCount24h: number;
  jobCompletedCount24h: number;
  jobFailureAlert: boolean; // a simple, real "alarm on failure spikes" surface — see stats route
  tierHitRatio: number | null; // fraction of enriched businesses that needed Tier-2, null if none tiered yet
}

const FAILURE_ALERT_MIN_JOBS = 3;
const FAILURE_ALERT_RATE_THRESHOLD = 0.5;

export async function getSystemHealth(): Promise<SystemHealth> {
  const { rows } = await pool.query<{
    completed_7d: string;
    failed_7d: string;
    completed_24h: string;
    failed_24h: string;
    tier1_count: string;
    tier2_count: string;
  }>(
    `SELECT
       (SELECT count(*) FROM crawl_jobs
          WHERE status = 'completed' AND finished_at >= now() - interval '7 days') AS completed_7d,
       (SELECT count(*) FROM crawl_jobs
          WHERE status = 'failed' AND finished_at >= now() - interval '7 days') AS failed_7d,
       (SELECT count(*) FROM crawl_jobs
          WHERE status = 'completed' AND finished_at >= now() - interval '24 hours') AS completed_24h,
       (SELECT count(*) FROM crawl_jobs
          WHERE status = 'failed' AND finished_at >= now() - interval '24 hours') AS failed_24h,
       (SELECT count(*) FROM businesses
          WHERE enrichment_tier = 'tier1' AND merged_into_id IS NULL) AS tier1_count,
       (SELECT count(*) FROM businesses
          WHERE enrichment_tier = 'tier2' AND merged_into_id IS NULL) AS tier2_count`,
  );
  const row = rows[0];
  if (!row) throw new Error("getSystemHealth: aggregate query returned no row");

  const completed7d = Number(row.completed_7d);
  const failed7d = Number(row.failed_7d);
  const total7d = completed7d + failed7d;
  const completed24h = Number(row.completed_24h);
  const failed24h = Number(row.failed_24h);
  const total24h = completed24h + failed24h;
  const tier1 = Number(row.tier1_count);
  const tier2 = Number(row.tier2_count);
  const totalTiered = tier1 + tier2;

  return {
    jobSuccessRate7d: total7d > 0 ? completed7d / total7d : null,
    jobCompletedCount24h: completed24h,
    jobFailureCount24h: failed24h,
    jobFailureAlert:
      total24h >= FAILURE_ALERT_MIN_JOBS && failed24h / total24h >= FAILURE_ALERT_RATE_THRESHOLD,
    tierHitRatio: totalTiered > 0 ? tier2 / totalTiered : null,
  };
}
