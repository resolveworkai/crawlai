<!-- Authored by: Mohit Singh -->

# business-scout-ai

Discovers nearby businesses by type + radius, enriches them (contacts, socials, images), and
serves the result via an API and dashboard. Hybrid Node (web tier) + Python (crawler tier) stack
sharing one PostgreSQL database — see `AGENTS.md`/`CLAUDE.md` for the full architecture, coding
conventions, and API endpoint table.

## Stack

| Layer | Tech |
|---|---|
| Frontend | TanStack Start (React 19) + Leaflet + TanStack Query |
| Backend API | Node.js + Express + TypeScript |
| Crawler worker | Python (asyncio) + Playwright + Tesseract OCR |
| Database | PostgreSQL (own dedicated instance — never shares with another project) |

## Two crawler pipelines

1. **Main crawler** — OpenStreetMap/Overpass discovery → tiered website enrichment (HTTP fetch →
   headless browser → optional LLM) → the master `businesses` table. Free, ToS-clean, at scale.
2. **Crawl (OCR)** (`md/OCR_CRAWL.md`) — a parallel, low-volume job type that walks Google Maps
   results and reads structured contact data straight from the DOM (phone/website/address/rating/
   category/hero-image), with Tesseract OCR as a fallback + visual audit trail. Single job at a
   time by design; see that doc for the compliance note and known limitations (no review count).

## Quickstart

```bash
docker compose up -d --build
```

Brings up `postgres` (dedicated, isolated instance), `backend` (Node API + Python worker via
supervisord, migrations applied automatically on start), and `frontend`. See `.env.example` for
every configurable var.

## Docs

| Doc | Covers |
|---|---|
| `AGENTS.md` / `CLAUDE.md` | Full architecture, API routes, engineering standards, verified-live status of every module |
| `md/OCR_CRAWL.md` | Crawl (OCR) module: capture mechanism, DOM-vs-OCR field sourcing, known limitations, performance tuning |
| `md/plans/` | Approved, dated implementation plans (newest first in `md/plans/README.md`) |
| `.claude/skills/` | Per-layer engineering conventions — read the relevant one before touching that layer's code |

## Quality gates

Node (frontend + `backend/api`): `npm run lint && npm run typecheck && npm test`.
Python (`backend/worker`): `ruff check . && ruff format --check . && mypy . && pytest`.
CI runs all of the above plus a `docker compose build` for both images on every push.
