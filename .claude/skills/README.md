<!-- Authored by: Mohit Singh -->

# Skills Index — business-scout-ai

Single source of truth mapping task → skill. Read the relevant skill file **before** touching code in that
part of the stack. These are living documents — update them in place (append/edit, don't restructure without
reason) whenever a convention, pitfall, or pattern is discovered that should outlive the current session.

| Skill | Read before touching... |
|---|---|
| [skills_frontend.md](skills_frontend.md) | `src/routes/`, `src/components/` — TanStack Start/React, Leaflet, recharts, TanStack Query |
| [skills_backend_node.md](skills_backend_node.md) | `backend/api/` — Express API, auth, SSE, validation, error handling |
| [skills_backend_python.md](skills_backend_python.md) | `backend/worker/` — the crawler daemon, discovery, enrichment cascade, dedupe, LLM |
| [skills_db.md](skills_db.md) | `db/migrations/` or any schema change — migration workflow, dedupe/upsert patterns |
| [skills_devops.md](skills_devops.md) | `docker-compose.yml`, `Dockerfile*`, `.github/workflows/` — containers, CI, the dedicated-Postgres rule |
| [skills_security.md](skills_security.md) | auth, secrets, PII (scraped emails/phones), rate limiting |
| [skills_efficiency.md](skills_efficiency.md) | always — how to work this codebase without burning tokens |

## Project identity

- **Product**: business-scout-ai — nearby-business discovery/enrichment crawler with a master DB and public API.
- **Author of record**: Mohit Singh. See `CLAUDE.md` → "File authorship" for the header convention.
- **Not part of any other repository.** Standalone, own Postgres, own deploy.
- **Plan history**: `md/plans/` — read the latest entry before planning new work; approved plans build on prior ones.
