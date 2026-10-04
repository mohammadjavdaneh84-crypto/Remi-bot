#!/usr/bin/env bash
set -euo pipefail

forbidden=$(git ls-files | grep -E '(^|/)(\.env($|\.)|node_modules|dist|coverage|backups|tmp|temp)(/|$)|\.(db|sqlite|sqlite3|session|log)([-.]|$)' || true)
if [[ -n "$forbidden" ]]; then
  printf 'Forbidden runtime or secret-like files are tracked:\n%s\n' "$forbidden" >&2
  exit 1
fi

if git grep -IlE '(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----|[0-9]{6,12}:[A-Za-z0-9_-]{30,})' -- . ':!package-lock.json' | grep -q .; then
  echo 'Potential credential material detected in tracked files.' >&2
  exit 1
fi
