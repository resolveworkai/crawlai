#!/bin/sh
# Authored by: Mohit Singh
#
# Backend container entrypoint: apply pending DB migrations, THEN start both services.
# This closes a real schema-drift gap (verified live, 2026-07-13): a new migration file that
# was never manually applied to the running dev database made every enrichment write fail with
# "column enrichment_tier does not exist" — the container simply had no migrations-on-start
# step even though the plan (md/plans/0001-*.md Phase 0) always specified one. Fail-fast on a
# migration error (set -e): a backend that boots against a schema it doesn't match just fails
# more confusingly later, so refuse to start instead.
#
# node-pg-migrate reads its connection from DATABASE_URL (already in the container env — note
# it IGNORES discrete DB_HOST/DB_USER-style vars, a known gotcha). Migrations are copied into
# the image at /app/db/migrations via a compose `additional_contexts` (they live at the repo
# root, outside this image's ./backend build context — see docker-compose.yml).
set -e

echo "[entrypoint] applying database migrations..."
/app/api/node_modules/.bin/node-pg-migrate up -m /app/db/migrations -j sql
echo "[entrypoint] migrations up to date — starting services"

exec supervisord -c /etc/supervisor/supervisord.conf -n
