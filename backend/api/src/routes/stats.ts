/** Authored by: Mohit Singh */
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getOverviewStats, getSevenDayTrend, getSystemHealth } from "../db/stats.js";
import { listCrawlJobs } from "../db/crawlJobs.js";
import { listRecentlyEnriched } from "../db/businesses.js";
import { getAllMetrics } from "../db/systemMetrics.js";

export const statsRouter = Router();

// requireAuth applied per-route, not via router.use() — see jobs.ts for why a path-unscoped
// router.use(requireAuth) is a real bug (turns unrelated 404s into 401s).

interface OverviewResponse {
  stats: Awaited<ReturnType<typeof getOverviewStats>>;
  trend: Awaited<ReturnType<typeof getSevenDayTrend>>;
  recentJobs: Awaited<ReturnType<typeof listCrawlJobs>>;
  recentlyEnriched: Awaited<ReturnType<typeof listRecentlyEnriched>>;
}

// Brief in-memory cache (30s) — exact real-time precision isn't needed for a dashboard tile,
// and this is a 4-way aggregate query on every dashboard load otherwise. See
// md/plans/0001-*.md "Design-spec alignment" finding #1.
const CACHE_TTL_MS = 30_000;
let cache: { at: number; data: OverviewResponse } | null = null;

statsRouter.get("/stats/overview", requireAuth, async (_req, res) => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    res.json(cache.data);
    return;
  }

  const [stats, trend, recentJobs, recentlyEnriched] = await Promise.all([
    getOverviewStats(),
    getSevenDayTrend(),
    listCrawlJobs(4),
    listRecentlyEnriched(5),
  ]);

  const data: OverviewResponse = { stats, trend, recentJobs, recentlyEnriched };
  cache = { at: Date.now(), data };
  res.json(data);
});

// Phase 8 — observability: job success rate + failure-spike alarm, Tier-1-vs-Tier-2 hit ratio,
// and raw LLM/Google Places call counts (see db/systemMetrics.ts). A lightweight status surface
// for operators, not a full metrics/alerting pipeline — see md/plans/0001-*.md "Phase 8".
statsRouter.get("/stats/system", requireAuth, async (_req, res) => {
  const [health, metrics] = await Promise.all([getSystemHealth(), getAllMetrics()]);
  res.json({
    health,
    metrics: {
      llmCallsTotal: metrics.llm_calls_total ?? 0,
      tier2RendersTotal: metrics.tier2_renders_total ?? 0,
      googlePlacesCallsTotal: metrics.google_places_calls_total ?? 0,
    },
  });
});
