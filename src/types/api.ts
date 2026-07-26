/** Authored by: Mohit Singh */
//
// Types mirroring backend/api's response shapes. Not a shared package (yet) — see
// md/plans/0001-*.md's "packages/shared-types" note; kept as lightweight local interfaces
// for now rather than adding cross-package build complexity before it's needed.

export type AppRole = "admin" | "operator" | "viewer";

export interface AuthenticatedUser {
  id: string;
  email: string;
  fullName: string | null;
  roles: AppRole[];
}

export type JobStatus =
  "pending" | "discovering" | "crawling" | "paused" | "completed" | "failed" | "cancelled";

export interface CrawlJob {
  id: string;
  created_by: string;
  business_type: string;
  location_label: string | null;
  center_lat: number;
  center_lng: number;
  radius_km: string;
  status: JobStatus;
  cancel_requested: boolean;
  pause_requested: boolean;
  found_count: number;
  crawled_count: number;
  website_crawled_count: number;
  failed_count: number;
  current_business: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CrawlLog {
  id: string;
  job_id: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
  ts: string;
  // The global /logs/stream SSE merges the main crawler's crawl_logs with Crawl (OCR)'s
  // ocr_logs — this tags which one a given entry came from so the dashboard can render them
  // distinctly. Optional only for backward-compat with any code still using this type without
  // the merge (every entry the live stream sends now always carries it).
  source?: "crawl" | "ocr";
}

export type EnrichmentStatus = "queued" | "crawling" | "enriched" | "failed";

export interface Business {
  id: string;
  name: string;
  sub_name: string | null;
  category: string | null;
  city: string | null;
  email: string | null;
  phone: string | null;
  website_url: string | null;
  google_rating: string | null;
  review_count: number | null;
  enrichment_status: EnrichmentStatus;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

export type DynamicFieldType = "text" | "number" | "boolean" | "list" | "url";

export interface DynamicField {
  id: string;
  key: string;
  label: string;
  prompt: string;
  field_type: DynamicFieldType;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface CrawlSettings {
  id: 1;
  concurrency: number;
  retry_count: number;
  timeout_ms: number;
  user_agent: string;
  map_provider: string;
  discovery_source: string;
  max_businesses_per_job: number;
  crawl_website: boolean;
  respect_robots_txt: boolean;
  follow_sitemaps: boolean;
  request_delay_ms: number;
  use_ai_extraction: boolean;
  proxy_url: string | null;
  ocr_max_results: number;
  updated_at: string;
}

export interface OverviewStats {
  totalBusinesses: number;
  crawlsThisWeek: number;
  aiExtractionsCount: number;
  activeJobsCount: number;
  // Crawl (OCR) — a separate parallel job type, kept distinct from the counts above.
  ocrBusinessesCount: number;
  ocrJobsThisWeek: number;
  ocrActiveJobsCount: number;
}

export interface TrendPoint {
  day: string;
  discovered: number;
  enriched: number;
}

export interface OverviewResponse {
  stats: OverviewStats;
  trend: TrendPoint[];
  recentJobs: CrawlJob[];
  recentlyEnriched: Business[];
}

export interface GeocodeResult {
  lat: number;
  lng: number;
  displayName: string;
}

export type OcrJobStatus =
  "queued" | "capturing" | "ocr" | "parsing" | "ready" | "failed" | "blocked";

export interface OcrJob {
  id: string;
  query: string;
  location: string;
  center_lat: number | null;
  center_lng: number | null;
  radius_km: number | null;
  max_results: number;
  expand_hours: boolean;
  langs: string;
  status: OcrJobStatus;
  end_reason: string | null;
  total_count: number;
  captured_count: number;
  ocr_done_count: number;
  error_message: string | null;
  // Live "what is being worked on right now" — powers the status line so a stalled counter is
  // distinguishable from a hung job. Set by the worker on every item.
  current_business: string | null;
  storage_dir: string | null;
  // Resumable retry (see hooks/useOcrCrawl.ts's useRetryOcrJob) — capped server-side at 3.
  retry_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface OcrBusiness {
  id: string;
  job_id: string;
  idx: number;
  name: string;
  maps_url: string | null;
  rating: number | null;
  review_count: number | null;
  category: string | null;
  address: string | null;
  phone: string | null;
  website: string | null;
  plus_code: string | null;
  hours_summary: string | null;
  hours_weekly: Record<string, unknown> | null;
  email: string | null;
  image_url: string | null;
  lat: number | null;
  lng: number | null;
  distance_km: number | null;
  ocr_confidence: number | null;
  needs_review: boolean;
  raw_text: string | null;
  source_images: string[];
  created_at: string;
}

export type ExportFormat = "xlsx" | "csv" | "json";

export interface ExportRecord {
  id: string;
  created_by: string | null;
  format: ExportFormat;
  filename: string;
  row_count: number;
  size_bytes: string;
  filter_snapshot: Record<string, unknown>;
  storage_path: string;
  created_at: string;
  expires_at: string | null;
}
