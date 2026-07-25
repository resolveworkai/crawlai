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
  updated_at: string;
}

export interface OverviewStats {
  totalBusinesses: number;
  crawlsThisWeek: number;
  aiExtractionsCount: number;
  activeJobsCount: number;
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
