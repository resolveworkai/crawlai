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
| Backend worker | Python (`mypy --strict`) + psycopg + httpx + Playwright |
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
