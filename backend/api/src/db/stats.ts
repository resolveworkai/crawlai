/** Authored by: Mohit Singh */
import { pool } from "./pool.js";

export interface OverviewStats {
  totalBusinesses: number;
  crawlsThisWeek: number;
  aiExtractionsCount: number;
  activeJobsCount: number;
}

export interface TrendPoint {
  day: string; // YYYY-MM-DD
  discovered: number;
  enriched: number;
}

const ACTIVE_JOB_STATUSES = ["pending", "discovering", "crawling", "paused"];

export async function getOverviewStats(): Promise<OverviewStats> {
  const { rows } = await pool.query<{
    total_businesses: string;
    crawls_this_week: string;
    ai_extractions_count: string;
    active_jobs_count: string;
  }>(
    `SELECT
       (SELECT count(*) FROM businesses) AS total_businesses,
       (SELECT count(*) FROM crawl_jobs WHERE created_at >= now() - interval '7 days') AS crawls_this_week,
       (SELECT count(*) FROM businesses WHERE extras <> '{}'::jsonb OR ai_summary IS NOT NULL) AS ai_extractions_count,
       (SELECT count(*) FROM crawl_jobs WHERE status = ANY($1)) AS active_jobs_count`,
    [ACTIVE_JOB_STATUSES],
  );
  const row = rows[0];
  if (!row) throw new Error("getOverviewStats: aggregate query returned no row");
  return {
    totalBusinesses: Number(row.total_businesses),
    crawlsThisWeek: Number(row.crawls_this_week),
    aiExtractionsCount: Number(row.ai_extractions_count),
    activeJobsCount: Number(row.active_jobs_count),
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
     LEFT JOIN businesses d ON d.created_at::date = days.day
     LEFT JOIN businesses e ON e.updated_at::date = days.day AND e.enrichment_status = 'enriched'
     GROUP BY days.day
     ORDER BY days.day`,
  );
  return rows.map((r) => ({
    day: r.day,
    discovered: Number(r.discovered),
    enriched: Number(r.enriched),
  }));
}
