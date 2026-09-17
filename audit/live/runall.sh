#!/usr/bin/env bash
# Credentials come from the environment, never from the file. An earlier
# version of this script carried the access token inline and GitHub's
# secret scanning rejected the push, which was the correct outcome: a
# committed token is a leaked token.
#
#   export SUPABASE_ACCESS_TOKEN=sbp_...
# Each suite gets a clean database. A suite that inherits the previous
# one's rows is testing the last run, not the product.
: "${SUPABASE_ACCESS_TOKEN:?export SUPABASE_ACCESS_TOKEN first}"
wipe() {
  curl -s -m 30 -X POST "https://api.supabase.com/v1/projects/xgqcvuzkeaferjsnpjjw/database/query" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
    -d '{"query":"delete from public.comments; delete from public.generations; delete from public.idempotency_keys;"}' >/dev/null
}
TOT=0; BAD=0
for t in sec_audit adv_audit cutover writetest offline failtest journey ui_audit deeplink; do
  wipe
  out=$(timeout 600 python3 $t.py 2>&1 | tail -1)
  echo "$(printf '%-12s' $t) $out"
  n=$(echo "$out" | grep -o '^[0-9]*' || echo 0)
  f=$(echo "$out" | sed -n 's/.*, \([0-9]*\) failed/\1/p')
  TOT=$((TOT + ${n:-0})); BAD=$((BAD + ${f:-0}))
done
wipe
echo "-----"
echo "TOTAL: $TOT passed, $BAD failed"
