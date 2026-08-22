/** Authored by: Mohit Singh */
//
// Property Research (Property-Crawl) API surface — mirrors routes/ecomCrawl.ts's shape/
// conventions. Node owns creation + reads; the Python host runner
// (business_scout_worker/property/, run_property_host.py) does the capture+OCR+parse+score+
// detail work. requireAuth per-route.
//
// Queueing: a new job is never rejected — it's created 'queued' and the host runner's poll loop
// picks it up. UNLIKE ecom, there is no pg_notify wake here at all (see db/propertyJobs.ts's
// createPropertyJob comment) — every property platform requires CDP, so there is no container
// daemon to notify; the host runner discovers a new queued job within its own poll interval
// (PROPERTY_HOST_POLL_SECONDS, default 15s). Only ACTUALLY RUNNING work (capturing/parsing/
// detail/scoring — an open Chromium session) is capped at one at a time (DB partial unique index
// ux_property_jobs_single_running is the hard guarantee).
import { Router } from "express";
import path from "node:path";
import { rm } from "node:fs/promises";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  createPropertyJobSchema,
  propertyExportQuerySchema,
  propertyJobIdParamsSchema,
  type CreatePropertyJobInput,
} from "../schemas/propertyCrawl.js";
import {
  countQueuedPropertyJobs,
  createPropertyJob,
  deletePropertyJob,
  findPropertyJobById,
  listPropertyJobs,
  MAX_PROPERTY_RETRIES,
  retryPropertyJob,
} from "../db/propertyJobs.js";
import { listPropertyListings } from "../db/propertyListings.js";
import { buildPropertyExport } from "../services/propertyExportService.js";
import { buildPropertyAnalysis } from "../services/propertyAnalysisService.js";
import { config } from "../config.js";
import { NotFoundError, ValidationError } from "../errors.js";

export const propertyCrawlRouter = Router();

propertyCrawlRouter.post(
  "/property-crawl/jobs",
  requireAuth,
  requireRole("operator"),
  validate(createPropertyJobSchema),
  async (req, res) => {
    const input = req.body as CreatePropertyJobInput;
    // Position BEFORE this job's own insert — how many are already queued ahead of it.
    const queuedAhead = await countQueuedPropertyJobs();
    const job = await createPropertyJob({
      createdBy: req.user!.id,
      platform: input.platform,
      location: input.location,
      bedrooms: input.bedrooms,
      bathrooms: input.bathrooms,
      propertyType: input.propertyType,
      purpose: input.purpose,
      propertyStatus: input.propertyStatus,
      maxPages: input.maxPages,
      maxListings: input.maxListings,
      detailScrapeTopN: input.detailScrapeTopN,
      whatsappMessageTemplate: input.whatsappMessageTemplate,
      scoreWeights: input.scoreWeights,
    });
    res.status(201).json({ job, queuePosition: queuedAhead });
  },
);

// Resumable retry: picks up from wherever the prior attempt left off rather than starting over.
// Capped at MAX_PROPERTY_RETRIES — past that the job stays in its terminal failed/blocked state,
// but whatever WAS captured across all attempts remains in property_listings and stays
// viewable/exportable (the /results, /analysis and /export routes below don't gate on job
// status).
propertyCrawlRouter.post(
  "/property-crawl/jobs/:id/retry",
  requireAuth,
  requireRole("operator"),
  validate(propertyJobIdParamsSchema, "params"),
  async (req, res) => {
    const existing = await findPropertyJobById(req.params.id as string);
    if (!existing) throw new NotFoundError("Property job not found");
    if (existing.status !== "failed" && existing.status !== "blocked") {
      throw new ValidationError(
        `Only failed or blocked jobs can be retried (this job is ${existing.status})`,
      );
    }
    if (existing.retry_count >= MAX_PROPERTY_RETRIES) {
      throw new ValidationError(
        `Max retries (${MAX_PROPERTY_RETRIES}) reached — the ${existing.captured_count} listings already captured are still available to view/export`,
      );
    }
    // Captured BEFORE the retry's own UPDATE flips this job to 'queued' too, so it reflects jobs
    // genuinely ahead of it (same ordering as the create-job handler above).
    const queuedAhead = await countQueuedPropertyJobs();
    const job = await retryPropertyJob(existing.id);
    if (!job) throw new ValidationError("Could not retry — the job's state changed, try again");
    res.status(200).json({ job, queuePosition: queuedAhead });
  },
);

propertyCrawlRouter.get("/property-crawl/jobs", requireAuth, async (_req, res) => {
  const jobs = await listPropertyJobs();
  res.json({ jobs });
});

propertyCrawlRouter.get(
  "/property-crawl/jobs/:id",
  requireAuth,
  validate(propertyJobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await findPropertyJobById(req.params.id as string);
    if (!job) throw new NotFoundError("Property job not found");
    res.json({
      job,
      progress: {
        total: job.total_count,
        captured: job.captured_count,
        detailDone: job.detail_done_count,
      },
    });
  },
);

propertyCrawlRouter.get(
  "/property-crawl/jobs/:id/results",
  requireAuth,
  validate(propertyJobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await findPropertyJobById(req.params.id as string);
    if (!job) throw new NotFoundError("Property job not found");
    // Already ranked best-deal-first (distress_score desc) by listPropertyListings' ORDER BY.
    const listings = await listPropertyListings(job.id);
    res.json({ listings });
  },
);

propertyCrawlRouter.get(
  "/property-crawl/jobs/:id/analysis",
  requireAuth,
  validate(propertyJobIdParamsSchema, "params"),
  async (req, res) => {
    const analysis = await buildPropertyAnalysis(req.params.id as string);
    res.json({ analysis });
  },
);

propertyCrawlRouter.get(
  "/property-crawl/jobs/:id/export",
  requireAuth,
  validate(propertyJobIdParamsSchema, "params"),
  validate(propertyExportQuerySchema, "query"),
  async (req, res) => {
    const job = await findPropertyJobById(req.params.id as string);
    if (!job) throw new NotFoundError("Property job not found");
    const { format } = req.validatedQuery as unknown as { format: "csv" | "xlsx" | "json" };
    const file = await buildPropertyExport(job.id, format);
    const safeLocation = job.location.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const filename = `property-crawl_${job.platform}_${safeLocation}_${job.id.slice(0, 8)}.${file.extension}`;
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(file.buffer);
  },
);

// Serves a captured screenshot read-only for the results-table thumbnails, while the image still
// exists (retention purges old ones — a 404 then is expected). Path-traversal guarded: the
// resolved file must stay inside the job's own capture folder.
propertyCrawlRouter.get(
  // Express 5 (path-to-regexp v8) requires a NAMED wildcard — bare "*" throws at route setup.
  // `*splat` captures the remaining path segments as an array in req.params.splat.
  "/property-crawl/jobs/:id/images/*splat",
  requireAuth,
  async (req, res) => {
    const job = await findPropertyJobById(req.params.id as string);
    if (!job || !job.storage_dir) throw new NotFoundError("Property job not found");
    const splat = (req.params as Record<string, string | string[]>).splat;
    const rel = Array.isArray(splat) ? splat.join("/") : String(splat ?? "");
    const jobRoot = path.resolve(config.PROPERTY_CAPTURES_DIR, job.storage_dir);
    const target = path.resolve(jobRoot, rel);
    if (!target.startsWith(jobRoot + path.sep)) {
      throw new ValidationError("Invalid image path");
    }
    res.sendFile(target, (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({
          error: { code: "NOT_FOUND", message: "Image not found (may have been purged)" },
        });
      }
    });
  },
);

propertyCrawlRouter.delete(
  "/property-crawl/jobs/:id",
  requireAuth,
  requireRole("operator"),
  validate(propertyJobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await deletePropertyJob(req.params.id as string);
    if (!job) throw new NotFoundError("Property job not found");
    if (job.storage_dir) {
      const jobRoot = path.resolve(config.PROPERTY_CAPTURES_DIR, job.storage_dir);
      await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    res.status(204).send();
  },
);
