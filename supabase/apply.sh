#!/usr/bin/env bash
# Apply the migration to the live Supabase project.
#
# This needs a credential that can run DDL, which the publishable key
# deliberately is not. Supabase gates schema changes behind either the
# database password or a personal access token, and that is the correct
# design: a key shipped to every browser must never be able to drop a
# table. So this script asks for one of the two and never stores it.
#
# Pick whichever is less friction:
#
#   A. Database password  (Dashboard, Project Settings, Database)
#        SUPABASE_DB_PASSWORD=... supabase/apply.sh
#
#   B. Personal access token  (Dashboard, Account, Access Tokens)
#        SUPABASE_ACCESS_TOKEN=sbp_... supabase/apply.sh
#
# Both run the same file: supabase/migrations/0001_mvp.sql, already
# verified against Postgres 17 by supabase/tests/run.sh.
set -euo pipefail

REF="${SUPABASE_PROJECT_REF:-xgqcvuzkeaferjsnpjjw}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

MIGRATION_ARG="${1:-}"
if [ -n "$MIGRATION_ARG" ] && [ -f "$MIGRATION_ARG" ]; then
  FILES=("$MIGRATION_ARG")
elif [ -n "$MIGRATION_ARG" ]; then
  # Incremental mode: an existing database already carries the early
  # migrations, and 0001/0007/0022 are data-destructive on re-run, so a
  # full replay is never the right answer for it. List every file at or
  # after the one named; they apply in order and ON_ERROR_STOP halts on
  # the first failure, so nothing later can land half-verified. The
  # caller must name the first migration the database does not yet
  # carry; bump the anchor in the workflow after each apply.
  if [ ! -f "$ROOT/supabase/migrations/$MIGRATION_ARG" ]; then
    echo "unknown start migration: $MIGRATION_ARG" >&2; exit 2
  fi
  FILES=()
  take=0
  for f in $(ls "$ROOT/supabase/migrations/"*.sql | sort); do
    [ "$(basename "$f")" = "$MIGRATION_ARG" ] && take=1
    [ $take -eq 1 ] && FILES+=("$f")
  done
else
  FILES=( $(ls "$ROOT/supabase/migrations/"*.sql | sort) )
fi

[ ${#FILES[@]} -gt 0 ] || { echo "no migrations found in $ROOT/supabase/migrations/" >&2; exit 2; }

# ---- route A: psql straight at the pooler -------------------------------
if [ -n "${SUPABASE_DB_PASSWORD:-}" ]; then
  command -v psql >/dev/null 2>&1 || {
    PGBIN="$(echo /usr/lib/postgresql/*/bin | tr ' ' '\n' | tail -1)"
    export PATH="$PGBIN:$PATH"
  }
  # The session pooler is reachable over IPv4; db.<ref> is IPv6-only on
  # newer projects and fails from most CI and container networks.
  #
  # The pooler is regional and the hostname does not encode the project, so
  # the right host has to be found rather than assumed. A wrong host answers
  # "Tenant or user not found" and a right one answers about the password,
  # which makes the distinction reliable without a valid credential.
  # SUPABASE_DB_HOST short-circuits the search.
  if [ -n "${SUPABASE_DB_HOST:-}" ]; then
    HOSTS="$SUPABASE_DB_HOST"
  else
    HOSTS=""
    for prefix in aws-0 aws-1; do
      for region in eu-west-2 eu-west-1 eu-central-1 us-east-1 us-east-2 \
                    us-west-1 us-west-2 ap-south-1 ap-southeast-1 \
                    ap-southeast-2 ap-northeast-1 ca-central-1 sa-east-1; do
        HOSTS="$HOSTS $prefix-$region.pooler.supabase.com"
      done
    done
  fi

  FOUND=""
  for HOST in $HOSTS; do
    set +e
    PROBE="$(PGCONNECT_TIMEOUT=8 PGPASSWORD="$SUPABASE_DB_PASSWORD" psql \
      "postgresql://postgres.$REF@$HOST:5432/postgres?sslmode=require" \
      -tAc 'select 1' 2>&1)"
    set -e
    PROBE="$(printf '%s' "$PROBE" | tr -d '\r' | head -1)"
    case "$PROBE" in
      1) FOUND="$HOST"; break ;;
      *"Tenant or user not found"*|*ENOTFOUND*) continue ;;
      *"password authentication failed"*)
        echo "found the project at $HOST, but the database password was rejected." >&2
        echo "Copy it from Project Settings > Database > Database password." >&2
        exit 1 ;;
      *) continue ;;
    esac
  done

  if [ -z "$FOUND" ]; then
    echo "could not find the pooler host for project $REF." >&2
    echo "Set SUPABASE_DB_HOST to the host shown under Project Settings > Database > Connection string." >&2
    exit 1
  fi

  echo "applying migrations via $FOUND ..."
  for SQL in "${FILES[@]}"; do
    echo "  -> $(basename "$SQL")"
    PGPASSWORD="$SUPABASE_DB_PASSWORD" psql \
      "postgresql://postgres.$REF@$FOUND:5432/postgres?sslmode=require" \
      -v ON_ERROR_STOP=1 -f "$SQL"
  done
  echo "all migrations applied via $FOUND"
  exit 0
fi

# ---- route B: management API -------------------------------------------
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "applying migrations via the management API ..."
  for SQL in "${FILES[@]}"; do
    echo "  -> $(basename "$SQL")"
    RESPONSE="$(python3 - "$SQL" <<'PY'
import json, os, sys, urllib.request, urllib.error
sql = open(sys.argv[1]).read()
ref = os.environ.get("SUPABASE_PROJECT_REF", "xgqcvuzkeaferjsnpjjw")
req = urllib.request.Request(
    f"https://api.supabase.com/v1/projects/{ref}/database/query",
    data=json.dumps({"query": sql}).encode(),
    headers={
        "Authorization": "Bearer " + os.environ["SUPABASE_ACCESS_TOKEN"],
        "Content-Type": "application/json",
    },
    method="POST",
)
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        print("OK", r.status)
except urllib.error.HTTPError as e:
    print("ERR", e.code, e.read().decode()[:400])
PY
)"
    echo "     $RESPONSE"
    case "$RESPONSE" in OK*) ;; *) exit 1 ;; esac
  done
  echo "all migrations applied successfully"
  exit 0
fi

cat >&2 <<'MSG'
No credential supplied.

  SUPABASE_DB_PASSWORD=...   supabase/apply.sh     # Settings > Database
  SUPABASE_ACCESS_TOKEN=...  supabase/apply.sh     # Account > Access Tokens

Neither is stored. If you would rather not hand one over, open the SQL
editor in the dashboard and paste supabase/migrations/0001_mvp.sql; it is
the same file and needs no edits.
MSG
exit 2
