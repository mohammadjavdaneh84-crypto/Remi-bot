#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL must target REMI's own database}"
: "${BACKUP_RECIPIENT:?BACKUP_RECIPIENT (age recipient) is required}"

output_dir="${BACKUP_OUTPUT_DIR:-./backups}"
mkdir -p "$output_dir"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
output="$output_dir/remi-$stamp.dump.age"
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl \
  | age --recipient "$BACKUP_RECIPIENT" --output "$output"
printf '%s\n' "$output"
