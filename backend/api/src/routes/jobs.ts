/** Authored by: Mohit Singh */
import { Router } from "express";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  createJobSchema,
  jobIdParamsSchema,
  listJobsQuerySchema,
  type CreateJobInput,
} from "../schemas/jobs.js";
import { deleteCrawlJob, findCrawlJobById, listCrawlJobs } from "../db/crawlJobs.js";
import { listLogsForJob, listRecentLogs } from "../db/crawlLogs.js";
import { listRecentOcrLogs } from "../db/ocrLogs.js";
import { cancelJob, createJob, pauseJob, resumeJob, retryJob } from "../services/jobsService.js";
import { NotFoundError } from "../errors.js";
import { SseChannel } from "../lib/sse.js";

export const jobsRouter = Router();

// requireAuth is applied per-route (not via router.use(requireAuth)) — a path-unscoped
// router.use() runs for EVERY request that reaches this router, including ones matching no
// route here at all, which turned unrelated 404s into 401s. Verified bug, not hypothetical:
// caught by health.test.ts's "unknown route returns 404" test after this router was mounted.
// See .claude/skills/skills_backend_node.md.

jobsRouter.post(
  "/jobs",
  requireAuth,
  requireRole("operator"),
  validate(createJobSchema),
  async (req, res) => {
    const job = await createJob(req.user!.id, req.body as CreateJobInput);
    res.status(201).json({ job });
  },
);

jobsRouter.get(
  "/jobs",
  requireAuth,
  validate(listJobsQuerySchema, "query"),
  async (req, res) => {
    const { limit } = req.validatedQuery as unknown as { limit: number };
    const jobs = await listCrawlJobs(limit);
    res.json({ jobs });
  },
);

jobsRouter.get(
  "/jobs/:id",
  requireAuth,
  validate(jobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await findCrawlJobById(req.params.id as string);
    if (!job) throw new NotFoundError("Job not found");
    res.json({ job });
  },
);

jobsRouter.post(
  "/jobs/:id/pause",
  requireAuth,
  requireRole("operator"),
  validate(jobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await pauseJob(req.params.id as string);
    res.json({ job });
  },
);

jobsRouter.post(
  "/jobs/:id/resume",
  requireAuth,
  requireRole("operator"),
  validate(jobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await resumeJob(req.params.id as string);
    res.json({ job });
  },
);

jobsRouter.post(
  "/jobs/:id/retry",
  requireAuth,
  requireRole("operator"),
  validate(jobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await retryJob(req.params.id as string);
    res.json({ job });
  },
);

jobsRouter.post(
  "/jobs/:id/cancel",
  requireAuth,
  requireRole("operator"),
  validate(jobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await cancelJob(req.params.id as string);
    res.json({ job });
  },
);

jobsRouter.delete(
  "/jobs/:id",
  requireAuth,
  requireRole("operator"),
  validate(jobIdParamsSchema, "params"),
  async (req, res) => {
    const deleted = await deleteCrawlJob(req.params.id as string);
    if (!deleted) throw new NotFoundError("Job not found");
    res.status(204).send();
  },
);

const POLL_INTERVAL_MS = 2000;

// Per-job progress + logs. Real (polling-based), not a stub — it reflects whatever's in the
// DB right now; Phase 3's worker writes are what makes it interesting to watch.
jobsRouter.get(
  "/jobs/:id/stream",
  requireAuth,
  validate(jobIdParamsSchema, "params"),
  async (req, res) => {
    const jobId = req.params.id as string;
    const job = await findCrawlJobById(jobId);
    if (!job) throw new NotFoundError("Job not found");

    const channel = new SseChannel(res);
    let lastLogTs: Date | null = null;

    const tick = async (): Promise<void> => {
      const current = await findCrawlJobById(jobId);
      if (current) channel.send("job", current);

      const logs = await listLogsForJob(jobId, 20);
      const fresh = lastLogTs ? logs.filter((l) => l.ts > lastLogTs!) : logs;
      if (fresh.length > 0) {
        lastLogTs = logs[0]!.ts;
        channel.send("logs", fresh);
      }
    };

    await tick();
    const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
    req.on("close", () => {
      clearInterval(interval);
      channel.close();
    });
  },
);

// Global recent-activity feed across all jobs — powers Overview + the Jobs list's console panel.
// Merges the main crawler's crawl_logs with Crawl (OCR)'s ocr_logs (a separate table, its own FK
// to ocr_jobs — see db/migrations/*ocr-logs.sql) so OCR activity is no longer invisible on the
// dashboard. Two independent bigint cursors (the two tables are separate BIGSERIAL sequences, IDs
// aren't comparable across them) — each entry is tagged with its `source` so the frontend can
// render them distinctly.
jobsRouter.get("/logs/stream", requireAuth, async (req, res) => {
  const channel = new SseChannel(res);
  let lastLogId = 0n;
  let lastOcrLogId = 0n;

  const tick = async (): Promise<void> => {
    const [logs, ocrLogs] = await Promise.all([listRecentLogs(50), listRecentOcrLogs(50)]);
    const freshCrawl = logs.filter((l) => BigInt(l.id) > lastLogId);
    const freshOcr = ocrLogs.filter((l) => BigInt(l.id) > lastOcrLogId);
    if (freshCrawl.length > 0) lastLogId = BigInt(freshCrawl[0]!.id);
    if (freshOcr.length > 0) lastOcrLogId = BigInt(freshOcr[0]!.id);

    const fresh = [
      ...freshCrawl.map((l) => ({ ...l, source: "crawl" as const })),
      ...freshOcr.map((l) => ({ ...l, source: "ocr" as const })),
    ].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    if (fresh.length > 0) channel.send("logs", fresh);
  };

  await tick();
  const interval = setInterval(() => void tick(), POLL_INTERVAL_MS);
  req.on("close", () => {
    clearInterval(interval);
    channel.close();
  });
});
