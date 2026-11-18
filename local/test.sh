#!/usr/bin/env bash
# Runs all migrations + tests on a throwaway local Postgres 16.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN=/usr/lib/postgresql/16/bin
DATA=$(mktemp -d); PORT=55432
$BIN/initdb -D "$DATA" -U postgres -A trust >/dev/null
$BIN/pg_ctl -D "$DATA" -o "-p $PORT -k /tmp" -l "$DATA/log" start >/dev/null
trap '$BIN/pg_ctl -D "$DATA" stop -m fast >/dev/null; rm -rf "$DATA"' EXIT
P="psql -h /tmp -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
$P -c 'create database t' >/dev/null
$P -d t -f "$ROOT/local/supabase_stubs.sql"
for f in "$ROOT"/supabase/migrations/*.sql; do
  if grep -q 'extension if not exists vector' "$f" && [ ! -f /usr/share/postgresql/16/extension/vector.control ]; then
    echo "skip $(basename "$f") (pgvector not installed locally)"; continue; fi
  # pg_net / pg_cron exist only on Supabase; strip them for the local run
  sed '/extension if not exists pg_net/d; /extension if not exists pg_cron/d' "$f" | $P -d t; echo "applied $(basename "$f")"
done
$P -d t -c 'grant select, insert, update, delete on all tables in schema public to authenticated, service_role'
for f in "$ROOT"/supabase/tests/*.sql; do echo "== $(basename "$f")"; $P -d t -f "$f" 2>&1 | sed 's/^psql:.*NOTICE:  /  /'; done
