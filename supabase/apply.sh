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
SQL="$ROOT/supabase/migrations/0001_mvp.sql"

[ -f "$SQL" ] || { echo "migration not found: $SQL" >&2; exit 2; }

# ---- route A: psql straight at the pooler -------------------------------
if [ -n "${SUPABASE_DB_PASSWORD:-}" ]; then
  command -v psql >/dev/null 2>&1 || {
    PGBIN="$(echo /usr/lib/postgresql/*/bin | tr ' ' '\n' | tail -1)"
    export PATH="$PGBIN:$PATH"
  }
  # The session pooler is reachable over IPv4; db.<ref> is IPv6-only on
  # newer projects and fails from most CI and container networks.
  for HOST in \
    "aws-0-eu-central-1.pooler.supabase.com" \
    "aws-0-us-east-1.pooler.supabase.com" \
    "aws-0-us-west-1.pooler.supabase.com" \
    "aws-0-ap-southeast-1.pooler.supabase.com"
  do
    echo "trying $HOST ..."
    if PGPASSWORD="$SUPABASE_DB_PASSWORD" psql \
         "postgresql://postgres.$REF@$HOST:5432/postgres?sslmode=require" \
         -v ON_ERROR_STOP=1 -f "$SQL" 2>/tmp/apply.err; then
      echo "migration applied via $HOST"
      exit 0
    fi
    grep -qi "password authentication failed" /tmp/apply.err && {
      echo "the database password was rejected" >&2; exit 1; }
  done
  echo "could not reach any pooler host; last error:" >&2
  tail -3 /tmp/apply.err >&2
  exit 1
fi

# ---- route B: management API -------------------------------------------
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  echo "applying via the management API ..."
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
  echo "$RESPONSE"
  case "$RESPONSE" in OK*) exit 0 ;; *) exit 1 ;; esac
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
