/** Authored by: Mohit Singh */
//
// Recurring-search tick — see db/propertyJobSchedules.ts's header for the full design. Called on
// a fixed interval from server.ts (same boot + fixed-interval pattern as the export/OCR retention
// sweeps in that file — no external cron dependency needed for a single-box deploy).
import { logger } from "../logger.js";
import {
  listDuePropertyJobSchedules,
  markPropertyJobScheduleRun,
} from "../db/propertyJobSchedules.js";
import { createPropertyJob } from "../db/propertyJobs.js";

// Guards against a slow tick still running when the next interval fires — this deploy is a single
// Node process with one setInterval timer, so this in-process flag is the whole concurrency story
// (no DB-level lock needed, see listDuePropertyJobSchedules's own comment).
let running = false;

export async function runDuePropertySchedules(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const due = await listDuePropertyJobSchedules();
    for (const schedule of due) {
      try {
        const job = await createPropertyJob({
          createdBy: schedule.created_by,
          platform: schedule.platform,
          location: schedule.location,
          bedrooms: schedule.bedrooms ?? undefined,
          bathrooms: schedule.bathrooms ?? undefined,
          propertyType: schedule.property_type,
          purpose: schedule.purpose,
          propertyStatus: schedule.property_status,
          sortOrder: schedule.sort_order,
          maxPages: schedule.max_pages,
          maxListings: schedule.max_listings,
          detailScrapeTopN: schedule.detail_scrape_top_n,
          whatsappMessageTemplate: schedule.whatsapp_message_template ?? undefined,
          scoreWeights: schedule.score_weights ?? undefined,
        });
        // Written BEFORE the loop continues to the next schedule — if the process crashes right
        // after creating the job but before this write, the schedule's next_run_at stays in the
        // past and it fires again next tick, which just means an extra (harmless, resumable) job
        // rather than a schedule silently going stale forever.
        await markPropertyJobScheduleRun(schedule.id, job.id, schedule.interval_hours);
        logger.info(
          { scheduleId: schedule.id, jobId: job.id, platform: schedule.platform },
          "property schedule fired",
        );
      } catch (err: unknown) {
        // One bad schedule (e.g. a transient DB error) must not stop the rest from firing, and
        // must not spin — mark it run anyway so it retries next interval instead of every tick.
        logger.error({ err, scheduleId: schedule.id }, "property schedule failed to fire");
        await markPropertyJobScheduleRun(schedule.id, null, schedule.interval_hours).catch(
          () => undefined,
        );
      }
    }
  } finally {
    running = false;
  }
}
