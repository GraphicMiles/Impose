-- 0025: lifecycle closures from the deep-completion audit (workspace
-- report impose-deep-completion-audit-2026-09-19.md). Idempotent,
-- identity-argument discipline preserved (no new overloads).
--
--   1. admin_revoke_grant    — the missing half of the grant lifecycle.
--   2. blocked_terms mgmt    — admin_block_term / admin_unblock_term /
--                              admin_blocked_terms, so moderation is not
--                              SQL-only.
--   3. edit_generation       — prompt-only post editing, author-gated,
--                              blocklist-checked, with its own budget.
--   4. purge_old_notifications — retention for read notifications.

-- Action→capability routing for the new admin actions. Insert first so the
-- admin RPCs below resolve require_cap immediately after this migration.
insert into public.admin_action_caps (action, cap) values
  ('admin_revoke_grant', 'waitlist.manage'),
  ('admin_block_term',   'moderation.manage'),
  ('admin_unblock_term', 'moderation.manage'),
  ('admin_blocked_terms','moderation.manage')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 1. admin_revoke_grant: the second half of the workspace-grant lifecycle.
--    Deliberate choices:
--    - 'no_grant' is a status, not an exception: the panel can offer revoke
--      without knowing the grant first, and an idempotent re-run of a
--      revoke is a success state.
--    - sessions are NOT touched: that lever exists separately
--      (relay /admin/revoke_sessions). After revoke, the very next
--      save_workspace call fails server-side with workspace_not_granted;
--      the client's access cache catches up within its 10-minute TTL — the
--      same window the product already accepts for grants.
-- ---------------------------------------------------------------------------
create or replace function public.admin_revoke_grant(p_email citext)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email citext := lower(btrim(coalesce(p_email, '')));
  v_user  uuid;
begin
  perform public.require_cap('admin_revoke_grant');
  if public.rate_hit('adm:' || auth.uid()::text, 30, 60) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or char_length(v_email::text) > 254 then
    raise exception 'invalid_email' using errcode = '22023';
  end if;

  select u.id into v_user
  from auth.users u
  where lower(u.email) = lower(v_email::text)
  limit 1;
  if v_user is null then
    raise exception 'no_account' using errcode = '22023';
  end if;

  delete from public.workspace_grants where user_id = v_user;
  if not found then
    return jsonb_build_object('status', 'no_grant', 'user_id', v_user);
  end if;

  -- In-app notice, same channel the grant used. The member deserves to
  -- know why access stopped; discovering it at the next save failure
  -- alone reads as a bug.
  insert into public.notifications (user_id, actor_id, kind)
  values (v_user, auth.uid(), 'workspace_revoked');

  perform public.audit_log('workspace.revoke', 'user', v_user,
    jsonb_build_object('email', v_email));

  return jsonb_build_object('status', 'revoked', 'user_id', v_user);
end $$;

revoke all on function public.admin_revoke_grant(citext) from public;
grant execute on function public.admin_revoke_grant(citext) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. Blocklist management. blocked_terms stays RLS-locked (no client
--    policies); these three RPCs are the only write path with a capability
--    gate, a budget and an audit row — direct parity with every other
--    admin mutation.
-- ---------------------------------------------------------------------------
create or replace function public.admin_block_term(p_term text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_term text := lower(btrim(coalesce(p_term, '')));
begin
  perform public.require_cap('admin_block_term');
  if public.rate_hit('adm:' || auth.uid()::text, 30, 60) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  if char_length(v_term) < 2 or char_length(v_term) > 100 then
    raise exception 'invalid_term' using errcode = '22023';
  end if;

  insert into public.blocked_terms (term) values (v_term)
  on conflict (term) do nothing;

  perform public.audit_log('moderation.block_term', null, null,
    jsonb_build_object('term', v_term));

  return jsonb_build_object('status', 'blocked', 'term', v_term);
end $$;

revoke all on function public.admin_block_term(text) from public;
grant execute on function public.admin_block_term(text) to authenticated;

create or replace function public.admin_unblock_term(p_term text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_term text := lower(btrim(coalesce(p_term, '')));
begin
  perform public.require_cap('admin_unblock_term');
  if public.rate_hit('adm:' || auth.uid()::text, 30, 60) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  delete from public.blocked_terms where term = v_term;
  if not found then
    return jsonb_build_object('status', 'not_blocked', 'term', v_term);
  end if;

  perform public.audit_log('moderation.unblock_term', null, null,
    jsonb_build_object('term', v_term));

  return jsonb_build_object('status', 'unblocked', 'term', v_term);
end $$;

revoke all on function public.admin_unblock_term(text) from public;
grant execute on function public.admin_unblock_term(text) to authenticated;

create or replace function public.admin_blocked_terms()
returns table(term text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_cap('admin_blocked_terms');
  return query
    select bt.term, bt.created_at
    from public.blocked_terms bt
    order by bt.term;
end $$;

revoke all on function public.admin_blocked_terms() from public;
grant execute on function public.admin_blocked_terms() to authenticated;

-- ---------------------------------------------------------------------------
-- 3. edit_generation: prompt-only editing, author-gated. The response text
--    stays immutable on purpose — it is what the model said and what
--    remixes attach to; only what the AUTHOR wrote is editable. Own locked
--    posts are editable (reachability of committers); the blocklist and
--    length rules from create apply identically so a retroactive term
--    blocks the edit just as it would a new post.
-- ---------------------------------------------------------------------------
create or replace function public.edit_generation(p_id uuid, p_prompt text)
returns public.generations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_row  public.generations;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if char_length(btrim(coalesce(p_prompt, ''))) < 1
     or char_length(coalesce(p_prompt, '')) > 4000 then
    raise exception 'prompt_length' using errcode = '22023';
  end if;

  if exists (select 1 from public.blocked_terms bt
             where position(lower(bt.term) in lower(p_prompt)) > 0) then
    raise exception 'content_blocked' using errcode = '22023';
  end if;

  -- Edit budget: separate from the create budget so a burst of edits on
  -- one post cannot spend the ability to write new ones, and vice versa.
  if public.rate_hit('edit:' || v_user::text, 15, 60) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  -- FOR UPDATE: two tabs editing the same post serialize; the second
  -- writer still sees its own answer or its own error, never a torn row.
  select * into v_row from public.generations
   where id = p_id and deleted_at is null for update;

  if not found then
    raise exception 'post_gone' using errcode = 'P0002';
  end if;
  if v_row.author_id <> v_user then
    raise exception 'not_author' using errcode = '42501';
  end if;

  update public.generations
     set prompt = p_prompt,
         updated_at = now()
   where id = p_id
  returning * into v_row;

  return v_row;
end $$;

revoke all on function public.edit_generation(uuid, text) from public;
grant execute on function public.edit_generation(uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Notification retention: read rows fall away after p_days; unread rows
--    persist (a notification the member has not seen is still owed to
--    them). Nightly cron with the guard idiom used by 0024.
-- ---------------------------------------------------------------------------
create or replace function public.purge_old_notifications(p_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  delete from public.notifications
   where read_at is not null
     and read_at < now() - make_interval(days => p_days);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.purge_old_notifications(integer) from public;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
  perform cron.schedule('impose-purge-notifications', '7 5 * * *',
                        'select public.purge_old_notifications()');
exception when others then
  raise notice 'pg_cron scheduling skipped: %', sqlerrm;
end $$;
