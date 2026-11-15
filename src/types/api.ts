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

// --- Product Research (Ecom-Crawl) module — SEPARATE from Crawl (OCR) above. Mirrors
// backend/api/src/types/db.ts's EcomJob/EcomProduct + services/ecomAnalysisService.ts's
// EcomAnalysis exactly. aliexpress is a valid platform value on existing rows but is NOT
// creatable from the frontend (see schemas/ecomCrawl.ts) — the worker's adapter is a stub. ---

export type EcomPlatform = "noon" | "amazon" | "amazon_in" | "aliexpress";

export type EcomSortMode = "rating_desc" | "price_asc" | "price_desc" | "relevance";

export type EcomJobStatus =
  "queued" | "capturing" | "ocr" | "parsing" | "detail" | "ready" | "failed" | "blocked";

export type EcomEndReason =
  "end_of_results" | "max_pages" | "max_products" | "stagnation" | "blocked" | "error";

export interface EcomScoreWeights {
  reviews?: number;
  rating?: number;
  demand?: number;
  value?: number;
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
  // Live "what is it on right now" — mirrors OcrJob's current_business.
  current_product: string | null;
  error_message: string | null;
  storage_dir: string | null;
  // Resumable retry (see hooks/useEcomCrawl.ts's useRetryEcomJob) — capped server-side at 3.
  retry_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
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
  // NUMERIC(12,2) columns — pg returns these as strings (no custom type parser registered),
  // same convention as CrawlJob.radius_km above. Parse with Number(...) at render time.
  price: string | null;
  list_price: string | null;
  currency: string;
  // REAL columns — pg parses these to JS numbers by default.
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
  created_at: string;
}

export interface EcomAnalysisSummary {
  productCount: number;
  sponsoredCount: number;
  price: {
    min: number | null;
    max: number | null;
    p25: number | null;
    median: number | null;
    p75: number | null;
  };
  rating: { avg: number | null; median: number | null };
  reviews: { total: number | null; median: number | null };
  pctFreeDelivery: number | null;
  boughtPastMonth: { productsWithData: number; total: number | null };
}

export interface EcomRatingBucket {
  star: number;
  count: number;
}

export interface EcomBadgeFrequency {
  badge: string;
  count: number;
}

export interface EcomTopOpportunity {
  id: string;
  idx: number;
  title: string;
  price: number | null;
  rating: number | null;
  reviewCount: number | null;
  opportunityScore: number | null;
  imageUrl: string | null;
  productUrl: string | null;
}

export interface EcomAnalysis {
  jobId: string;
  summary: EcomAnalysisSummary;
  priceBands: { p25: number | null; median: number | null; p75: number | null };
  ratingDistribution: EcomRatingBucket[];
  badgeFrequency: EcomBadgeFrequency[];
  topOpportunities: EcomTopOpportunity[];
}

// --- Property Research (Property-Crawl) module — a THIRD, deliberately separate module (see
// routes/property-crawl.tsx's header). Mirrors backend/api/src/types/db.ts's PropertyJob/
// PropertyListing + services/propertyAnalysisService.ts's PropertyAnalysis exactly. Both
// platforms require the host runner (real Chrome via CDP) — neither is headless-capable. ---

export type PropertyPlatform = "dubizzle" | "propertyfinder";

export type PropertyType = "apartment" | "villa" | "townhouse" | "penthouse" | "studio";

export type PropertyPurpose = "buy" | "rent";

// No confirmed server-side URL param for either platform — enforced client-side at capture time
// against each listing's own is_offplan flag. Defaults to "ready" (confirmed preference).
export type PropertyStatus = "ready" | "offplan" | "any";

// The SOURCE SITE's own sort order, applied BEFORE scraping (2026-08-24) — distinct from the
// results table's own client-side SortKey, which only re-orders what's already been captured.
// Empirically confirmed live against both real sites' own sort UI. "default" = each platform's own
// out-of-the-box ordering (dubizzle: Popular; propertyfinder: Featured).
export type PropertySortOrder = "default" | "newest" | "price_low_high" | "price_high_low";

export type PropertyJobStatus =
  "queued" | "capturing" | "parsing" | "detail" | "scoring" | "ready" | "failed" | "blocked";

export type PropertyEndReason =
  "end_of_results" | "max_pages" | "max_listings" | "stagnation" | "blocked" | "error";

export interface PropertyScoreWeights {
  value?: number;
  keywords?: number;
  freshness?: number;
  verified?: number;
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
  sort_order: PropertySortOrder;
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
  // Live "what is it on right now" — mirrors EcomJob's current_product.
  current_listing: string | null;
  error_message: string | null;
  storage_dir: string | null;
  // Resumable retry (see hooks/usePropertyCrawl.ts's useRetryPropertyJob) — capped server-side
  // at 3.
  retry_count: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export type PropertyExtractionSource = "dom" | "dom+ocr" | "ocr";

export interface PropertyListing {
  id: string;
  job_id: string;
  idx: number;
  page_num: number;
  title: string;
  listing_url: string | null;
  // The SITE's own photo URLs — links only, never downloaded/proxied. Click through to the real
  // ad, never a locally-hosted copy.
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
  // How much of distress_score is backed by real data vs. a neutral fallback — 0-100. See
  // backend property/analysis.py's compute_distress_confidence.
  distress_confidence: number | null;
  extraction_source: PropertyExtractionSource;
  ocr_confidence: number | null;
  needs_review: boolean;
  raw_text: string | null;
  source_images: string[];
  detail_scraped: boolean;
  created_at: string;
}

// A save-for-later SNAPSHOT of one listing — mirrors backend/api/src/types/db.ts's
// PropertyWishlistItem exactly (see db/migrations/1785600000000_property-wishlist.sql for why
// this isn't a live reference to PropertyListing).
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
  created_at: string;
}

export type PropertyListingRefreshStatus = "queued" | "running" | "done" | "failed";

// Mirrors backend/api/src/types/db.ts's PropertyListingRefresh — the per-row "Refresh" button's
// request/result.
export interface PropertyListingRefresh {
  id: string;
  listing_id: string;
  listing_url: string;
  platform: PropertyPlatform;
  status: PropertyListingRefreshStatus;
  old_price: string | null;
  new_price: string | null;
  error_message: string | null;
  requested_at: string;
  completed_at: string | null;
}

// Mirrors backend/api/src/types/db.ts's PropertyJobSchedule — a saved recurring search. Timestamp
// columns arrive as ISO strings over JSON (the backend type has them as Date, since pg returns
// real Date objects; JSON.stringify serializes those to strings before they ever reach the client).
export interface PropertyJobSchedule {
  id: string;
  created_by: string | null;
  platform: PropertyPlatform;
  location: string;
  bedrooms: number | null;
  bathrooms: number | null;
  property_type: PropertyType;
  purpose: PropertyPurpose;
  property_status: PropertyStatus;
  sort_order: PropertySortOrder;
  max_pages: number;
  max_listings: number;
  detail_scrape_top_n: number;
  whatsapp_message_template: string | null;
  score_weights: PropertyScoreWeights | null;
  interval_hours: number;
  enabled: boolean;
  next_run_at: string;
  last_run_at: string | null;
  last_run_job_id: string | null;
  created_at: string;
}

// Mirrors backend/api/src/types/db.ts's PropertyPossibleDuplicate — a heuristic cross-platform
// same-unit match (community + bedrooms/bathrooms + price/area tolerance), never a certain one.
export interface PropertyPossibleDuplicate {
  platform: PropertyPlatform;
  listingUrl: string | null;
  title: string;
  price: string | null;
}

// PropertyListing enriched with the cross-job/day price-drop signal (previous_price/price_dropped),
// the most recent completed manual refresh (if any), and a possible cross-platform duplicate (if
// any) — see backend/api/src/db/propertyListings.ts's listPropertyListingsWithHistory, which is
// what /results now returns.
export interface PropertyListingWithHistory extends PropertyListing {
  previous_price: string | null;
  price_dropped: boolean;
  latest_refresh: PropertyListingRefresh | null;
  possible_duplicate: PropertyPossibleDuplicate | null;
  // Region building-age reference match (2026-08-25) — only ever populated when the listing's own
  // real age_years is null (a mapped estimate never overrides a real detail-scraped value).
  mapped_age_years: number | null;
  mapped_age_is_estimated: boolean;
  mapped_building_name: string | null;
}

// A manually-curated building-name -> completion-year reference row, scoped to a region. Age is
// always derived at read time (current_year - completion_year), never stored.
export interface PropertyBuildingAge {
  id: string;
  region: string;
  building_name: string;
  completion_year: number | null;
  is_estimated: boolean;
  created_at: string;
  updated_at: string;
}

// A PropertyListingWithHistory PLUS which job/platform/search it was captured under — only
// GET /property-crawl/search returns this shape, since results there span MULTIPLE jobs (every
// other results view is already scoped to one job, so platform/location come from that job).
export interface PropertySearchResult extends PropertyListingWithHistory {
  platform: PropertyPlatform;
  job_location: string;
}

export interface PropertyAnalysisSummary {
  listingCount: number;
  needsReviewCount: number;
  detailScrapedCount: number;
  price: {
    min: number | null;
    max: number | null;
    p25: number | null;
    median: number | null;
    p75: number | null;
  };
  pricePerSqft: { min: number | null; max: number | null; median: number | null };
  avgListedDaysAgo: number | null;
  pctVerified: number | null;
}

export interface PropertyCommunityBreakdown {
  community: string;
  count: number;
  medianPrice: number | null;
  medianPricePerSqft: number | null;
}

export interface PropertyTopListing {
  id: string;
  idx: number;
  title: string;
  price: number | null;
  areaSqft: number | null;
  pricePerSqft: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  community: string | null;
  distressScore: number | null;
  distressKeywords: string[];
  listingUrl: string | null;
  imageUrl: string | null;
  whatsappLink: string | null;
  phoneNumber: string | null;
}

export interface PropertyAnalysis {
  jobId: string;
  summary: PropertyAnalysisSummary;
  communityBreakdown: PropertyCommunityBreakdown[];
  top10: PropertyTopListing[];
}

// --- Marketing / Messaging (see md/MARKETING.md) ---

export type MessageChannel = "whatsapp" | "email";
export type CampaignStatus = "draft" | "sending" | "completed" | "failed" | "cancelled";
export type RecipientStatus = "pending" | "sent" | "failed" | "skipped";

export interface MarketingRecipient {
  businessName: string;
  businessType: string | null;
  location: string | null;
  phone: string | null;
  email: string | null;
}

export interface RecipientPreview {
  recipients: MarketingRecipient[];
  total: number;
  withPhone: number;
  withEmail: number;
}

export interface PublicEmailCredentials {
  configured: boolean;
  verified: boolean;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  orgAddress: string | null;
  updatedAt: string;
}

export interface MessageTemplate {
  id: string;
  channel: MessageChannel;
  name: string;
  subject: string | null;
  body: string;
  business_type: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageTemplateImage {
  id: string;
  cid: string;
  filename: string;
  mime: string;
  isInline: boolean;
}

export interface MarketingContact {
  id: string;
  business_name: string;
  business_type: string | null;
  location: string | null;
  phone: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
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
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
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
  sent_at: string | null;
}

export interface EmailSuppression {
  email: string;
  reason: "unsubscribed" | "bounced" | "manual";
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
