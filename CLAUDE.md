<!-- Authored by: Mohit Singh -->

# business-scout-ai

**Type**: standalone nearby-business discovery/enrichment crawler | **Author**: Mohit Singh

## What this is

Discovers nearby businesses by type within a configurable map radius, enriches them into a shared master
database, and exposes that data via a public API for downstream consumers. Not part of any other repository —
own Postgres, own deploy, own history.

The frontend originated from a Lovable-generated scaffold. **This project's documentation and authorship make no
reference to Lovable** — see "File authorship" below. The scaffold's functional build tooling
(`@lovable.dev/vite-tanstack-config` in `vite.config.ts`) is kept as-is where removing it would add risk for no
functional benefit; this is a deliberate, documented choice, not an oversight.

## Architecture — exactly 2 application images + 1 dedicated database

```
frontend (repo root, Dockerfile)  --HTTP/SSE-->  backend (backend/Dockerfile, ONE image)
  TanStack Start, pure API client                  supervisord runs 2 sibling processes:
                                                      · Node API (backend/api)  — the only HTTP surface
                                                      · Python worker (backend/worker) — the crawler daemon
                                                    Node <-> Python: DB only, never HTTP/IPC
                                                        |
                                                        v
                                              PostgreSQL (new, dedicated instance — see skills_devops.md)
```

- **Frontend** (repo root — kept in place, not moved to a subfolder; see `.claude/skills/skills_frontend.md`).
- **Backend** = one image, two processes: `backend/api/` (Node/Express, TypeScript strict) and
  `backend/worker/` (Python, `mypy --strict`) — the crawler engine (Overpass discovery → tiered enrichment →
  optional AI extraction). They communicate **only through Postgres** (`LISTEN`/`NOTIFY` + shared tables).
- **Database**: plain PostgreSQL, a brand-new dedicated instance for this project only — see
  `.claude/skills/skills_devops.md` for the exact container name/volume/port/credentials. Never reused from, or
  shared with, any other project on the same host.

Full architecture rationale, the requirement-coverage matrix, the phased build plan, and every design decision:
**`md/plans/0001-business-scout-ai-crawler.md`** (this project's first approved plan).

## Current status (updated 2026-07-13 — read this first when resuming work)

**Phases 0-3 complete and verified** (`md/plans/README.md` tracks the authoritative phase status).
The crawler MVP is real and working end-to-end — verified via a live `docker compose` run (login →
launch a crawl → 64 real Berlin libraries discovered via Overpass and enriched from their real
websites, no mocking). First commit: `c70b854` on `master`.

- **Phase 0-1**: scaffold, quality gates, full DB schema + migrations, typed data-access both runtimes.
- **Phase 2**: JWT auth, jobs/businesses/fields/settings/stats/geocode REST API with SSE, all 7
  frontend screens wired to the real API (zero mock data). Fixed a real bug: cookies shipped
  `Secure` over the plain-HTTP local `docker-compose.yml`, which silently breaks login in any real
  browser — see `COOKIE_SECURE` in `backend/api/src/config.ts` and skills_security.md.
- **Phase 3 (the shippable milestone)**: Overpass discovery (`backend/worker/business_scout_worker/
  discovery/`), Tier-1 website enrichment (`enrich/`), exact dedupe (`dedupe.py`), the job daemon
  (`main.py`/`jobs.py`/`pipeline.py` — LISTEN/NOTIFY + atomic claim + pause/cancel/graceful-shutdown).
  Two real bugs found via the live verification run and fixed (both documented in
  `skills_backend_python.md`): Overpass rejecting requests without a form-encoded body + User-Agent,
  and a phone-extraction regex picking up SVG/CSS/script markup noise instead of visible text.
- **Not started yet**: Phase 4 (Tier-2 Playwright fallback, real phone/address parsing via
  `phonenumbers`/`pypostal`, fuzzy rapidfuzz dedup) onward — see the plan for the full remaining scope
  (Phases 4-8: enrichment depth, AI extraction, manual Google enrichment, exports + public API,
  hardening).
- **Known follow-up, not yet done**: `supabase/` (CLI config + old Lovable-era migrations) is dead
  weight left over from the original scaffold — the real schema is `db/migrations/*.sql` via
  node-pg-migrate. Safe to delete, just hasn't been done.

## Skills

Canonical conventions live in `.claude/skills/`, indexed at [.claude/skills/README.md](.claude/skills/README.md)
— **start there**, it maps task → skill. Read the relevant skill file before touching that layer's code:

- Frontend: `.claude/skills/skills_frontend.md`
- Backend (Node API): `.claude/skills/skills_backend_node.md`
- Backend (Python worker): `.claude/skills/skills_backend_python.md`
- Database: `.claude/skills/skills_db.md`
- DevOps: `.claude/skills/skills_devops.md`
- Security: `.claude/skills/skills_security.md`
- Efficiency (token/action discipline — read once, apply always): `.claude/skills/skills_efficiency.md`

## API reference (backend/api — all routes, as actually registered)

Every list/single-resource endpoint wraps its payload in a named envelope (`{jobs:[...]}`,
`{job:{...}}`, etc.) — see `skills_frontend.md` for the full convention and the one exception
(`/stats/overview`, which returns its shape bare). `requireAuth` is applied **per-route**, never via
`router.use()` (a verified real bug — see `skills_backend_node.md`).

| Group | Routes |
|---|---|
| `/auth` | `POST /login`, `POST /logout`, `GET /me`, `POST /refresh` |
| `/jobs` | `POST /` (create), `GET /` (list), `GET /:id`, `POST /:id/{pause,resume,retry,cancel}`, `DELETE /:id`, `GET /:id/stream` (SSE), `GET /logs/stream` (SSE, global) |
| `/businesses` | `GET /` (filter/paginate), `GET /:id`, `DELETE /:id` |
| `/dynamic-fields` | `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` |
| `/settings` | `GET /` (any role), `PATCH /` (admin only) |
| `/stats` | `GET /overview` (30s server-side cache) |
| `/geocode` | `GET /?q=` (Nominatim proxy) |
| `/health` | `GET /` (checks DB) |

Public `/api/v1/*` (Phase 7, not built yet) and `POST /businesses/:id/enrich-google` (Phase 6, not
built yet) are documented in the plan but don't exist in code today — don't assume they're wired up.

## Project convention — approved-plan archival (REQUIREMENT)

Final, **approved** plans are durable project history so every later plan builds on the last:

- Location: `md/plans/`, named `NNNN-<slug>.md` (zero-padded sequence), indexed in `md/plans/README.md`
  (number · title · date · status, newest-first).
- **Only approved/final plans are committed here — never intermediate/working drafts.**
- Every new plan references relevant prior plans by number ("Builds on / supersedes NNNN") at its top.
- Superseded plans are kept (marked `Superseded by NNNN` in the index), never deleted.
- **Before planning new work, read the latest entry in `md/plans/`.**

## Project convention — file authorship (REQUIREMENT)

Every source file authored in this project carries a header attributing **Mohit Singh**:
- TS/JS: `/** Authored by: Mohit Singh */`
- Python: `"""Authored by: Mohit Singh"""` (module docstring) or `# Authored by: Mohit Singh`
- SQL/YAML/Dockerfiles: `-- Authored by: Mohit Singh` / `# Authored by: Mohit Singh` as the first line

Applies to files we write (backend, frontend routes/components, migrations, infra, skills, docs). Exempt:
third-party/vendor/generated files (`routeTree.gen.ts`, `node_modules`, lockfiles, shadcn `components/ui/*`
primitives kept as-is) — attribution goes on code we author, not on generated or vendored code. No mention of
Lovable (or any other scaffold-generation tool) as author-of-record belongs anywhere in this project's docs.

## Stack

| Layer | Tech |
|---|---|
| Frontend | React 19 + TanStack Start + Vite + Tailwind + shadcn-ui + Leaflet + recharts |
| Backend API | Node.js + Express + TypeScript (strict) |
| Backend worker | Python (`mypy --strict`) + psycopg + httpx + selectolax (Playwright is Phase 4, not a dependency yet) |
| Database | PostgreSQL (dedicated instance) |
| Discovery | OpenStreetMap / Overpass API (free) |
| AI extraction | Optional, provider-agnostic (Ollama default/free, or any OpenAI-compatible key) |

## Engineering standards (non-negotiable, every phase)

Strict typing both runtimes · one quality-gate command per runtime wired into CI + pre-commit (lint/format/
typecheck/test) · tests written with the feature, not after · config validated at boot, fail-fast · structured
logging with correlation IDs · consistent typed error handling · migrations are the only schema authority ·
idempotent/atomic job handling · containerized from day 1 · CI green from commit #1 · Node↔Python share only
the DB, never HTTP · security baseline (bcrypt, JWT, deny-by-default authz, parameterized SQL, env-only secrets).

## Testing policy — no browser automation against our own app

Verification uses Vitest/RTL/supertest/pytest — never Chrome/Playwright-as-test-runner/computer-use to drive our
own frontend or API. **This does not restrict Playwright as a product dependency**: the worker's Tier-2
enrichment legitimately uses headless Chromium to render *other businesses'* websites — that's core product
functionality, unrelated to how we test our own code. See `.claude/skills/skills_devops.md`.

## Pre-commit rule

Before every `git commit`, if the changed area touched a durable convention/pattern/pitfall, update the matching
skill file + this `CLAUDE.md` + `AGENTS.md` (mirrored) in the same change set. Stale docs are a bug.
