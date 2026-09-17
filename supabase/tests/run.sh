#!/usr/bin/env bash
# Apply the migration to a scratch Postgres and run the schema assertions.
#
# This exists because RLS is the authorization layer: a policy that looks
# right and silently denies everything, or silently allows everything, is
# not something code review reliably catches. One of these tests found a
# name-capture bug where `p.id = remix_of` resolved to `p.id = p.remix_of`
# and rejected every legitimate remix while appearing correct.
#
# Usage:  supabase/tests/run.sh
# Needs:  postgresql server binaries on PATH or at /usr/lib/postgresql/*/bin
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGDATA="${PGDATA:-/tmp/impose-schema-test}"
PGPORT="${PGPORT:-5433}"
PGHOST=/tmp

if ! command -v initdb >/dev/null 2>&1; then
  PGBIN="$(echo /usr/lib/postgresql/*/bin | tr ' ' '\n' | tail -1)"
  [ -x "$PGBIN/initdb" ] || { echo "postgres binaries not found" >&2; exit 2; }
  export PATH="$PGBIN:$PATH"
fi

cleanup() { pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT

rm -rf "$PGDATA"
initdb -D "$PGDATA" -U postgres --auth=trust >/dev/null
pg_ctl -D "$PGDATA" -o "-p $PGPORT -k $PGHOST" -l "$PGDATA/server.log" start >/dev/null
sleep 2

psql() { command psql -h "$PGHOST" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

# The parts of Supabase the migration leans on. Kept deliberately small:
# this is a stand-in for auth.users, auth.uid() and the two API roles, not
# a simulation of Supabase.
psql <<'SQL'
create schema if not exists auth;
create extension if not exists pgcrypto;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  raw_user_meta_data jsonb default '{}'::jsonb
);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
create role anon;
create role authenticated;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
SQL

psql -f "$ROOT/supabase/migrations/0001_mvp.sql" >/dev/null

# Supabase grants these to the API roles when a table is exposed; the
# migration controls access through RLS, not through GRANT.
psql <<'SQL'
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.generations, public.comments to anon, authenticated;
grant select, insert, update, delete on public.generations, public.comments to authenticated;
grant select, insert, delete on public.saves to authenticated;
SQL

command psql -h "$PGHOST" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 \
  -f "$ROOT/supabase/tests/schema_test.sql" 2>&1 |
  grep -E "PASS|FAIL|ERROR|All schema" || true

# psql exits 3 on ON_ERROR_STOP; the pipeline above swallows it, so re-run
# quietly to get a real exit code for CI.
if command psql -h "$PGHOST" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 \
     -f "$ROOT/supabase/tests/schema_test.sql" >/dev/null 2>&1; then
  exit 0
fi
exit 1
