# syntax=docker/dockerfile:1
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
# ⚠️ The base image's TAG must exactly match the `playwright` pip package version installed
# below (pyproject.toml pins it exactly, not a range — see the comment there). Verified real
# failure: the base image ships browser binaries for its own bundled Playwright version only;
# a mismatched pip-installed version fails immediately with
# "BrowserType.launch: Executable doesn't exist at /ms-playwright/..." — and Playwright's own
# error message names the exact base-image tag to switch to. Bump both together, never one
# alone. See .claude/skills/skills_devops.md.
#
# --- Build-speed notes (Phase 8 performance pass) ---
# 1. Dependency layers are split from source layers everywhere (npm ci / pip install run
#    against ONLY the lockfile/pyproject, before the actual application source is COPY'd in) —
#    a source-only change (the common case during active development) then only re-runs the
#    cheap "copy source" + "compile/link" steps, never a full dependency re-resolve/reinstall.
#    Previously the Python worker's `pip install ./worker` ran AFTER
#    `COPY worker/business_scout_worker`, so every single code edit busted that layer and
#    forced a full ~30-60s reinstall of psycopg/playwright/pydantic/etc from PyPI — verified
#    real, not hypothetical (every source-changing rebuild this session hit it).
# 2. BuildKit cache mounts (`--mount=type=cache`) persist npm/pip/apt's own download caches
#    ACROSS separate `docker build` invocations, on top of (not instead of) Docker's normal
#    layer cache — even when a layer must legitimately re-run (e.g. lockfile changed), the
#    package manager still avoids re-downloading anything it already fetched before.
# 3. `docker compose build`/`up --build` already builds independent services (backend,
#    frontend) IN PARALLEL by default in Compose v2 — no extra flag needed, nothing to change
#    here. Sequential-looking build log output is just interleaved logging, not sequential work.

# --- node-build: compile the Node API -------------------------------------
FROM node:24-alpine AS node-build
WORKDIR /app/api
COPY api/package.json api/package-lock.json ./
# --mount=type=cache: npm's own package cache survives across builds (separate from the
# node_modules layer itself, which still fully invalidates/reinstalls whenever the lockfile
# changes — that's correct and unavoidable, this only avoids re-downloading from the registry).
RUN --mount=type=cache,target=/root/.npm npm ci
COPY api/ .
RUN npm run build && npm prune --omit=dev

# --- final: Playwright/Python base + Node runtime + both services ----------
FROM mcr.microsoft.com/playwright/python:v1.61.0-noble

# Node.js runtime (the Playwright/Python base image ships Python only) + tesseract-ocr (the
# Crawl-OCR module's OCR engine — see business_scout_worker/ocr/). apt's package cache AND
# repo-listing metadata are both BuildKit-cache-mounted — a cache mount lives outside the image
# layer entirely (BuildKit keeps it on the host, not in any committed layer), so there's no
# `rm -rf /var/lib/apt/lists/*` needed here to keep the final image lean; it was never written
# to a layer in the first place.
RUN --mount=type=cache,target=/var/cache/apt --mount=type=cache,target=/var/lib/apt/lists \
  apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates tesseract-ocr \
  && curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
  && apt-get install -y --no-install-recommends nodejs

# supervisord — manages the two sibling processes inside this one container
RUN --mount=type=cache,target=/root/.cache/pip pip install supervisor

WORKDIR /app

# --- Python worker: dependency layer, isolated from source (see build-speed notes above) ---
# `pip install ./worker` needs SOME package contents to exist (hatchling reads pyproject.toml's
# `packages = ["business_scout_worker"]`), so this installs against a stub `__init__.py` in
# --editable mode — editable install means site-packages gets a path-reference (.pth/import
# hook) back to ./worker/business_scout_worker, NOT a copy. The real source COPY'd in right
# after is then immediately live with zero reinstall, and this whole dependency-install layer
# only re-runs when pyproject.toml itself actually changes.
COPY worker/pyproject.toml ./worker/pyproject.toml
RUN mkdir -p ./worker/business_scout_worker && touch ./worker/business_scout_worker/__init__.py
RUN --mount=type=cache,target=/root/.cache/pip pip install --editable ./worker

# --- Python worker: real source (fast — no reinstall, editable install already points here) ---
COPY worker/business_scout_worker ./worker/business_scout_worker

# --- Node API (compiled output only — no source, no devDependencies) ---
COPY --from=node-build /app/api/dist ./api/dist
COPY --from=node-build /app/api/node_modules ./api/node_modules
COPY --from=node-build /app/api/package.json ./api/package.json

# --- DB migrations + migrate-on-start entrypoint ---
# Migrations live at the repo root (db/migrations), OUTSIDE this image's ./backend build
# context — docker-compose.yml passes them in as a named additional context (`migrations`).
# The entrypoint applies them (via node-pg-migrate, a runtime dependency of api/ precisely so
# it survives `npm prune --omit=dev`) before starting supervisord — see docker-entrypoint.sh
# for the real schema-drift incident that motivated this.
COPY --from=migrations . ./db/migrations
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

COPY supervisord.conf /etc/supervisor/supervisord.conf

ENV NODE_ENV=production
EXPOSE 4000

CMD ["/docker-entrypoint.sh"]
