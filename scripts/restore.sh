#!/usr/bin/env bash
set -euo pipefail
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL must point to an empty REMI-only database}"
: "${AGE_IDENTITY_FILE:?AGE_IDENTITY_FILE is required}"
backup_file="${1:?Usage: restore.sh BACKUP.dump.age}"

age --decrypt --identity "$AGE_IDENTITY_FILE" "$backup_file" \
  | pg_restore --dbname="$RESTORE_DATABASE_URL" --no-owner --no-acl --exit-on-error
psql "$RESTORE_DATABASE_URL" --set=ON_ERROR_STOP=1 --command \
  "SELECT count(*) AS applied_migrations FROM schema_migrations;"
