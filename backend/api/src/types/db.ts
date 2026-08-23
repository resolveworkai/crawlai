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

// Same shape as CrawlLog — a distinct table (own FK to ocr_jobs) so the two job types' logs never
// collide, merged only at read time by routes/jobs.ts's global /logs/stream.
export interface OcrLog {
  id: string;
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
  ocr_max_results: number;
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

// Crawl-OCR module (db/migrations/*ocr-crawl.sql). Parallel job type to CrawlJob, processed by
// the same Python worker daemon via a separate pg_notify channel.
export type OcrJobStatus =
  "queued" | "capturing" | "ocr" | "parsing" | "ready" | "failed" | "blocked";

export type OcrEndReason = "end_of_list" | "max_results" | "stagnation" | "blocked" | "error";

export interface OcrJob {
  id: string;
  created_by: string | null;
  query: string;
  location: string;
  center_lat: number | null;
  center_lng: number | null;
  radius_km: number | null;
  max_results: number;
  expand_hours: boolean;
  langs: string;
  status: OcrJobStatus;
  end_reason: OcrEndReason | null;
  total_count: number;
  captured_count: number;
  ocr_done_count: number;
  error_message: string | null;
  current_business: string | null;
  storage_dir: string | null;
  retry_count: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
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
  created_at: Date;
}

// --- Product Research / Ecom-Crawl module (db/migrations/*ecom-crawl.sql). SEPARATE from the
// Crawl-OCR (Google Maps) module above — own tables/pg_notify channel/worker package/API
// routes (see the migration's header comment). ---

export type EcomPlatform = "noon" | "amazon" | "aliexpress";

export type EcomSortMode = "rating_desc" | "price_asc" | "price_desc" | "relevance";

export type EcomJobStatus =
  "queued" | "capturing" | "ocr" | "parsing" | "detail" | "ready" | "failed" | "blocked";

export type EcomEndReason =
  "end_of_results" | "max_pages" | "max_products" | "stagnation" | "blocked" | "error";

export interface EcomScoreWeights {
  reviews?: number | undefined;
  rating?: number | undefined;
  demand?: number | undefined;
  value?: number | undefined;
}

export interface EcomJob {
  id: string;
  created_by: string | null;
  platform: EcomPlatform;
  query: string;
  sort_mode: EcomSortMode;
  max_pages: number;
  max_products: number;
  detail_scrape_top_n: number;
  score_weights: EcomScoreWeights | null;
  status: EcomJobStatus;
  end_reason: EcomEndReason | null;
  total_count: number;
  captured_count: number;
  ocr_done_count: number;
  detail_done_count: number;
  current_product: string | null;
  error_message: string | null;
  storage_dir: string | null;
  retry_count: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export type EcomExtractionSource = "dom" | "dom+ocr" | "ocr";

export interface EcomProduct {
  id: string;
  job_id: string;
  idx: number;
  page_num: number;
  title: string;
  product_url: string | null;
  image_url: string | null;
  price: number | null;
  list_price: number | null;
  currency: string;
  discount_pct: number | null;
  rating: number | null;
  review_count: number | null;
  bought_past_month: number | null;
  bought_past_month_raw: string | null;
  free_delivery: boolean;
  delivery_date: string | null;
  category: string | null;
  badges: string[];
  rank_in_category: number | null;
  sponsored: boolean;
  opportunity_score: number | null;
  extraction_source: EcomExtractionSource;
  ocr_confidence: number | null;
  needs_review: boolean;
  raw_text: string | null;
  source_images: string[];
  description: string | null;
  about_bullets: string[];
  breadcrumb_category: string | null;
  seller_name: string | null;
  detail_scraped: boolean;
  created_at: Date;
}

// --- Property Research module (db/migrations/1785300000000_property-crawl.sql) — a THIRD,
// deliberately separate job type: own tables, own worker package (property/), own API routes,
// own frontend route. Every supported platform (dubizzle, propertyfinder) requires CDP, so there
// is no container-daemon claim branch or pg_notify channel — only the host runner
// (run_property_host.py) polls for queued jobs. ---

export type PropertyPlatform = "dubizzle" | "propertyfinder";

export type PropertyType = "apartment" | "villa" | "townhouse" | "penthouse" | "studio";

export type PropertyPurpose = "buy" | "rent";

export type PropertyJobStatus =
  "queued" | "capturing" | "parsing" | "detail" | "scoring" | "ready" | "failed" | "blocked";

export type PropertyEndReason =
  "end_of_results" | "max_pages" | "max_listings" | "stagnation" | "blocked" | "error";

// No confirmed server-side URL param for either platform (see the worker's capture.py) — enforced
// client-side against each listing's own is_offplan flag. Defaults to "ready" (confirmed
// preference).
export type PropertyStatus = "ready" | "offplan" | "any";

export interface PropertyScoreWeights {
  value?: number | undefined;
  keywords?: number | undefined;
  freshness?: number | undefined;
  verified?: number | undefined;
}

export interface PropertyJob {
  id: string;
  created_by: string | null;
  platform: PropertyPlatform;
  location: string;
  bedrooms: number | null;
  bathrooms: number | null;
  property_type: PropertyType;
  purpose: PropertyPurpose;
  property_status: PropertyStatus;
  max_pages: number;
  max_listings: number;
  detail_scrape_top_n: number;
  whatsapp_message_template: string | null;
  score_weights: PropertyScoreWeights | null;
  status: PropertyJobStatus;
  end_reason: PropertyEndReason | null;
  total_count: number;
  captured_count: number;
  detail_done_count: number;
  current_listing: string | null;
  error_message: string | null;
  storage_dir: string | null;
  retry_count: number;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export type PropertyExtractionSource = "dom" | "dom+ocr" | "ocr";

export interface PropertyListing {
  id: string;
  job_id: string;
  idx: number;
  page_num: number;
  title: string;
  listing_url: string | null;
  // The SITE's own photo URLs — links only, never downloaded/proxied.
  image_urls: string[];
  // NUMERIC(14,2)/NUMERIC(10,2) columns — pg returns these as strings (no custom type parser
  // registered), same convention as EcomProduct.price above. Parse with Number(...) at render
  // time.
  price: string | null;
  currency: string | null;
  area_sqft: string | null;
  price_per_sqft: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  property_type: string | null;
  location_text: string | null;
  community: string | null;
  listed_days_ago: number | null;
  verified: boolean;
  badges: string[];
  // Confirmed live 2026-08-22 (dubizzle) — a card's own offplan-badge presence.
  is_offplan: boolean;
  distress_keywords: string[];
  agent_name: string | null;
  // Only populated for the job's detail_scrape_top_n highest-scoring listings.
  phone_number: string | null;
  whatsapp_link: string | null;
  description: string | null;
  // Detail-page-only, same scope as phone_number above (confirmed live 2026-08-22 — dubizzle's
  // own "Property Age"/"Average Rent" fields). average_rent is NUMERIC(12,2) — pg returns it as a
  // string, same convention as price/area_sqft above.
  age_years: number | null;
  average_rent: string | null;
  // Detail-page-only, dubizzle's own "posted-on" field — raw text (e.g. "4th June 2026"), not
  // parsed into a date.
  listed_date: string | null;
  distress_score: number | null;
  extraction_source: PropertyExtractionSource;
  ocr_confidence: number | null;
  needs_review: boolean;
  raw_text: string | null;
  source_images: string[];
  detail_scraped: boolean;
  created_at: Date;
}

// A save-for-later SNAPSHOT of one listing (see db/migrations/1785600000000_property-wishlist.sql
// for why this isn't a live FK to PropertyListing) — same string-vs-number NUMERIC-column
// convention as PropertyListing above.
export interface PropertyWishlistItem {
  id: string;
  created_by: string | null;
  source_listing_id: string | null;
  platform: PropertyPlatform;
  title: string;
  listing_url: string | null;
  image_url: string | null;
  price: string | null;
  currency: string | null;
  area_sqft: string | null;
  price_per_sqft: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  property_type: string | null;
  location_text: string | null;
  community: string | null;
  is_offplan: boolean;
  age_years: number | null;
  average_rent: string | null;
  listed_date: string | null;
  distress_score: number | null;
  notes: string | null;
  created_at: Date;
}

export type PropertyListingRefreshStatus = "queued" | "running" | "done" | "failed";

// Mirrors property_listing_refreshes (db/migrations/1785700000000_property-listing-refreshes.sql)
// — the per-row "Refresh" button's request/result. old_price/new_price together are the audit
// trail a manual refresh's own price-drop highlight is computed from.
export interface PropertyListingRefresh {
  id: string;
  listing_id: string;
  listing_url: string;
  platform: PropertyPlatform;
  status: PropertyListingRefreshStatus;
  old_price: string | null;
  new_price: string | null;
  error_message: string | null;
  requested_at: Date;
  completed_at: Date | null;
}

// A PropertyListing enriched, at read-time, with the previous price the SAME listing_url was seen
// at in an EARLIER job's capture (any day) — the cross-job/day price-drop signal (see
// db/propertyListings.ts's listPropertyListingsWithPriceHistory). Distinct from
// PropertyListingRefresh above, which is the same signal but for a manual, single-row refresh.
export interface PropertyListingWithHistory extends PropertyListing {
  previous_price: string | null;
  price_dropped: boolean;
  latest_refresh: PropertyListingRefresh | null;
}

// --- Marketing / Messaging (see md/MARKETING.md + db/migrations/*marketing.sql) ---

export type MessageChannel = "whatsapp" | "email";
export type CampaignStatus = "draft" | "sending" | "completed" | "failed" | "cancelled";
export type RecipientStatus = "pending" | "sent" | "failed" | "skipped";
export type SuppressionReason = "unsubscribed" | "bounced" | "manual";

export interface EmailCredentials {
  id: 1;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_secure: boolean;
  smtp_user: string | null;
  smtp_password_encrypted: string | null; // AES-256-GCM envelope — NEVER sent to the client
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  org_address: string | null;
  verified: boolean;
  updated_at: Date;
}

export interface MessageTemplate {
  id: string;
  channel: MessageChannel;
  name: string;
  subject: string | null;
  body: string;
  business_type: string | null; // null = generic, shown for every business type
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MessageTemplateImage {
  id: string;
  template_id: string;
  cid: string;
  filename: string;
  mime: string;
  bytes: Buffer;
  is_inline: boolean; // true = cid-referenced inline image; false = a plain attachment (e.g. a PDF)
  created_at: Date;
}

export interface MarketingContact {
  id: string;
  business_name: string;
  business_type: string | null;
  location: string | null;
  phone: string | null;
  email: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface Campaign {
  id: string;
  channel: MessageChannel;
  template_id: string | null;
  subject: string | null;
  body: string;
  status: CampaignStatus;
  total_count: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  created_by: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface CampaignRecipient {
  id: string;
  campaign_id: string;
  business_name: string;
  business_type: string | null;
  location: string | null;
  phone: string | null;
  email: string | null;
  wa_link: string | null;
  status: RecipientStatus;
  error: string | null;
  sent_at: Date | null;
  created_at: Date;
}

export interface EmailSuppression {
  email: string;
  reason: SuppressionReason;
  created_at: Date;
}
