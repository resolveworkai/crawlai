# syntax=docker/dockerfile:1
# Authored by: Mohit Singh
#
# IMAGE 1 of 2 — frontend (TanStack Start, SSR). Pure API client of the `backend` image; no
# business logic here. See CLAUDE.md and md/plans/0001-business-scout-ai-crawler.md.
#
# Build-speed: the deps stage already only depends on package.json/package-lock.json (not the
# app source), so a source-only change never re-triggers `npm ci` — only the build stage's
# `COPY . .` + `npm run build` re-run. The cache mount below additionally persists npm's own
# download cache across separate `docker build` invocations (e.g. after a lockfile change) so
# even a full `npm ci` doesn't re-fetch packages already downloaded once. See
# backend/Dockerfile's build-speed notes for the fuller writeup (same principles, applied there
# to the worse case that used to exist for the Python worker).

# --- deps -------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

# --- build --------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NITRO_PRESET override is required: the Lovable-guarded vite.config.ts leaves Nitro's
# preset unset, which defaults to a Cloudflare Workers build (wrangler.json, not runnable
# with plain `node`). node-server produces a real Node server entrypoint instead — see
# .claude/skills/skills_devops.md "Frontend build gotcha".
ENV NITRO_PRESET=node-server
# The browser cannot resolve the Docker-internal "backend" hostname, and Vite bakes
# VITE_-prefixed vars into the client bundle at BUILD time (not container start time) — so
# this must be a build-arg, not a docker-compose `environment:` entry. See .env.example.
ARG VITE_API_URL=http://localhost:4010
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

# --- runtime ------------------------------------------------------------
FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Nitro's node-server preset resolves its static-assets directory as "../public" RELATIVE TO
# THE SERVER ENTRYPOINT'S OWN DIRECTORY — it assumes the `.output/{server,public}` sibling
# layout verbatim. Flattening `.output/server`'s contents straight into `/app` (the previous
# version of this stage) broke that: with the entrypoint living directly in `/app`, "../public"
# resolves to the filesystem root `/public` (which doesn't exist), not `/app/public`. Verified
# real bug: every /assets/*.js + favicon.ico request 500'd with `ENOENT: ... open
# '/public/assets/...'` and the page never rendered past the loading shell — copying `public/`
# into `/app/public` alone did NOT fix it (confirmed by testing), because the path Nitro computes
# doesn't depend on what exists on disk, only on the entrypoint's own directory. Fix: preserve
# the sibling structure — both dirs live under /app, entrypoint is `server/index.mjs`.
COPY --from=build /app/.output/server ./server
COPY --from=build /app/.output/public ./public
EXPOSE 3000
CMD ["node", "server/index.mjs"]
