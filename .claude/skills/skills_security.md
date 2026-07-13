<!-- Authored by: Mohit Singh -->

# Security Skills

> Read before touching auth, secrets, or anything handling scraped PII (emails/phones).

## Auth

- Bcrypt for password hashes (never plaintext, never a weak/fast hash).
- JWT with a short access-token expiry + refresh flow. Role middleware (`admin|operator|viewer`) on **every**
  route — deny by default, not allow-by-default. The public `/api/v1/*` surface uses a separate API-key check,
  scoped to read-only endpoints.
- The Python worker has no auth surface at all — it has no HTTP server. Its only "access control" is the
  Postgres credentials it connects with.

## Input validation

- Every external input (body/params/query) validated with `zod` (Node) at the route boundary before it reaches
  a controller/service. Never trust client-side validation alone.
- Reject invalid input with a clean `400` — never let bad input propagate into a service or the DB layer to
  surface as a raw constraint-violation `500`.

## SQL

- Parameterized queries only, both runtimes (`pg`/`node-pg-migrate` in Node, `psycopg` in Python). Never build
  SQL via string concatenation, especially not with scraped business names/addresses which are attacker-adjacent
  untrusted external content once they enter the pipeline.

## Secrets

- Every credential (`DATABASE_URL`, `JWT_SECRET`, `LLM_API_KEY`, `GOOGLE_API_KEY`, `API_KEYS`) lives in env vars
  only. `.env` gitignored; `.env.example` is the tracked template with placeholder/no real values.
- The dev-default Postgres password (`1234`) is a documented placeholder — flagged, not silently trusted, and
  must be rotated before any deployment beyond local dev.
- `GOOGLE_API_KEY` absence must degrade gracefully (the manual "Fetch rating" button hides/disables), never crash
  the API.

## PII handling — scraped business data

- Emails/phones/addresses gathered by the crawler are business-contact data, not personal accounts, but PII
  handling discipline still applies: don't log full contact details at `info` level (log counts/domains, not the
  raw addresses, where reasonably possible), and be mindful that any future outreach feature must respect
  GDPR / India DPDP / CAN-SPAM / PECR — this crawler collects data, it does not send anything, and that boundary
  should stay explicit if outreach is ever added later.
- Email/phone extraction applies a false-positive denylist (`sentry.io`, `wixpress.com`, `@2x.png`,
  `example.com`, `noreply@`) before anything is stored — junk matches are not "PII," but they pollute the master
  DB and should never reach it.

## Dependency hygiene

- `npm audit` / equivalent Python dependency scan runs in CI. A high/critical finding blocks merge unless
  explicitly triaged and documented.
- The removed `bunfig.toml` had a 24h "minimum release age" supply-chain guard on new package versions — a good
  practice worth reinstating via `npm`-side tooling (e.g. a lockfile-diff review step) if the project scales up
  its contributor base; not blocking for a single-author early-stage build.
- **⚠️ TRACKED — `xlsx` (SheetJS, root `package.json`) has known unpatched npm-registry advisories** (prototype
  pollution, ReDoS). SheetJS stopped publishing security fixes to the npm registry and now distributes patches
  only via their own CDN (`cdn.sheetjs.com`) — this is a well-known, long-standing situation for this package, not
  something specific to this project. **Not fixed now because nothing calls `xlsx` yet** (it's inherited from the
  Lovable scaffold; the Exports feature that will actually use it lands in Phase 7). **Before Phase 7 ships any
  xlsx-parsing/generation code**, either (a) switch to SheetJS's CDN-hosted patched build, or (b) evaluate
  `exceljs` (actively maintained on npm, no equivalent advisory) as a replacement. Do not let this dependency
  process untrusted input (e.g. a user-uploaded file) while on the vulnerable npm version.

## Vitest/Vite dev-tooling advisories (resolved pattern)

`vite`/`vitest`/`esbuild`'s dependency chain periodically carries dev-server-only advisories (e.g. path traversal
in Vite's dev server, arbitrary file read when Vitest's UI server is listening) — these do not affect the
shipped runtime (we never run `vitest --ui` or expose a `vite` dev server publicly), but should still be cleared
via a routine `vitest` version bump when `npm audit` flags them, rather than accepted-and-ignored. Applies
identically to `backend/api`'s and the root frontend's `package.json`.

## Cookie `Secure` attribute vs. plain-HTTP local Docker (verified bug, fixed 2026-07-13)

`docker-compose.yml` runs the backend with `NODE_ENV=production` (so the boot-time secret guards
actually exercise) but has **no TLS termination** — it's plain `http://localhost`. Deriving the
Set-Cookie `Secure` attribute straight from `NODE_ENV === "production"` (the original
`auth/cookies.ts` code) meant every cookie shipped `Secure`, which every real browser silently
**drops** over a non-HTTPS connection — login would appear to succeed (200 + Set-Cookie in the
response) but the browser never actually stores or resends the cookie, so the very next request
looks unauthenticated with no visible error. `curl` doesn't enforce this, so a curl-only
verification pass can miss it entirely — this is exactly the kind of thing the "no browser
automation to test our own app" policy trades away, so double-check spec-level cookie/header
behavior by reading the RFC/browser docs rather than assuming `NODE_ENV`-derived flags are safe.
**Fix**: `config.ts` now has an independent `COOKIE_SECURE` env var (`"true"|"false"`, optional —
falls back to the old `NODE_ENV==='production'` default when unset) that `auth/cookies.ts` reads
instead of `NODE_ENV` directly; `docker-compose.yml` sets `COOKIE_SECURE: "false"` explicitly with
a comment. Only flip it to `true` once this stack sits behind a real HTTPS terminator (Phase 8).

## Rate limiting

- Auth endpoints and the public `/api/v1/*` surface get rate limiting before any production exposure (Phase 8).
  Not required to block local Phase 0 development, but the middleware slot should exist so it's a config change,
  not a redesign, when it's time to turn it on.
