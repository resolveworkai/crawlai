/** Authored by: Mohit Singh */
//
// Row types mirroring db/migrations/*.sql exactly. This is the Node-side half of the shared
// schema contract — backend/worker's pydantic models (business_scout_worker/models.py) mirror
// the same tables independently in Python. Neither runtime imports the other's types; the
// database schema is the only shared contract (see .claude/skills/skills_db.md).

export type AppRole = "admin" | "operator" | "viewer";

export type JobStatus =
  "pending" | "discovering" | "crawling" | "paused" | "completed" | "failed" | "cancelled";

export type LogLevel = "info" | "warn" | "error" | "debug";

export type EnrichmentStatus = "queued" | "crawling" | "enriched" | "failed";

export type DynamicFieldType = "text" | "number" | "boolean" | "list" | "url";

export type ExportFormat = "xlsx" | "csv" | "json";

export interface User {
  id: string;
  email: string;
  password_hash: string;
  full_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserRole {
  id: string;
  user_id: string;
  role: AppRole;
  created_at: Date;
}

export interface CrawlJob {
  id: string;
  created_by: string;
  business_type: string;
  location_label: string | null;
  center_lat: number;
  center_lng: number;
  radius_km: string; // numeric(6,2) — pg returns as string; parse at the call site if needed
  status: JobStatus;
  cancel_requested: boolean;
  pause_requested: boolean;
  found_count: number;
  crawled_count: number;
  website_crawled_count: number;
  failed_count: number;
  current_business: string | null;
  error_message: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CrawlLog {
  id: string; // bigserial — pg returns as string
  job_id: string;
  level: LogLevel;
  message: string;
  ts: Date;
}

export interface Business {
  id: string;
  created_by: string | null;
  crawl_job_id: string | null;
  name: string;
  sub_name: string | null;
  category: string | null;
  tags: string[] | null;
  description: string | null;
  google_map_name: string | null;
  google_map_url: string | null;
  osm_type: string | null;
  osm_id: string | null;
  latitude: number | null;
  longitude: number | null;
  website_url: string | null;
  website_title: string | null;
  meta_description: string | null;
  meta_keywords: string | null;
  about_text: string | null;
  contact_url: string | null;
  email: string | null;
  emails: string[] | null;
  phone: string | null;
  phones: string[] | null;
  whatsapp: string | null;
  facebook: string | null;
  instagram: string | null;
  linkedin: string | null;
  youtube: string | null;
  twitter: string | null;
  address_line1: string | null;
  address_line2: string | null;
  area: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postal_code: string | null;
  google_rating: string | null;
  review_count: number | null;
  review_url: string | null;
  business_status: string | null;
  opening_date: string | null;
  claimed: boolean | null;
  price_level: string | null;
  google_enriched_at: Date | null;
  opening_hours: Record<string, unknown> | null;
  logo_url: string | null;
  cover_image_url: string | null;
  hero_image_url: string | null;
  ai_summary: string | null;
  services: string[] | null;
  products: string[] | null;
  amenities: string[] | null;
  keywords: string[] | null;
  languages: string[] | null;
  target_audience: string | null;
  industry: string | null;
  owner_name: string | null;
  manager_name: string | null;
  reception_number: string | null;
  support_email: string | null;
  sales_email: string | null;
  general_email: string | null;
  ssl_enabled: boolean | null;
  cms: string | null;
  hosting_provider: string | null;
  google_analytics: boolean | null;
  facebook_pixel: boolean | null;
  enrichment_status: EnrichmentStatus;
  // Phase 8 observability — which tier actually supplied the contact data (null until
  // enriched at least once, or when the site had no working Tier-1 fetch at all). Powers the
  // "tier-hit ratio" system metric. See db/migrations/*system-metrics-and-tier.sql.
  enrichment_tier: "tier1" | "tier2" | null;
  extras: Record<string, unknown>;
  // Fuzzy secondary dedup (Phase 4, worker's dedupe.py) — non-null means this row was merged
  // into another (better-known) business row and should be excluded from public listings.
  // Never deleted, so this is fully reversible by nulling the column.
  merged_into_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface BusinessImage {
  id: string;
  business_id: string;
  kind: string;
  url: string;
  created_at: Date;
}

export interface DynamicField {
  id: string;
  created_by: string | null;
  key: string;
  label: string;
  prompt: string;
  field_type: DynamicFieldType;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

// Global singleton row (id is always 1) — see db/migrations crawl-settings.sql.
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
  updated_at: Date;
}

export interface ExportRecord {
  id: string;
  created_by: string | null;
  format: ExportFormat;
  filename: string;
  row_count: number;
  size_bytes: string; // bigint — pg returns as string
  filter_snapshot: Record<string, unknown>;
  storage_path: string;
  created_at: Date;
  expires_at: Date | null;
}
