# Authored by: Mohit Singh
#
# IMAGE 1 of 2 — frontend (TanStack Start, SSR). Pure API client of the `backend` image; no
# business logic here. See CLAUDE.md and md/plans/0001-business-scout-ai-crawler.md.

# --- deps -------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

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
COPY --from=build /app/.output/server ./
EXPOSE 3000
CMD ["node", "index.mjs"]
