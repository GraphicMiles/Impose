-- Grant the relay's own functions to the role that calls them.
--
-- Signing up answered 502. The relay could reach Supabase perfectly well;
-- Supabase refused the call:
--
--   permission denied for function issue_auth_code
--
-- 0003 wrote `revoke all on function ... from public` for each of these,
-- which is correct and deliberate: they are privileged and must not be
-- callable from a browser. But revoking from PUBLIC also removes the
-- implicit grant that service_role was relying on, and no matching grant
-- was ever written. The functions became callable by nobody.
--
-- It was invisible in testing because the schema suite runs as the owner,
-- and an owner is not subject to its own EXECUTE grants. Every assertion
-- passed while the deployed path was dead. The suite now signs in as
-- service_role for these, so the gap cannot reopen silently.
--
-- service_role only. These four decide whether a code is valid, whether a
-- ticket may be spent, and whether a caller is over its rate limit. A
-- browser holding the publishable key must never be able to ask.

grant execute on function public.issue_auth_code(citext, text, text, uuid, integer, integer) to service_role;
grant execute on function public.consume_auth_code(citext, text, text, integer) to service_role;
grant execute on function public.redeem_auth_ticket(text) to service_role;
grant execute on function public.rate_hit(text, integer, integer) to service_role;

-- Housekeeping functions, same reasoning: called by the relay, never by a
-- client.
grant execute on function public.purge_expired_auth_codes() to service_role;
grant execute on function public.purge_idempotency_keys() to service_role;
grant execute on function public.purge_rate_counters() to service_role;

-- The tables those functions touch. RLS is on with no policies, and
-- service_role bypasses RLS, but bypassing RLS does not bypass a missing
-- table grant: PostgREST would still refuse. Explicit, for the same reason
-- the function grants are explicit.
grant select, insert, update, delete on public.auth_codes   to service_role;
grant select, insert, update, delete on public.auth_tickets to service_role;
grant select, insert, update, delete on public.rate_counters to service_role;

-- Anon and authenticated are deliberately absent from every line above.
