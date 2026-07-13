<!-- Authored by: Mohit Singh -->

# Backend Skills — Node API (`backend/api/`)

> Read before touching `backend/api/src/`.

## Role

This is **half of the `backend` image** (the other half is the Python worker — see `skills_backend_python.md`),
run as a sibling process under `supervisord`. It is the **only** HTTP surface of the whole system: the frontend,
the manual Google-enrichment feature, and any external consumer (public `/api/v1`) all go through it. The Python
worker has **no HTTP** — it only reads/writes Postgres. Never add an HTTP call between this service and the worker.

## Structure

```
backend/api/src/
├─ config.ts        # zod-parsed process.env, once, at boot — fail fast on invalid/missing vars
├─ server.ts         # Express app assembly, no listen() here
├─ index.ts           # entrypoint, calls listen()
├─ routes/             # path+method → controller, no business logic
├─ controllers/         # req/res handling, calls services, no direct SQL
├─ services/             # business logic — jobs, businesses, dynamic-fields, settings, exports, google
├─ middleware/            # auth, error envelope, request logging
├─ db/                     # pg pool + typed query functions per table
└─ lib/                     # geocode client (Nominatim), sse.ts helper
```

Routes → controllers → services → db. Controllers never touch SQL; services never touch `req`/`res`.

## Conventions

- **Validation**: every request body/params/query validated with `zod` at the route boundary. Reject invalid
  input with `400` before it reaches a controller. **⚠️ Verified Express 5 gotcha**: `req.query` is a
  getter-only property in Express 5 (no setter) — assigning to it throws `Cannot set property query ... which
  has only a getter`. `middleware/validate.ts` special-cases `source:"query"` to write validated/coerced data to
  `req.validatedQuery` instead (route handlers read from there, not `req.query`, when they need zod's defaults
  applied). `body`/`params` remain writable and use the normal `req[source] = result.data` path.
- **Errors**: one error-envelope middleware, registered last — `{ error: { code, message } }`. Typed error
  classes (`NotFoundError`, `ValidationError`, `UnauthorizedError`) carry a `statusCode`; never hardcode status
  codes scattered through controllers. Every async handler wrapped so rejections reach the error middleware.
- **Auth**: JWT (short expiry + refresh), bcrypt passwords, role middleware (`admin|operator|viewer`) on every
  route — **deny by default**, not allow-by-default. Public `/api/v1/*` uses a separate API-key check, not JWT.
  Auth cookies are **httpOnly** (not bearer tokens in localStorage) specifically so `GET /jobs/:id/stream` and
  `GET /logs/stream` work with the browser's native `EventSource` — it cannot set a custom `Authorization`
  header, but it does send cookies automatically. **⚠️ Verified routing bug**: apply `requireAuth` **per-route**
  (as the last-but-one middleware arg on each `router.get/post/...` call), never as a blanket
  `router.use(requireAuth)` at the top of a domain router file. A path-unscoped `router.use()` runs for *every*
  request that reaches that router — including ones matching no route in it at all — so a request to a
  nonexistent path got auth-checked (401) before it ever reached the 404 handler. Caught by
  `health.test.ts`'s "unknown route returns 404" test after `jobsRouter` was mounted; every domain router
  (`jobs.ts`, `businesses.ts`, `dynamicFields.ts`, `settings.ts`, `stats.ts`) was fixed to the per-route pattern.
  `geocode.ts` already used the correct pattern and is the reference example.
- **Logging**: `pino`, structured JSON, never `console.log`. Every log line touching a job or business carries
  `job_id`/`business_id` for correlation with the worker's `crawl_logs`.
- **SSE**: `GET /jobs/:id/stream` and `GET /logs/stream` — a small shared `lib/sse.ts` helper (headers, heartbeat,
  clean teardown on client disconnect). Don't hand-roll SSE per route.
- **The job queue is Postgres, not a message broker**: `POST /jobs` inserts a `pending` row then
  `NOTIFY crawl_jobs, '<id>'`. No Redis/Bull. Pause/resume/retry/cancel/delete all mutate `crawl_jobs` columns
  (`pause_requested`, `cancel_requested`, status) — the worker is the only thing that acts on them.
- **Geocoding lives here, never in the worker.** `POST /jobs` resolves a typed location string to lat/lng via
  Nominatim before inserting the job row — the worker always receives coordinates.
- **The manual Google-enrichment endpoint** (`POST /businesses/:id/enrich-google`) is a Node-only, user-triggered
  request/response — never automatic, never called from the worker's crawl loop. Guard it on `GOOGLE_API_KEY`
  presence; return a clear "not configured" response (not a 500) when absent.

## Schema ownership

`db/migrations/*.sql` (node-pg-migrate) is the **single source of truth** for the schema. This service is the
only thing that runs migrations. The Python worker reads the schema; it never issues DDL. Any schema change is a
migration with a tested up **and** down.

## Testing

Vitest + `supertest`/`undici` against the running Express app (real HTTP, no browser). Every endpoint gets an
integration test including its authz paths (401/403). Mock external calls (Nominatim, Google Places) in tests —
never hit them live except in the explicitly CI-gated "live smoke" tests.
