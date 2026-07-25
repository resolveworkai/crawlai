/** Authored by: Mohit Singh */
import "dotenv/config";
import { z } from "zod";

// Parsed once, at boot. Missing/invalid required vars => process exits with a clear message,
// never a half-booted service. Extend this schema as later phases add real consumers
// (LLM/Google keys in Phase 5/6) rather than validating vars nothing reads yet.
const DEV_DEFAULT_JWT_SECRET = "dev-only-insecure-secret-change-me-before-any-real-deployment";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  // Dev-only default so local dev/test never needs a .env just to boot — see
  // .claude/skills/skills_security.md. Production is guarded below: refuses to boot on the
  // default.
  JWT_SECRET: z.string().min(1).default(DEV_DEFAULT_JWT_SECRET),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),
  // CORS must name an explicit origin (not "*") because auth cookies require
  // credentials: true — see auth/cookies.ts and app.ts.
  FRONTEND_ORIGIN: z.string().default("http://localhost:3000"),
  // Deliberately NOT derived purely from NODE_ENV==='production': the Set-Cookie `Secure`
  // attribute requires an actual HTTPS connection, and this app's `docker-compose.yml` runs
  // NODE_ENV=production over plain HTTP (no TLS termination) for local/single-box use — a
  // browser silently drops (never sends) a Secure cookie set over http://, which breaks login
  // entirely with no visible error. Explicit override wins; otherwise falls back to NODE_ENV
  // so a genuine HTTPS-fronted deployment still defaults secure-on. See docker-compose.yml.
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),
  // Phase 6 — manual, on-demand Google Places enrichment (never automatic — see
  // services/googleEnrichmentService.ts). Absent = the "Fetch rating" button is
  // hidden/disabled on the frontend and the endpoint itself refuses with 503, rather than the
  // app failing to boot — this integration is opt-in, not required.
  GOOGLE_API_KEY: z.string().min(1).optional(),
  // Phase 7 — where generated export files (xlsx/csv/json) live. docker-compose.yml mounts a
  // named volume (`business_scout_exports`) at this path so files survive a container restart;
  // defaults to a repo-relative path for local (non-Docker) dev.
  EXPORTS_DIR: z.string().min(1).default("./data/exports"),
  EXPORT_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  // Phase 7 — public /api/v1/* for external consumers (e.g. a future myhub integration).
  // Comma-separated static keys, never a per-user JWT — see middleware/apiKeyAuth.ts. Absent =
  // every /api/v1 request is rejected with 401, rather than the app failing to boot.
  API_KEYS: z.string().optional(),
  // Phase 8 performance pass — `pg`'s undocumented-but-real default is max:10 if unset. Made
  // explicit + tunable rather than relying on the library default silently capping concurrency
  // under load (e.g. many simultaneous SSE-streaming dashboard clients + API traffic).
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  // Crawl-OCR module — where captured Google Maps panel screenshots live (one subfolder per
  // job). docker-compose mounts a named volume here; the images are purged after
  // OCR_CRAWL_RETENTION_DAYS while the DB rows persist. The Node API and the Python worker BOTH
  // resolve this same path — the worker writes PNGs, Node reads them for thumbnails + purges old
  // ones. Default is repo-relative for non-Docker dev.
  OCR_CAPTURES_DIR: z.string().min(1).default("./storage/ocr_captures"),
  OCR_CRAWL_RETENTION_DAYS: z.coerce.number().int().positive().default(5),
  // Boot-time default only — the operator-facing ceiling is crawl_settings.ocr_max_results
  // (DB-configurable via the Settings screen, up to 1000), enforced at request time in
  // routes/ocrCrawl.ts. This just bounds what OCR_CRAWL_MAX_RESULTS itself may be set to.
  OCR_CRAWL_MAX_RESULTS: z.coerce.number().int().positive().max(1000).default(25),
});

function loadConfig() {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
    process.exit(1);
  }
  const data = parsed.data;
  if (data.NODE_ENV === "production" && data.JWT_SECRET === DEV_DEFAULT_JWT_SECRET) {
    console.error("Refusing to boot in production with the default dev-only JWT_SECRET.");
    process.exit(1);
  }
  const cookieSecure =
    data.COOKIE_SECURE !== undefined
      ? data.COOKIE_SECURE === "true"
      : data.NODE_ENV === "production";
  return { ...data, COOKIE_SECURE: cookieSecure };
}

export const config = loadConfig();
export type Config = typeof config;
