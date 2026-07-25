/** Authored by: Mohit Singh */
//
// Crawl-OCR API surface (§6). Node owns creation + reads; the Python worker (ocr/pipeline.py)
// does the capture+OCR. requireAuth per-route.
//
// Queueing: a new job is never rejected — it's created 'queued' and the worker's
// claim_pending_ocr_job() (oldest-created first, FOR UPDATE SKIP LOCKED) auto-runs it once
// whatever's ahead finishes. Only ACTUALLY RUNNING work (capturing/ocr/parsing — an open
// Chromium session against Maps) is still capped at one at a time (DB partial unique index
// ux_ocr_jobs_single_running is the hard guarantee) — deliberately sequential, never concurrent
// Maps automation, to avoid compounding detection/ToS risk.
import { Router } from "express";
import path from "node:path";
import { rm } from "node:fs/promises";
import { requireAuth, requireRole } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  createOcrJobSchema,
  ocrExportQuerySchema,
  ocrJobIdParamsSchema,
  type CreateOcrJobInput,
} from "../schemas/ocrCrawl.js";
import {
  countQueuedOcrJobs,
  createOcrJob,
  deleteOcrJob,
  findOcrJobById,
  listOcrJobs,
  notifyOcrJobs,
} from "../db/ocrJobs.js";
import { listOcrBusinesses } from "../db/ocrBusinesses.js";
import { getCrawlSettings } from "../db/crawlSettings.js";
import { buildOcrExport } from "../services/ocrExportService.js";
import { config } from "../config.js";
import { NotFoundError, ValidationError } from "../errors.js";

export const ocrCrawlRouter = Router();

ocrCrawlRouter.post(
  "/ocr-crawl/jobs",
  requireAuth,
  requireRole("operator"),
  validate(createOcrJobSchema),
  async (req, res) => {
    const input = req.body as CreateOcrJobInput;
    const { ocr_max_results: ocrMaxResults } = await getCrawlSettings();
    if (input.maxResults > ocrMaxResults) {
      throw new ValidationError(
        `maxResults exceeds the configured limit (${ocrMaxResults}) — raise "OCR max results" in Settings`,
      );
    }
    // Position BEFORE this job's own insert — how many are already queued ahead of it.
    const queuedAhead = await countQueuedOcrJobs();
    const job = await createOcrJob({
      createdBy: req.user!.id,
      query: input.query,
      location: input.location,
      maxResults: input.maxResults,
      expandHours: input.expandHours,
      langs: input.langs,
      centerLat: input.centerLat,
      centerLng: input.centerLng,
      radiusKm: input.radiusKm,
    });
    await notifyOcrJobs(job.id);
    res.status(201).json({ job, queuePosition: queuedAhead });
  },
);

ocrCrawlRouter.get("/ocr-crawl/jobs", requireAuth, async (_req, res) => {
  const jobs = await listOcrJobs();
  res.json({ jobs });
});

ocrCrawlRouter.get(
  "/ocr-crawl/jobs/:id",
  requireAuth,
  validate(ocrJobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await findOcrJobById(req.params.id as string);
    if (!job) throw new NotFoundError("OCR job not found");
    res.json({
      job,
      progress: {
        total: job.total_count,
        captured: job.captured_count,
        ocrDone: job.ocr_done_count,
      },
    });
  },
);

ocrCrawlRouter.get(
  "/ocr-crawl/jobs/:id/results",
  requireAuth,
  validate(ocrJobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await findOcrJobById(req.params.id as string);
    if (!job) throw new NotFoundError("OCR job not found");
    const businesses = await listOcrBusinesses(job.id);
    res.json({ businesses });
  },
);

ocrCrawlRouter.get(
  "/ocr-crawl/jobs/:id/export",
  requireAuth,
  validate(ocrJobIdParamsSchema, "params"),
  validate(ocrExportQuerySchema, "query"),
  async (req, res) => {
    const job = await findOcrJobById(req.params.id as string);
    if (!job) throw new NotFoundError("OCR job not found");
    const { format } = req.validatedQuery as unknown as { format: "csv" | "xlsx" };
    const file = await buildOcrExport(job.id, format);
    const safeQuery = job.query.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const filename = `ocr-crawl_${safeQuery}_${job.id.slice(0, 8)}.${file.extension}`;
    res.setHeader("Content-Type", file.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(file.buffer);
  },
);

// Serves a captured screenshot read-only for the results-table thumbnails, while the image still
// exists (retention purges old ones — a 404 then is expected). Path-traversal guarded: the
// resolved file must stay inside the job's own capture folder.
ocrCrawlRouter.get(
  // Express 5 (path-to-regexp v8) requires a NAMED wildcard — bare "*" throws at route setup.
  // `*splat` captures the remaining path segments as an array in req.params.splat.
  "/ocr-crawl/jobs/:id/images/*splat",
  requireAuth,
  async (req, res) => {
    const job = await findOcrJobById(req.params.id as string);
    if (!job || !job.storage_dir) throw new NotFoundError("OCR job not found");
    const splat = (req.params as Record<string, string | string[]>).splat;
    const rel = Array.isArray(splat) ? splat.join("/") : String(splat ?? "");
    const jobRoot = path.resolve(config.OCR_CAPTURES_DIR, job.storage_dir);
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

ocrCrawlRouter.delete(
  "/ocr-crawl/jobs/:id",
  requireAuth,
  requireRole("operator"),
  validate(ocrJobIdParamsSchema, "params"),
  async (req, res) => {
    const job = await deleteOcrJob(req.params.id as string);
    if (!job) throw new NotFoundError("OCR job not found");
    if (job.storage_dir) {
      const jobRoot = path.resolve(config.OCR_CAPTURES_DIR, job.storage_dir);
      await rm(jobRoot, { recursive: true, force: true }).catch(() => undefined);
    }
    res.status(204).send();
  },
);
