## AI Business Crawler — v1 Build Plan

### Stack (adapted to Lovable)
- **Frontend**: TanStack Start + React + Tailwind v4 + shadcn/ui + TanStack Query + Zustand. (Next.js isn't available on this platform; TanStack Start is the modern React equivalent Lovable ships.)
- **Backend**: TanStack `createServerFn` on Cloudflare Workers runtime. (Express isn't runnable here — server functions cover the same role.)
- **DB + Auth + Storage**: Lovable Cloud (Supabase under the hood — Postgres + RLS + auth). Prisma is replaced by Supabase migrations, which is the supported path here.
- **Discovery + crawl**: **Firecrawl** connector (Search for Google-sourced business discovery, Scrape for each website) + **OSM Overpass** as free fallback. Crawlee/Playwright/Puppeteer can't run on Workers, so Firecrawl replaces them — it already handles JS rendering, anti-bot, retries, and rate limiting.
- **Queue**: Lightweight DB-backed job runner (crawl_jobs + tasks). BullMQ/Redis aren't available on Workers; the crawl runs as a background chain of server fn calls with a persisted progress row the UI polls. Good enough for hundreds → low thousands of businesses per job.
- **AI extraction**: Lovable AI Gateway (`google/gemini-2.5-flash` for extraction speed).
- **Excel export**: `xlsx` npm package, generated in a server fn.
- **Maps**: Leaflet + OpenStreetMap tiles.

### Database schema
- `profiles` — user metadata
- `user_roles` — role enum: `admin` | `operator` | `viewer`; enforced via `has_role()` SECURITY DEFINER
- `crawl_jobs` — user_id, business_type, center_lat/lng, radius_km, status, counters (found/crawled/failed), started_at, finished_at, error
- `crawl_logs` — job_id, level, message, ts (for the live console)
- `businesses` — master DB, all fields from your spec as typed columns + `extra jsonb` for dynamic fields. Unique constraint on (owner_user_id, lower(email)) with a partial index; secondary dedup by name+phone at insert time.
- `business_images` — job_id, business_id, kind, url
- `dynamic_fields` — user_id, key, label, prompt, type, enabled
- `settings` — user_id, concurrency, retry_count, timeout_ms, user_agent, map_provider, etc.

RLS: users see their own crawl_jobs / businesses / logs / dynamic_fields / settings. Admins see all.

### Screens
- **Auth** (`/auth`) — email/password + Google (managed).
- **App shell** (`/_authenticated/*`) with sidebar (Dashboard, New Crawl, History, Master DB, Export, Settings, Logs) + top header (search / user menu).
- **Dashboard** — stat cards (businesses, emails, phones, websites, cities, avg rating) + category / city / rating pie charts (Recharts).
- **New Crawl** — business type input, radius dropdown (1/2/5/10/15/20/custom), Leaflet map with address search (Nominatim) + click-to-pin + radius circle overlay, Start button. On start: creates a `crawl_job` row, kicks off the background crawl, navigates to a live progress screen.
- **Live Progress** (`/crawls/$id`) — polls job + logs every 2s. Counters (found / crawled / website-crawled / failed / remaining / ETA), current business, log stream, cancel button.
- **Crawl History** — list of jobs with actions: view, re-export, restart, delete.
- **Master Database** — table with filters (city, rating, has-website/email/phone, min reviews, verified, open now), row detail drawer.
- **Export** — pick job(s) / all + fields → Excel (frozen header, autofilter, auto width, multi-sheet: Businesses / Images / Logs / Errors / Stats) or CSV or JSON.
- **Settings** — concurrency / retry / timeout / user-agent, dynamic field manager (add / edit / delete / toggle field with custom AI prompt), export field selection, AI prompt templates.
- **Logs** — global log viewer across jobs (admin sees all).

### Crawl workflow (per job, background)
1. **Discovery**
   - If OSM enabled → Overpass query around center/radius for `amenity=gym|library|beauty_salon|...` mapped from business_type.
   - Firecrawl Search: `"{business_type} near {reverse_geocoded_place}"` with `limit: 50`, `country`/`lang` from settings.
   - Merge, dedup by (name+coords rounded).
2. **Per business**
   - Persist skeleton row (name, google_map_url if any, coords, address bits).
   - If website URL known: Firecrawl Scrape homepage with `formats: ['markdown','links','branding']`, `onlyMainContent: true`.
   - Follow About / Contact links from the returned `links` array (max 2), scrape each.
   - Regex extract emails (mailto + `\S+@\S+\.\S+`), phones (libphonenumber-js), socials (fb/ig/li/yt/x URLs), logo (branding.logo).
   - Send collected page text to AI Gateway with a strict JSON schema for: summary, services[], products[], amenities[], keywords[], tags[], industry, target_audience, owner_name, manager_name + one entry per enabled dynamic field.
   - Apply duplicate rules: email match → update; else name+phone → update; else insert.
   - Update job counters + append log row.
3. **Finish** — mark job complete, write summary.

Cancellation: job row has a `cancel_requested` flag the loop checks between businesses.

### RBAC
- `admin` — everything, sees all jobs/businesses
- `operator` — start crawls, manage own data, export
- `viewer` — read-only on their own workspace

### Out of scope for v1 (called out honestly)
- **True parallelism / 100k+**: Workers cap per-request time; we process businesses sequentially per job with early-exit on cancel. Scaling past ~1–2k per job needs job chunking, which we can add.
- **Google Places / Bing / Yelp connectors**: architecture leaves a `DiscoverySource` interface; adding one is a new file, no core changes.
- **Proxy config / captcha handling**: Firecrawl handles this internally; exposing knobs later.
- **OpenAPI/Swagger docs, Docker, unit tests**: not applicable — Lovable hosts and ships this directly; there's no separate Node service to document or containerize.

### Order of execution this turn
1. Enable Lovable Cloud, connect Firecrawl.
2. Migrations: enum, tables, RLS, grants, `has_role`, seed roles trigger.
3. Auth scaffold + `_authenticated` layout is integration-managed.
4. Design tokens in `src/styles.css` (white / light-gray / blue accent, glassmorphism utilities).
5. App shell (sidebar + header) + all route files.
6. New Crawl page with Leaflet + radius + start action.
7. Discovery + crawl server functions (Firecrawl + OSM + AI).
8. Live Progress, History, Master DB, Settings (incl. dynamic fields), Export (xlsx/csv/json), Dashboard stats.
9. SEO metadata per route, sitemap, robots.

I'll ship what fits cleanly this turn and flag anything left for the next iteration. Ready to build?