#!/usr/bin/env bash
# Authored by: Mohit Singh
#
# Soft check (never fails the commit) — warns when a changed source file is missing the
# "Authored by: Mohit Singh" header. See CLAUDE.md "Project convention — file authorship".
set -u

for f in "$@"; do
  if ! grep -qm1 "Authored by: Mohit Singh" "$f"; then
    echo "warning: missing authorship header: $f"
  fi
done

exit 0
