-- API grants.
--
-- The project is configured not to expose new tables automatically, which
-- is the right default: it means a table added later is unreachable until
-- someone decides otherwise, rather than world-readable by accident.
--
-- The consequence is that RLS alone is not enough. PostgREST checks the
-- role's table privileges first, so without a GRANT every request is 401
-- regardless of how permissive the policies are. This file is the explicit
-- decision about what the browser roles may touch.
--
-- Two layers, deliberately:
--   GRANT decides which tables exist as far as the API is concerned.
--   RLS decides which rows within them, and is already in 0001-0004.
--
-- Everything absent from this file stays unreachable: auth_codes,
-- auth_tickets, rate_counters, waitlist and workspace_grants are reached
-- only by the service role or through a security definer function.

grant usage on schema public to anon, authenticated;

-- Readable by anyone, including signed-out visitors browsing Community.
-- Row visibility is still decided by RLS: private posts and the bodies of
-- deleted comments are filtered there, not here.
grant select on public.profiles    to anon, authenticated;
grant select on public.generations to anon, authenticated;
grant select on public.comments    to anon, authenticated;

-- Writes require an account. No INSERT on generations or comments: those
-- go through create_generation and create_comment, which carry the
-- idempotency key and the parent checks. Granting direct INSERT would let
-- a client bypass both.
grant update (locked, visibility, deleted_at) on public.generations to authenticated;
grant update (deleted_at) on public.comments to authenticated;

-- Saves are a plain per-user row with no derived state, so direct access
-- is fine and the RLS policy already pins user_id to auth.uid().
grant select, insert, delete on public.saves to authenticated;

-- Own keys are readable so a client can confirm a retry landed. Never
-- writable: the RPCs insert them.
grant select on public.idempotency_keys to authenticated;

-- The RPCs. These are the write path.
grant execute on function public.create_generation(uuid,text,text,boolean,text,text,text,uuid) to authenticated;
grant execute on function public.create_comment(uuid,uuid,uuid,text) to authenticated;
grant execute on function public.soft_delete_comment(uuid) to authenticated;
grant execute on function public.restore_comment(uuid, text) to authenticated;
grant execute on function public.feed_page(timestamptz, uuid, integer) to anon, authenticated;
grant execute on function public.feed_since(timestamptz) to anon, authenticated;
grant execute on function public.thread_for(uuid) to anon, authenticated;
grant execute on function public.join_waitlist(text) to anon, authenticated;
grant execute on function public.my_workspace_access() to authenticated;

-- A new table must not inherit access by being created. Anything added
-- later is invisible to the API until a migration says otherwise, which is
-- the same decision the dashboard toggle expresses.
alter default privileges in schema public revoke all on tables from anon, authenticated;
