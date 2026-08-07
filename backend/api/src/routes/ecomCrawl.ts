/** Authored by: Mohit Singh */
//
// Product Research (Ecom-Crawl) API surface — mirrors routes/ocrCrawl.ts's shape/conventions.
// Node owns creation + reads; the Python worker (business_scout_worker/ecom/) does the
// capture+OCR+parse+score. requireAuth per-route.
//
// Queueing: a new job is never rejected — it's created 'queued' and the worker's claim loop
// (oldest-created first, FOR UPDATE SKIP LOCKED) auto-runs it once whatever's ahead finishes.
// Only ACTUALLY RUNNING work (capturing/ocr/parsing/detail — an open Chromium session) is still
// capped at one at a time (DB partial unique index ux_ecom_jobs_single_running is the hard
// guarantee) — deliberately sequential, same policy as the OCR module, and the worker daemon is
// sequential across job types too (one main.py, one browser session total).
import { Router } from "express";
import path from "node:path";
import { rm } from "node:fs/promises";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  createEcomJobSchema,
  ecomExportQuerySchema,
  ecomJobIdParamsSchema,
  type CreateEcomJobInput,
} from "../schemas/ecomCrawl.js";
import {
  countQueuedEcomJobs,
  createEcomJob,
  deleteEcomJob,
  findEcomJobById,
  listEcomJobs,
  MAX_ECOM_RETRIES,
  notifyEcomJobs,
  retryEcomJob,
} from "../db/ecomJobs.js";
import { listEcomProducts } from "../db/ecomProducts.js";
import { buildEcomExport } from "../services/ecomExportService.js";
import { buildEcomAnalysis } from "../services/ecomAnalysisService.js";
import { config } from "../config.js";
import { NotFoundError, ValidationError } from "../errors.js";

export const ecomCrawlRouter = Router();

ecomCrawlRouter.post(
  "/ecom-crawl/jobs",
  requireAuth,
  requireRole("operator"),
  validate(createEcomJobSchema),
  async (req, res) => {
    const input = req.body as CreateEcomJobInput;
    // Position BEFORE this job's own insert — how many are already queued ahead of it.
    const queuedAhead = await countQueuedEcomJobs();
    const job = await createEcomJob({
      createdBy: req.user!.id,
      platform: input.platform,
      query: input.query,
      sortMode: input.sortMode,
      maxPages: input.maxPages,
      maxProducts: input.maxProducts,
      detailScrapeTopN: input.detailScrapeTopN,
      scoreWeights: input.scoreWeights,
    });
    await notifyEcomJobs(job.id);
    res.status(201).json({ job, queuePosition: queuedAhead });
  },
);

// Resumable retry: picks up from wherever the prior attempt left off rather than starting over.
// Capped at MAX_ECOM_RETRIES — past that the job stays in its terminal failed/blocked state, but
// whatever WAS captured across all attempts remains in ecom_products and stays
// viewable/exportable (the /results, /analysis and /export routes below don't gate on job
// status).
ecomCrawlRouter.post(
  "/ecom-crawl/jobs/:id/retry",
  requireAuth,
  requireRole("operator"),
  validate(ecomJobIdParamsSchema, "params"),
  async (req, res) => {
    const existing = await findEcomJobById(req.params.id as string);
    if (!existing) throw new NotFoundError("Ecom job not found");
    if (existing.status !== "failed" && existing.status !== "blocked") {
      throw new ValidationError(
        `Only failed or blocked jobs can be retried (this job is ${existing.status})`,
      );
    }
    if (existing.retry_count >= MAX_ECOM_RETRIES) {
      throw new ValidationError(
        `Max retries (${MAX_ECOM_RETRIES}) reached — the ${existing.captured_count} products already captured are still available to view/export`,
      );
    }
    // Captured BEFORE the retry's own UPDATE flips this job to 'queued' too, so it reflects jobs
    // genuinely ahead of it (same ordering as the create-job handler above).
    const queuedAhead = await countQueuedEcomJobs();
    const job = await retryEcomJob(existing.id);
    if (!job) throw new ValidationError("Could not retry — the job's state changed, try again");
    await notifyEcomJobs(job.id);
    res.status(200).json({ job, queuePosition: queuedAhead });
  },
);

ecomCrawlRouter.get("/ecom-crawl/jobs", requireAuth, async (_req, res) => {
  const jobs = await listEcomJobs();
  res.json({ jobs });
});

ecomCrawlRouter.get(
  "/ecom-crawl/jobs/:id",
  requireAuth,
  validate(ecomJobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await findEcomJobById(req.params.id as string);
    if (!job) throw new NotFoundError("Ecom job not found");
    res.json({
      job,
      progress: {
        total: job.total_count,
        captured: job.captured_count,
        ocrDone: job.ocr_done_count,
        detailDone: job.detail_done_count,
      },
    });
  },
);

ecomCrawlRouter.get(
  "/ecom-crawl/jobs/:id/results",
  requireAuth,
  validate(ecomJobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await findEcomJobById(req.params.id as string);
    if (!job) throw new NotFoundError("Ecom job not found");
    const products = await listEcomProducts(job.id);
    res.json({ products });
  },
);

ecomCrawlRouter.get(
  "/ecom-crawl/jobs/:id/analysis",
  requireAuth,
  validate(ecomJobIdParamsSchema, "params"),
  async (req, res) => {
    const analysis = await buildEcomAnalysis(req.params.id as string);
    res.json({ analysis });
  },
);

ecomCrawlRouter.get(
  "/ecom-crawl/jobs/:id/export",
  requireAuth,
  validate(ecomJobIdParamsSchema, "params"),
  validate(ecomExportQuerySchema, "query"),
  async (req, res) => {
    const job = await findEcomJobById(req.params.id as string);
    if (!job) throw new NotFoundError("Ecom job not found");
    const { format } = req.validatedQuery as unknown as { format: "csv" | "xlsx" | "json" };
    const file = await buildEcomExport(job.id, format);
    const safeQuery = job.query.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const filename = `ecom-crawl_${job.platform}_${safeQuery}_${job.id.slice(0, 8)}.${file.extension}`;
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(file.buffer);
  },
);

// Serves a captured screenshot read-only for the results-table thumbnails, while the image still
// exists (retention purges old ones — a 404 then is expected). Path-traversal guarded: the
// resolved file must stay inside the job's own capture folder.
ecomCrawlRouter.get(
  // Express 5 (path-to-regexp v8) requires a NAMED wildcard — bare "*" throws at route setup.
  // `*splat` captures the remaining path segments as an array in req.params.splat.
  "/ecom-crawl/jobs/:id/images/*splat",
  requireAuth,
  async (req, res) => {
    const job = await findEcomJobById(req.params.id as string);
    if (!job || !job.storage_dir) throw new NotFoundError("Ecom job not found");
    const splat = (req.params as Record<string, string | string[]>).splat;
    const rel = Array.isArray(splat) ? splat.join("/") : String(splat ?? "");
    const jobRoot = path.resolve(config.ECOM_CAPTURES_DIR, job.storage_dir);
    const target = path.resolve(jobRoot, rel);
    if (!target.startsWith(jobRoot + path.sep)) {
      throw new ValidationError("Invalid image path");
    }
    res.sendFile(target, (err) => {
      if (err && !res.headersSent) {
        res
          .status(404)
          .json({
            error: { code: "NOT_FOUND", message: "Image not found (may have been purged)" },
          });
      }
    });
  },
);

ecomCrawlRouter.delete(
  "/ecom-crawl/jobs/:id",
  requireAuth,
  requireRole("operator"),
  validate(ecomJobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await deleteEcomJob(req.params.id as string);
    if (!job) throw new NotFoundError("Ecom job not found");
    if (job.storage_dir) {
      const jobRoot = path.resolve(config.ECOM_CAPTURES_DIR, job.storage_dir);
      await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    res.status(204).send();
  },
);
