# Authored by: Mohit Singh
#
# IMAGE 2 of 2 — backend. ONE image, TWO sibling processes managed by supervisord:
#   - Node API (backend/api)      — the only HTTP surface of the whole system
#   - Python worker (backend/worker) — the crawler daemon (no HTTP; DB-only control)
# They never call each other directly — see CLAUDE.md and skills_devops.md.
#
# Base is the Playwright/Python image from Phase 0 onward (even though Playwright itself
# isn't used by worker code until Phase 4) specifically to retire the "does Chromium launch
# in this container" risk early, per md/plans/0001-business-scout-ai-crawler.md Phase 0.
#
# Phase 0 scope note: no schema/migrations exist yet (Phase 1). When db/migrations and
# node-pg-migrate land, this Dockerfile gains a migration-on-start step ahead of supervisord.

# --- node-build: compile the Node API -------------------------------------
FROM node:24-alpine AS node-build
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
RUN npm ci
COPY api/ .
RUN npm run build && npm prune --omit=dev

# --- final: Playwright/Python base + Node runtime + both services ----------
FROM mcr.microsoft.com/playwright/python:v1.49.0-noble

# Node.js runtime (the Playwright/Python base image ships Python only)
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# supervisord — manages the two sibling processes inside this one container
RUN pip install --no-cache-dir supervisor

WORKDIR /app

# --- Python worker ---
COPY worker/pyproject.toml ./worker/pyproject.toml
COPY worker/business_scout_worker ./worker/business_scout_worker
RUN pip install --no-cache-dir ./worker

# --- Node API (compiled output only — no source, no devDependencies) ---
COPY --from=node-build /app/api/dist ./api/dist
COPY --from=node-build /app/api/node_modules ./api/node_modules
COPY --from=node-build /app/api/package.json ./api/package.json

COPY supervisord.conf /etc/supervisor/supervisord.conf

ENV NODE_ENV=production
EXPOSE 4000

CMD ["supervisord", "-c", "/etc/supervisor/supervisord.conf", "-n"]
