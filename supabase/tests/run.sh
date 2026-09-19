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

# Find the server binaries. They are not on PATH by default on Debian and
# Ubuntu (only the client is), and a machine can carry several versions, so
# take the highest rather than whatever the glob happens to yield first.
if ! command -v initdb >/dev/null 2>&1; then
  PGBIN=""
  for d in $(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V); do
    [ -x "$d/initdb" ] && PGBIN="$d"
  done
  if [ -z "$PGBIN" ]; then
    echo "postgres server binaries not found." >&2
    echo "  Debian/Ubuntu:  sudo apt-get install -y postgresql" >&2
    echo "  macOS:          brew install postgresql@17" >&2
    exit 2
  fi
  export PATH="$PGBIN:$PATH"
fi

cleanup() { pg_ctl -D "$PGDATA" stop -m immediate >/dev/null 2>&1 || true; }
trap cleanup EXIT

rm -rf "$PGDATA"
# UTF8 pinned: the suite stores zero-width marks and unicode escapes, which
# need a multibyte encoding, and Supabase itself always runs UTF8. Without
# the flag a C-locale host initializes SQL_ASCII and the suite fails with an
# encoding error that has nothing to do with the schema under test.
initdb -D "$PGDATA" -U postgres --auth=trust -E UTF8 >/dev/null
pg_ctl -D "$PGDATA" -o "-p $PGPORT -k $PGHOST" -l "$PGDATA/server.log" start >/dev/null
sleep 2

psql() { command psql -h "$PGHOST" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

# The parts of Supabase the migration leans on. Kept deliberately small:
# this is a stand-in for auth.users, auth.uid() and the two API roles, not
# a simulation of Supabase.
psql <<'SQL'
create schema if not exists auth;
-- Supabase puts pgcrypto in `extensions`, not `public`. Reproducing that
-- here is the difference between a harness that catches a missing schema
-- qualification and one that hides it: the RPCs pin search_path to public
-- for safety, so an unqualified digest() works locally and fails on the
-- real project. That exact bug shipped and was found by calling the live
-- API, which is a worse place to find it.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
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
-- service_role was missing here, and that omission is why a missing
-- EXECUTE grant shipped: the suite runs as the owner, an owner is not
-- subject to its own grants, so every assertion passed while the deployed
-- path was dead. Supabase grants this role bypassrls; the local stand-in
-- needs the same shape or the privileged tests prove nothing.
create role service_role bypassrls;
-- Supabase ships this publication; realtime subscriptions are expressed as
-- membership of it. Without it here, a migration that publishes a table
-- errors, and worse, an accidental "add table auth_codes" would never be
-- caught locally.
create publication supabase_realtime;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
SQL

# Every migration, in order. Testing only the first one would let a later
# migration break the schema and still report green.
for m in "$ROOT"/supabase/migrations/*.sql; do
  psql -f "$m" >/dev/null
done

# Supabase grants these to the API roles when a table is exposed; the
# migration controls access through RLS, not through GRANT.
psql <<'SQL'
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.generations, public.comments to anon, authenticated;
grant select, insert, update, delete on public.generations, public.comments to authenticated;
grant select, insert, delete on public.saves to authenticated;
SQL

# Run once, keep the real exit status, and show the output. Running it a
# second time to recover the status (the obvious fix for a pipeline eating
# it) is wrong: the assertions insert fixture rows, so the rerun hits
# unique violations on a dirty database and reports failure on a suite
# that actually passed.
set +e
command psql -h "$PGHOST" -p "$PGPORT" -U postgres -v ON_ERROR_STOP=1 \
  -f "$ROOT/supabase/tests/schema_test.sql" >"$PGDATA/test.out" 2>&1
STATUS=$?
set -e

grep -E "PASS|FAIL|ERROR|All schema" "$PGDATA/test.out" | sed 's/^psql:[^ ]* //' || true

if [ "$STATUS" -ne 0 ]; then
  echo ""
  echo "schema assertions FAILED (psql exit $STATUS)"
  exit 1
fi
exit 0
