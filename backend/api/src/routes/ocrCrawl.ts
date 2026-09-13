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
  ocrJobBusinessParamsSchema,
  ocrJobIdParamsSchema,
  type CreateOcrJobInput,
} from "../schemas/ocrCrawl.js";
import {
  countQueuedOcrJobs,
  createOcrJob,
  deleteOcrJob,
  findOcrJobById,
  listOcrJobs,
  MAX_OCR_RETRIES,
  notifyOcrJobs,
  retryOcrJob,
} from "../db/ocrJobs.js";
import { deleteOcrBusinessesForJob, listOcrBusinesses } from "../db/ocrBusinesses.js";
import { getCrawlSettings } from "../db/crawlSettings.js";
import { buildOcrExport, buildOcrExportForBusiness } from "../services/ocrExportService.js";
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

// Every job is retryable (2026-09-12 — was failed/blocked only), with two different behaviors
// depending on the job's status when Retry is clicked:
//   - failed/blocked: RESUME — picks up from wherever the prior attempt left off (pipeline.py
//     finds its own manifest.json still on disk and skips already-captured businesses).
//   - ready: REFRESH — a completed job's manifest is already fully done, so a plain "resume"
//     would just find everything already there and finish instantly without capturing anything
//     new. Instead this deletes the on-disk manifest + every existing ocr_businesses row for the
//     job FIRST, so the worker walks fresh and re-captures/re-OCRs from scratch — the fresh
//     results then land at the SAME (job_id, idx) via insert_ocr_business's ON CONFLICT DO
//     UPDATE, genuinely overwriting the old data rather than sitting duplicated alongside it.
// Capped at MAX_OCR_RETRIES — past that the job stays in its terminal state, but whatever WAS
// captured across all attempts remains in ocr_businesses and stays viewable/exportable (the
// /results and /export routes below don't gate on job status).
ocrCrawlRouter.post(
  "/ocr-crawl/jobs/:id/retry",
  requireAuth,
  requireRole("operator"),
  validate(ocrJobIdParamsSchema, "params"),
  async (req, res) => {
    const existing = await findOcrJobById(req.params.id as string);
    if (!existing) throw new NotFoundError("OCR job not found");
    if (!["failed", "blocked", "ready"].includes(existing.status)) {
      throw new ValidationError(
        `Can't retry a job that's still running (this job is ${existing.status})`,
      );
    }
    if (existing.retry_count >= MAX_OCR_RETRIES) {
      throw new ValidationError(
        `Max retries (${MAX_OCR_RETRIES}) reached — the ${existing.captured_count} businesses already captured are still available to view/export`,
      );
    }
    if (existing.status === "ready" && existing.storage_dir) {
      const manifestPath = path.resolve(
        config.OCR_CAPTURES_DIR,
        existing.storage_dir,
        "manifest.json",
      );
      await rm(manifestPath, { force: true });
      await deleteOcrBusinessesForJob(existing.id);
    }
    // Captured BEFORE the retry's own UPDATE flips this job to 'queued' too, so it reflects jobs
    // genuinely ahead of it (same ordering as the create-job handler above).
    const queuedAhead = await countQueuedOcrJobs();
    const job = await retryOcrJob(existing.id);
    if (!job) throw new ValidationError("Could not retry — the job's state changed, try again");
    await notifyOcrJobs(job.id);
    res.status(200).json({ job, queuePosition: queuedAhead });
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

// Row-level export — the per-row "Export" button in the results table, same CSV/XLSX shape as
// the whole-job export above but scoped to one business (see ocrExportService's shared
// buildFromRows so the two can never format differently).
ocrCrawlRouter.get(
  "/ocr-crawl/jobs/:id/businesses/:businessId/export",
  requireAuth,
  validate(ocrJobBusinessParamsSchema, "params"),
  validate(ocrExportQuerySchema, "query"),
  async (req, res) => {
    const job = await findOcrJobById(req.params.id as string);
    if (!job) throw new NotFoundError("OCR job not found");
    const { format } = req.validatedQuery as unknown as { format: "csv" | "xlsx" };
    const file = await buildOcrExportForBusiness(
      job.id,
      req.params.businessId as string,
      format,
    );
    const safeQuery = job.query.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    const filename = `ocr-business_${safeQuery}_${req.params.businessId!.slice(0, 8)}.${file.extension}`;
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
