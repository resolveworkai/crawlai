<!-- Authored by: Mohit Singh -->

# Frontend Skills — TanStack Start (React 19)

> Read before touching `src/routes/`, `src/components/`, `src/lib/`, `src/integrations/`.

## Architecture

- The frontend lives at the **repo root** (not a `frontend/` subfolder) — its build tooling
  (`vite.config.ts` via `@lovable.dev/vite-tanstack-config`, `tsconfig.json`'s `@/*` alias, `routeTree.gen.ts`)
  is wired assuming that location. Do not move it without updating all three.
- The frontend is a **pure API client** of `backend/api` — no server-side business logic lives in TanStack
  Start server routes. All data calls go through `src/lib/api-client.ts` (`VITE_API_URL`, a **build-time** env
  var baked into the client bundle — not `BACKEND_URL`, which is compose-internal and only reachable
  server-side; see `skills_devops.md`).
- File-based routing: one file per screen under `src/routes/`. Screens: `login` (unauthenticated), `index`
  (Overview/dashboard), `discover`, `businesses`, `jobs`, `fields`, `exports` (Phase 7 preview, non-functional
  until then), `settings`. Nav is defined in `src/components/app-sidebar.tsx` (`mainItems`/`dataItems`) —
  adding a route means adding it there too, or it's unreachable from the UI.
- **Auth guard**: every protected screen's `component` wraps its content in
  `<RequireAuth>` (`src/components/require-auth.tsx`) — it calls `useCurrentUser()`, shows a brief loading
  state, and redirects to `/login` on a `null` (401) result. There is no server-side route guard (the access
  token is an httpOnly cookie, invisible to `beforeLoad`) — `RequireAuth` is the only gate. Don't add a new
  protected screen without wrapping it.
- Shared shell: `AppShell` (`src/components/app-shell.tsx`) wraps every protected screen (header, title/subtitle,
  actions slot). The header's `NewCrawlDialog` (`src/components/new-crawl-dialog.tsx`) posts to the same
  `POST /jobs` Discover's "Scan area" button uses — reuse it, don't duplicate the create-job form. The ⌘K search
  box is decorative (out of scope per the plan's design-spec finding #5).
- `StatusBadge` (`src/components/status-badge.tsx`) is the **one** status-pill component for both job statuses
  (`pending|discovering|crawling|paused|completed|failed|cancelled`) and business `enrichment_status`
  (`queued|crawling|enriched|failed`) — extend its style map, never fork a second badge component.

## Data layer

- **TanStack Query** for all server state — one query-key hierarchy per domain (`['jobs']`, `['jobs', id]`,
  `['businesses', filters]`, `['dynamic-fields']`, `['settings']`, `['stats', 'overview']`). Hooks live in
  `src/hooks/use*.ts`, one file per domain, mirroring `backend/api/src/routes/*.ts` 1:1.
- **Every list/single-resource endpoint wraps its payload in a named envelope, never a bare array/object** —
  e.g. `GET /jobs` → `{jobs: CrawlJob[]}`, `GET /jobs/:id` → `{job: CrawlJob}`, `POST /jobs` → `{job: CrawlJob}`,
  same pattern for `businesses`/`dynamic-fields`/`settings`/`geocode` (`{result: GeocodeResult}`). Auth is the
  one exception in shape only (`{user: AuthenticatedUser}` from both `/auth/login` and `/auth/me`), not in
  convention. **Always unwrap the envelope inside the hook's `queryFn`/`mutationFn`** (see `useJobs.ts`) — never
  leak the raw `{jobs: [...]}` shape into a component. `GET /stats/overview` is the one endpoint that returns
  its shape bare (`{stats, trend, recentJobs, recentlyEnriched}`, no outer wrapper) — check the actual route
  file before assuming a convention, don't guess from memory.
- **SSE event names**: `GET /jobs/:id/stream` emits `"job"` (single `CrawlJob`, replace) and `"logs"` (plural,
  `CrawlLog[]`, prepend/merge) — not `"log"` singular. `GET /logs/stream` (global) emits only `"logs"`. Consumed
  via `EventSource` with `{withCredentials: true}` (cookie auth — see `skills_backend_node.md`'s SSE note), not
  polling. Reconnect on drop (EventSource does this natively; don't add manual retry logic).
- **Access-token refresh is transparent, not the caller's problem**: `api-client.ts`'s `request()` retries once
  on a 401 by calling `POST /auth/refresh` first (the access-token cookie is 15 min, refresh is 7 days) — hooks
  never need their own 401/refresh handling.
- Never fabricate data. Empty/unavailable fields render `—`, not a placeholder value. This applies especially to
  OSM-sourced fields (rating/reviews are empty until the manual "Fetch rating" button is clicked) and to any
  loading state (skeletons, not fake numbers). Verified real instances during the Phase 2 rewire: dynamic fields
  have no `usage` counter in the DB (the mock's fabricated per-field usage count was dropped, not faked),
  Businesses has no `employees`/"Size" column (not a real schema field), and Overview's stat tiles show no
  week-over-week delta badges (the backend aggregate query doesn't compute one).

## Map (Leaflet — the "open source map library" requirement)

- `leaflet` + `react-leaflet` — already a dependency. OSM tile layer (`{s}.tile.openstreetmap.org`).
- Discover screen: click-to-pin sets the center marker; `L.circle` radius is driven by the km slider/input, not
  a separate control — keep them bound to the same state.
- Never introduce Google Maps or any non-open-source map library. The manual Google-rating feature (Businesses
  screen) is a data lookup, not a map component — it must never pull in the Google Maps JS SDK.

## Forms & validation

- Forms so far (login, new-crawl dialog, new-field dialog, settings) are plain controlled `useState` inputs, not
  `react-hook-form` — the shadcn `form.tsx` primitive (which wraps RHF) is present but unused; don't assume it's
  wired up. Client-side validation is minimal (required-field disabling on submit buttons) since the backend's
  `zod` schemas are the real source of truth and return a clean `400` with a usable message either way (surfaced
  via `toast.error(err.message)`, an `ApiError` from `api-client.ts`). Reach for `react-hook-form` only if a form
  gets complex enough (many interdependent fields, async field-level validation) that plain `useState` becomes
  unwieldy — don't add it preemptively.

## Testing (no browser automation)

- Vitest + React Testing Library + jsdom. Component/hook tests only — **never** drive this app's own UI with a
  real/headless browser (Playwright-as-test-runner, Chrome DevTools MCP, computer-use) to verify our code. See
  `skills_devops.md` for the full testing-policy rationale (Playwright IS used, but only as the crawler's own
  Tier-2 scraping engine against *other* sites — that's product code, not a test tool).
- `npm run typecheck && npm run lint && npm test` is the local gate; CI runs the same.

## Branding / provenance

- Product name: "Business Scout AI" (see `app-sidebar.tsx`). No "Prospera" or Lovable-tool references belong in
  UI copy, comments, or docs — this was a scaffold placeholder, already renamed once; don't reintroduce it.
