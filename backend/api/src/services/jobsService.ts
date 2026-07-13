/** Authored by: Mohit Singh */
import { geocode } from "../lib/geocode.js";
import {
  createCrawlJob,
  notifyCrawlJobs,
  requestCancel,
  requestPause,
  requestResume,
  retryCrawlJob,
} from "../db/crawlJobs.js";
import { NotFoundError } from "../errors.js";
import type { CrawlJob } from "../types/db.js";
import type { CreateJobInput } from "../schemas/jobs.js";

export async function createJob(createdBy: string, input: CreateJobInput): Promise<CrawlJob> {
  let centerLat = input.centerLat;
  let centerLng = input.centerLng;
  let locationLabel = input.location ?? null;

  if (centerLat === undefined || centerLng === undefined) {
    const result = await geocode(input.location as string);
    centerLat = result.lat;
    centerLng = result.lng;
    locationLabel = locationLabel ?? result.displayName;
  }

  const job = await createCrawlJob({
    createdBy,
    businessType: input.businessType,
    locationLabel,
    centerLat,
    centerLng,
    radiusKm: input.radiusKm,
  });
  await notifyCrawlJobs(job.id);
  return job;
}

export async function pauseJob(id: string): Promise<CrawlJob> {
  const job = await requestPause(id);
  if (!job) throw new NotFoundError("Job not found or not in a pausable state");
  return job;
}

export async function resumeJob(id: string): Promise<CrawlJob> {
  const job = await requestResume(id);
  if (!job) throw new NotFoundError("Job not found or not paused");
  await notifyCrawlJobs(id);
  return job;
}

export async function cancelJob(id: string): Promise<CrawlJob> {
  const job = await requestCancel(id);
  if (!job) throw new NotFoundError("Job not found or not in a cancellable state");
  return job;
}

export async function retryJob(id: string): Promise<CrawlJob> {
  const job = await retryCrawlJob(id);
  if (!job) throw new NotFoundError("Job not found or not in a retryable (terminal) state");
  await notifyCrawlJobs(id);
  return job;
}
