<!-- Authored by: Mohit Singh -->

# DevOps Skills — Docker, CI, Deployment

> Read before touching `docker-compose.yml`, any `Dockerfile*`, or `.github/workflows/`.

## Deployment shape — exactly 2 application images + 1 dedicated database

- **`frontend`** (root `Dockerfile`) — the TanStack Start app, SSR, pure API client of `backend`.
- **`backend`** (`backend/Dockerfile`) — **one image**, multi-stage (Node build stage + Python/Playwright stage),
  final stage runs `supervisord` starting two sibling processes: the Node API and the Python worker. They talk to
  each other **only through Postgres** (LISTEN/NOTIFY + shared tables) — never HTTP, never IPC, even though
  they're in the same container. This keeps them independently testable and re-splittable later with zero code
  change if independent scaling is ever needed.
- **`postgres`** — a **brand-new, dedicated instance for this project only.** Never point this project at, or
  reuse, another project's Postgres container/volume/network.

## ⚠️ Frontend build gotcha — Nitro defaults to a Cloudflare Workers target, not plain Node

The Lovable-guarded `vite.config.ts` leaves Nitro's preset unset, so `npm run build` defaults to the **Cloudflare
Workers** target — it emits `.output/server/wrangler.json` + `.wrangler/`, and that output is **not** runnable
with plain `node`. Building the frontend Docker image with a bare `npm run build` will silently produce an
un-runnable server.

**Fix (zero config-file changes — a supported Nitro override, doesn't touch the guarded file):**
```
NITRO_PRESET=node-server npm run build
```
This produces `.output/server/index.mjs` + `.output/server/node_modules` — a plain Node server, run with
`node .output/server/index.mjs` (respects `PORT`). Verified locally: boots and returns HTTP 200. The frontend
`Dockerfile`'s build stage must set `NITRO_PRESET=node-server` before `npm run build`.

## The dedicated-Postgres rule (enforce every time compose is touched)

```yaml
name: business-scout-ai          # Compose project name — fully isolates network/volume/container namespace
services:
  postgres:
    container_name: business-scout-postgres
    environment:
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: 1234          # dev-only default — MUST be rotated before any non-local deployment
      POSTGRES_DB: master_db_crawler
    ports:
      - "5436:5432"                     # host port — see note below on why not 5433
    volumes:
      - business_scout_postgres_data:/var/lib/postgresql/data
```

**⚠️ Host port collisions are real on a multi-project dev machine — verified, not hypothetical.** The first
`docker compose up` on the dev host this was built on failed immediately: `5433` was already bound by an
unrelated project's Postgres container (`omega-dev-postgres`), and once that was worked around, `4000` (the
backend's original host port) turned out to be bound by **myhub's own** `portal-backend-dev`. Current mapping on
that host: Postgres host port **5436** (5432–5435 were all taken), backend API host port **4010** (4000 was
taken). **Always run `docker ps --format "{{.Names}}\t{{.Ports}}"` before the first `docker compose up` on any
given machine** and adjust `docker-compose.yml`'s host-side port numbers if these collide on yours — the
container-internal ports (5432, 4000, 3000) never need to change, only the host-side mapping. This is exactly
why every container here is named `business-scout-*` and the Compose project is namespaced: so a collision is a
five-second port remap, never a risk of two projects colliding on the same container/volume/network.

## Chromium-in-container risk — retire it early

`backend/Dockerfile`'s Python stage is based on `mcr.microsoft.com/playwright/python` **even before Tier-2
enrichment is implemented**, specifically so the "does Chromium actually launch in this container" question is
answered in Phase 0, not discovered as a surprise later.

## CI (GitHub Actions)

One workflow, matrix jobs: Node(frontend) gates, Node(backend/api) gates, Python(backend/worker) gates, plus
`docker compose build` for both images. A push that fails any gate cannot merge. Pre-commit hooks run the same
gates locally so CI failures are rare, not the first line of defense.

## Testing policy — no browser automation against our own app

Do not use Chrome/browser automation (Playwright-as-a-test-runner, Chrome DevTools MCP, computer-use) to verify
this app's own frontend or API. Use Vitest/RTL/supertest/pytest instead — see the frontend/backend skill files.
**This does not apply to Playwright as a product dependency**: the worker's Tier-2 enrichment legitimately uses
headless Chromium to render *other businesses'* websites for scraping — that's core product functionality, kept
exactly as designed, and is not what this rule restricts.

## Secrets

Everything through env vars, never hardcoded. `.env` is gitignored; `.env.example` is the tracked template
listing every var. Rotate the dev-default Postgres password and any placeholder secret before any deployment
beyond local dev.

## Free-by-default cost model

Discovery (Overpass), enrichment Tiers 1–2, and the map UI cost nothing. The LLM tier (Tier 3) defaults to
Ollama (local, free) and can be switched off entirely (`use_ai_extraction=false`). The Google-rating feature is
a manual, per-business, user-clicked action — never part of an automated pipeline, so it never runs up cost on
its own. Keep it this way; don't wire any automatic path to a paid API without an explicit decision recorded in
`md/plans/`.
