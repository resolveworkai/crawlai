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
    data.COOKIE_SECURE !== undefined ? data.COOKIE_SECURE === "true" : data.NODE_ENV === "production";
  return { ...data, COOKIE_SECURE: cookieSecure };
}

export const config = loadConfig();
export type Config = typeof config;
