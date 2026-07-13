<!-- Authored by: Mohit Singh -->

# business-scout-ai — Agent Instructions

> Mirrored across `AGENTS.md` and `CLAUDE.md` so the same instructions load in any AI coding environment.

Standalone product. Not part of any other repository. See `CLAUDE.md` for the full architecture, conventions,
and phase plan — **its "Current status" section is the fastest way to orient in a new session** (what's built,
what's next, known follow-ups). **Before planning new work, read the latest entry in `md/plans/`** — approved
plans are the project's durable history and every new plan must build on the last one.

## Quick facts

- **Stack**: hybrid Node (frontend + API) + Python (crawler worker), one shared PostgreSQL database.
- **Deployment**: exactly 2 application images (`frontend`, `backend`) + 1 dedicated Postgres instance.
- **Skills**: `.claude/skills/README.md` is the index — read the relevant skill file before touching that layer.
- **Authorship**: every source file created in this project carries an `Authored by: Mohit Singh` header. No
  attribution to any third-party scaffold tool belongs in this project's documentation.
