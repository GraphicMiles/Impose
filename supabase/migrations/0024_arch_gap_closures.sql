-- 0024: architecture gap closures from the arch-brief alignment review
-- (docs/ARCH_BRIEF_ALIGNMENT_2026-09-19.md §F). Billing/webhook infra (A6)
-- is deliberately discarded per owner directive. Everything here runs on
-- the existing $0 stack; nothing touches payment or entitlement tables.
--
--   1. audit_events        — admin/privileged action trail (brief §39/A11)
--   2. require_recent_auth — step-up for destructive admin ops (A11, $0
--                            alternative to plan-gated MFA)
--   3. thread depth cap    — server-side, matches the client's MAX_REPLY_DEPTH=2 (§9)
--   4. blocked_terms       — content blocklist exercised inside create RPCs (A4)
--   5. handle_history      — dropped-handle archive, impersonation defense (A13)
--   6. export_my_data      — self-serve data export (A5)
--   7. purge_soft_deleted  — retention for soft-deleted content (§43/§81-83) + cron
--   8. role timeouts       — statement/lock budgets for API roles (§54/A16)
--   9. admin_grant_cap / admin_revoke_cap gain the adm: budget their four
--      siblings already had (consistency fix found while rewriting)
--
-- Hotfix note (same-day): the first apply of this file used p_key text for
-- create_comment/create_generation while production's identity argument is
-- p_key uuid, and p_email citext for admin_add/admin_grant while the file's
-- definitions are keyed citext. CREATE OR REPLACE with non-matching identity
-- arguments creates a NEW overload instead of replacing, which leaves
-- PostgREST named-argument resolution ambiguous on the live endpoints. The
-- repair below drops every stray overload so exactly one function per name
-- remains, with definitions written against the identities kept live.
-- Idempotent whether or not the first version was applied.
drop function if exists public.create_comment(text, uuid, text, uuid);
drop function if exists public.create_generation(text, text, text, boolean, text, text, text, uuid);
drop function if exists public.admin_add(text);
drop function if exists public.admin_grant(text);

-- ---------------------------------------------------------------------------
-- 1. audit_events: immutable privileged-action trail. No client policies:
--    inserts happen only from SECURITY DEFINER RPCs (or the relay's service
--    key), reads only through admin_audit_events. actor_id SET NULL so the
--    trail survives account deletion (delete_my_account erases the person,
--    not the history — the brief's exact demand).
-- ---------------------------------------------------------------------------
create table if not exists public.audit_events (
  id          bigint generated always as identity primary key,
  actor_id    uuid references auth.users(id) on delete set null,
  action      text not null,
  target_type text,
  target_id   uuid,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);
alter table public.audit_events enable row level security;
-- RLS with zero policies = default deny for every client role. Inserts and
-- reads happen as table owner (definer RPCs) or service role, never clients.
-- Existing prod deployments already had this net for tables created out of
-- band; audit_events declares it inline so scratch replays match too.

create or replace function public.audit_log(
  p_action text, p_target_type text default null, p_target_id uuid default null,
  p_metadata jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_events (actor_id, action, target_type, target_id, metadata)
  values (auth.uid(), p_action, p_target_type, p_target_id, coalesce(p_metadata, '{}'::jsonb));
end $$;

revoke all on function public.audit_log(text, text, uuid, jsonb) from public;

create or replace function public.admin_audit_events(p_limit integer default 50, p_before timestamptz default null)
returns table(id bigint, actor_id uuid, action text, target_type text, target_id uuid, metadata jsonb, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Roster-adjacent read, so admin membership (not a dedicated cap) is the
  -- bar, exactly like admin_roster's window into the same subsystem.
  if not public.is_admin() then
    raise exception 'missing_capability' using errcode = '42501';
  end if;
  return query
    select e.id, e.actor_id, e.action, e.target_type, e.target_id, e.metadata, e.created_at
    from public.audit_events e
    where (p_before is null or e.created_at < p_before)
    order by e.created_at desc
    limit least(coalesce(p_limit, 50), 200);
end $$;

revoke all on function public.admin_audit_events(integer, timestamptz) from public;
grant execute on function public.admin_audit_events(integer, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. require_recent_auth: destructive privileged actions require a session
--    minted within the last N seconds. This is the $0 step-up: the OTP
--    sign-in already produces a fresh iat, so "sign in again" is the second
--    factor ceremony — no subscription, no new factor type.
-- ---------------------------------------------------------------------------
create or replace function public.require_recent_auth(p_max_age_seconds integer default 900)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_claims text;
  v_iat    bigint;
begin
  v_claims := current_setting('request.jwt.claims', true);
  -- Fail closed: a call that cannot prove recency does not get the benefit
  -- of the doubt (and a missing-claims SQL-context call never passes).
  if v_claims is null or v_claims = '' then
    raise exception 'recent_auth_required' using errcode = '42501';
  end if;
  v_iat := (v_claims::jsonb ->> 'iat')::bigint;
  if v_iat is null or v_iat < (extract(epoch from now())::bigint - p_max_age_seconds) then
    raise exception 'recent_auth_required' using errcode = '42501';
  end if;
end $$;

revoke all on function public.require_recent_auth(integer) from public;

-- ---------------------------------------------------------------------------
-- 3. Thread depth cap, server side. The client already walks a would-be
--    fourth-level reply up to a sibling (MAX_REPLY_DEPTH = 2); this closes
--    the direct-RPC path brief §9 calls for. Depth math: hops parent→root,
--    where a root comment's single hop = depth 0, so a new comment may hang
--    off a parent whose hop-count is at most 2. Cycle-guarded at 64.
-- ---------------------------------------------------------------------------
create or replace function public.create_comment(p_key uuid, p_gen uuid, p_body text, p_parent uuid default null)
returns public.comments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_hash  text;
  v_prior public.idempotency_keys;
  v_row   public.comments;
  v_walk  uuid;
  v_depth integer;
  v_guard integer;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  perform public.ensure_profile();

  if char_length(btrim(coalesce(p_body, ''))) < 1
     or char_length(coalesce(p_body, '')) > 1000 then
    raise exception 'body_length' using errcode = '22023';
  end if;

  v_hash := encode(extensions.digest(
    p_gen::text || '|' || coalesce(p_parent::text,'') || '|' || coalesce(p_body,''),
    'sha256'), 'hex');

  -- Replay check BEFORE any new-write validation: a retry of something that
  -- already succeeded must keep succeeding even if the rules tightened since
  -- (e.g. a term blocked after the original comment landed).
  select * into v_prior from public.idempotency_keys where key = p_key for update;
  if found then
    if v_prior.user_id <> v_user or v_prior.request_hash <> v_hash then
      raise exception 'idempotency_key_reused' using errcode = '22023';
    end if;
    select * into v_row from public.comments where id = (v_prior.response->>'id')::uuid;
    return v_row;
  end if;

  -- Blocklist: terms are owner-managed in SQL; an empty table (the default)
  -- changes nothing.
  if exists (select 1 from public.blocked_terms bt
             where position(lower(bt.term) in lower(p_body)) > 0) then
    raise exception 'content_blocked' using errcode = '22023';
  end if;

  if p_parent is not null then
    if not exists (
      select 1 from public.comments c
       where c.id = p_parent and c.generation_id = p_gen and c.deleted_at is null
    ) then
      raise exception 'parent_gone' using errcode = '22023';
    end if;

    -- Depth cap (see header): hops parent→root must stay at or under 2.
    v_walk  := p_parent;
    v_depth := 0;
    v_guard := 0;
    while v_walk is not null and v_guard < 64 loop
      v_depth := v_depth + 1;
      v_guard := v_guard + 1;
      select parent_id into v_walk from public.comments where id = v_walk;
    end loop;
    if v_depth > 2 then
      raise exception 'thread_too_deep' using errcode = '22023';
    end if;
  end if;

  if not exists (
    select 1 from public.generations g
     where g.id = p_gen and g.deleted_at is null
       and (g.visibility = 'public' or g.author_id = v_user)
  ) then
    raise exception 'post_gone' using errcode = '22023';
  end if;

  -- Same placement as posts: after the replay check, before the insert.
  if public.rate_hit('com:' || v_user::text, 15, 60)
     or public.rate_hit('com:' || v_user::text || ':' || p_gen::text, 5, 60) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  insert into public.comments (generation_id, author_id, parent_id, body)
  values (p_gen, v_user, p_parent, p_body)
  returning * into v_row;

  insert into public.idempotency_keys (key, user_id, request_hash, response)
  values (p_key, v_user, v_hash, jsonb_build_object('id', v_row.id));

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 4. blocked_terms: owner-managed denylist consulted by create_comment
--    (above) and create_generation (below). No client policies — SQL-only.
-- ---------------------------------------------------------------------------
create table if not exists public.blocked_terms (
  term       text primary key,
  created_at timestamptz not null default now()
);
alter table public.blocked_terms enable row level security;

-- A. create_generation gains the same blocklist check (audit finding: A4
--    had no input layer at all). Everything else is byte-identical to the
--    body 0023 left in production.
create or replace function public.create_generation(
  p_key uuid, p_prompt text, p_response text default '', p_addressed boolean default false,
  p_status text default 'complete', p_visibility text default 'public',
  p_kind text default 'original', p_remix_of uuid default null)
returns public.generations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user  uuid := auth.uid();
  v_hash  text;
  v_prior public.idempotency_keys;
  v_row   public.generations;
  v_kind  text := coalesce(p_kind, 'original');
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  perform public.ensure_profile();

  if char_length(btrim(coalesce(p_prompt, ''))) < 1
     or char_length(coalesce(p_prompt, '')) > 4000 then
    raise exception 'prompt_length' using errcode = '22023';
  end if;
  if char_length(coalesce(p_response, '')) > 20000 then
    raise exception 'response_length' using errcode = '22023';
  end if;

  if coalesce(p_visibility, 'public') not in ('public', 'private') then
    raise exception 'bad_visibility' using errcode = '22023';
  end if;
  if v_kind not in ('original', 'remix', 'challenge') then
    raise exception 'bad_kind' using errcode = '22023';
  end if;

  if v_kind = 'original' and p_remix_of is not null then
    raise exception 'original_cannot_have_parent' using errcode = '22023';
  end if;
  if v_kind in ('remix', 'challenge') and p_remix_of is null then
    raise exception 'lineage_needs_parent' using errcode = '22023';
  end if;

  if p_remix_of is not null then
    if not exists (
      select 1 from public.generations g
       where g.id = p_remix_of
         and g.deleted_at is null
         and (g.visibility = 'public' or g.author_id = v_user)
    ) then
      raise exception 'parent_gone' using errcode = '22023';
    end if;

    if exists (
      select 1 from public.generations g
       where g.id = p_remix_of and g.locked = true and g.author_id <> v_user
    ) then
      raise exception 'parent_locked' using errcode = '22023';
    end if;
  end if;

  v_hash := encode(extensions.digest(
    coalesce(p_prompt,'') || '|' || coalesce(p_response,'') || '|' ||
    coalesce(p_visibility,'') || '|' || v_kind || '|' ||
    coalesce(p_remix_of::text,''), 'sha256'), 'hex');

  -- Replay check BEFORE any new-write validation: a retry of something that
  -- already succeeded must keep succeeding even if the rules tightened since
  -- (e.g. a term blocked after the original post landed).
  select * into v_prior from public.idempotency_keys
   where key = p_key for update;

  if found then
    if v_prior.user_id <> v_user or v_prior.request_hash <> v_hash then
      raise exception 'idempotency_key_reused' using errcode = '22023';
    end if;
    select * into v_row from public.generations
     where id = (v_prior.response->>'id')::uuid;
    return v_row;
  end if;

  -- Blocklist: owner-managed terms in public.blocked_terms; empty table
  -- (the default) changes nothing.
  if exists (select 1 from public.blocked_terms bt
             where position(lower(bt.term) in lower(p_prompt)) > 0) then
    raise exception 'content_blocked' using errcode = '22023';
  end if;

  -- Write budget. Checked here, after the replay check, so a retry never
  -- spends budget, and before the insert, so a refusal creates nothing.
  if public.rate_hit('gen:' || v_user::text, 8, 60) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  -- An addressed post asks the agent to answer, which is compute. Per-user
  -- cooldown first, then a platform-wide ceiling because the model streams
  -- only so many answers at once no matter how many people ask.
  if coalesce(p_addressed, false) then
    if public.rate_hit('bot:' || v_user::text, 3, 60)
       or public.rate_hit('bot:global', 12, 60) then
      raise exception 'rate_limited' using errcode = '53100';
    end if;
  end if;

  insert into public.generations
    (author_id, prompt, response, addressed, status, visibility, kind, remix_of)
  values
    (v_user, p_prompt, coalesce(p_response,''), coalesce(p_addressed,false),
     coalesce(p_status,'complete'), coalesce(p_visibility,'public'),
     v_kind, p_remix_of)
  returning * into v_row;

  insert into public.idempotency_keys (key, user_id, request_hash, response)
  values (p_key, v_user, v_hash, jsonb_build_object('id', v_row.id));

  return v_row;
end $$;

-- ---------------------------------------------------------------------------
-- 5. handle_history: every dropped handle is archived. Trigger (not RPC
--    edits) so every present and future write path is covered.
-- ---------------------------------------------------------------------------
create table if not exists public.handle_history (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  old_handle text not null,
  dropped_at timestamptz not null default now()
);
alter table public.handle_history enable row level security;

drop policy if exists "users read their own handle history" on public.handle_history;
create policy "users read their own handle history" on public.handle_history
  for select using (auth.uid() = user_id);

create or replace function public.record_handle_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.handle_history (user_id, old_handle)
  values (old.id, old.handle);
  return new;
end $$;

drop trigger if exists trg_handle_history on public.profiles;
create trigger trg_handle_history
  after update of handle on public.profiles
  for each row
  when (old.handle is distinct from new.handle)
  execute function public.record_handle_history();

-- ---------------------------------------------------------------------------
-- 6. export_my_data: the A5 self-serve export. Bounded per section so the
--    export is a snapshot, not a table dump; heavily rate limited.
-- ---------------------------------------------------------------------------
create or replace function public.export_my_data()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if public.rate_hit('exp:' || v_user::text, 3, 3600) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  return jsonb_build_object(
    'exported_at', now(),
    'user_id', v_user,
    'profile', (select to_jsonb(p) from public.profiles p where p.id = v_user),
    'generations', coalesce((
      select jsonb_agg(t order by t.created_at desc) from (
        select id, prompt, response, kind, status, visibility, locked,
               remix_of, root_id, comment_count, remix_count, challenge_count,
               created_at, updated_at, deleted_at
        from public.generations where author_id = v_user
        order by created_at desc limit 5000) t), '[]'::jsonb),
    'comments', coalesce((
      select jsonb_agg(t order by t.created_at desc) from (
        select id, generation_id, parent_id, body, created_at, updated_at, deleted_at
        from public.comments where author_id = v_user
        order by created_at desc limit 5000) t), '[]'::jsonb),
    'reports_filed', coalesce((
      select jsonb_agg(t order by t.created_at desc) from (
        select id, kind, target_id, reason, status, created_at
        from public.reports where reporter_id = v_user
        order by created_at desc limit 1000) t), '[]'::jsonb),
    'notifications', coalesce((
      select jsonb_agg(t order by t.created_at desc) from (
        select id, kind, generation_id, comment_id, read_at, created_at
        from public.notifications where user_id = v_user
        order by created_at desc limit 1000) t), '[]'::jsonb),
    'workspace_state', (
      select jsonb_build_object('rev', w.rev, 'updated_at', w.updated_at, 'data', w.data)
      from public.workspace_state w where w.user_id = v_user),
    'waitlist_rows', coalesce((
      select jsonb_agg(t) from (
        select email, position, status, created_at
        from public.waitlist where user_id = v_user) t), '[]'::jsonb)
  );
end $$;

revoke all on function public.export_my_data() from public;
grant execute on function public.export_my_data() to authenticated;

-- ---------------------------------------------------------------------------
-- 7. purge_soft_deleted: retention for soft-deleted content. Deletes rows
--    whose deleted_at is older than p_days; FKs cascade comments,
--    notifications and lineage references off purged generations. Cron
--    scheduled with the same guard idiom as 0019.
-- ---------------------------------------------------------------------------
create or replace function public.purge_soft_deleted(p_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_g integer;
  v_c integer;
begin
  delete from public.generations
   where deleted_at is not null
     and deleted_at < now() - make_interval(days => p_days);
  get diagnostics v_g = row_count;

  delete from public.comments
   where deleted_at is not null
     and deleted_at < now() - make_interval(days => p_days);
  get diagnostics v_c = row_count;

  return v_g + v_c;
end $$;

revoke all on function public.purge_soft_deleted(integer) from public;

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('impose-purge-soft-deleted', '41 4 * * 0',
                          'select public.purge_soft_deleted()');
  end if;
exception when others then
  raise notice 'pg_cron scheduling skipped: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- 8. Statement and lock budgets for the API roles. Every query an API role
--    runs is already bounded in shape (keyset cursors, page caps); this
--    bounds them in time so a future slow plan cannot pin connections.
-- ---------------------------------------------------------------------------
alter role authenticated set statement_timeout = '8s';
alter role authenticated set lock_timeout = '4s';
alter role anon set statement_timeout = '8s';
alter role anon set lock_timeout = '4s';

-- ---------------------------------------------------------------------------
-- 9. Admin destructive actions: step-up auth + audit events + the missing
--    adm: budget on the two capability RPCs. Bodies are the production
--    bodies with exactly those additions.
-- ---------------------------------------------------------------------------
create or replace function public.admin_add(p_email citext)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email citext := lower(btrim(coalesce(p_email, '')));
  v_user  uuid;
begin
  perform public.require_cap('admin_add');
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

  if exists (select 1 from public.admins where user_id = v_user) then
    return jsonb_build_object('status', 'already', 'user_id', v_user);
  end if;

  insert into public.admins (user_id, email, owner, added_by)
  values (v_user, v_email, false, auth.uid());

  -- A new admin starts with the two capabilities the panel can offer
  -- without further review. Nothing sensitive rides along; the owner
  -- decides the rest.
  insert into public.admin_caps (user_id, cap, granted_by)
  select v_user, c.cap, auth.uid()
  from public.admin_capabilities c
  where c.cap in ('waitlist.manage', 'moderation.manage')
  on conflict do nothing;

  perform public.audit_log('admin.add', 'user', v_user,
    jsonb_build_object('email', v_email));
  return jsonb_build_object('status', 'added', 'user_id', v_user);
end $$;

create or replace function public.admin_grant(p_email citext)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email citext := lower(btrim(coalesce(p_email, '')));
  v_user  uuid;
  v_new   boolean := false;
  v_admin_profile uuid;
begin
  perform public.require_cap('admin_grant');
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

  insert into public.workspace_grants (user_id)
  values (v_user)
  on conflict (user_id) do nothing;
  v_new := found;

  -- Notify the user in their inbox
  select id into v_admin_profile from public.profiles where id = auth.uid();
  if v_admin_profile is not null and v_new then
    insert into public.notifications (user_id, actor_id, kind)
    values (v_user, v_admin_profile, 'waitlist_approved');
  end if;

  update public.waitlist
  set status = 'approved'
  where email = v_email and status <> 'approved';

  if v_new then
    perform public.audit_log('workspace.grant', 'user', v_user,
      jsonb_build_object('email', v_email, 'via', 'rpc'));
  end if;

  return jsonb_build_object(
    'status', case
      when v_new then 'granted'
      else 'already'
    end,
    'user_id', v_user);
end $$;

create or replace function public.admin_remove(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner boolean;
  v_left  integer;
begin
  perform public.require_cap('admin_remove');
  perform public.require_recent_auth(900);
  if public.rate_hit('adm:' || auth.uid()::text, 30, 60) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  if p_user_id is null then
    raise exception 'gone' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.admins where user_id = p_user_id) then
    raise exception 'gone' using errcode = 'P0002';
  end if;

  select owner into v_owner from public.admins where user_id = p_user_id;
  if v_owner then
    raise exception 'owner_protected' using errcode = '42501';
  end if;

  -- The last admin cannot leave. An ownerless installation nobody can
  -- administer is worse than any abuse this guard prevents, and there is
  -- no recovery path that does not involve the database directly.
  select count(*) into v_left from public.admins where user_id <> p_user_id;
  if v_left = 0 then
    raise exception 'last_admin' using errcode = '42501';
  end if;

  -- Caps hang off auth.users, not admins, so they outlive the admins row
  -- unless removal clears them explicitly. Leaving them is the silent
  -- failure: the account reads as a stranger today and re-acquires every
  -- old grant the moment someone is added back.
  delete from public.admin_caps where user_id = p_user_id;
  delete from public.admins where user_id = p_user_id;
  perform public.audit_log('admin.remove', 'user', p_user_id, '{}'::jsonb);
  return jsonb_build_object('status', 'removed', 'user_id', p_user_id);
end $$;

create or replace function public.admin_resolve_report(p_id uuid, p_status text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.require_cap('admin_resolve_report');
  if coalesce(p_status, '') not in ('reviewed', 'actioned', 'dismissed') then
    raise exception 'bad_status' using errcode = '22023';
  end if;
  if public.rate_hit('adm:' || auth.uid()::text, 30, 60) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  update public.reports
  set status = p_status
  where id = p_id and status = 'pending';

  if found then
    perform public.audit_log('report.resolve', 'report', p_id,
      jsonb_build_object('status', p_status));
    return jsonb_build_object('status', p_status);
  end if;
  if exists (select 1 from public.reports where id = p_id) then
    -- Two moderators, one report: the second learns it is settled
    -- instead of silently re-stamping it.
    return jsonb_build_object('status', 'already');
  end if;
  return jsonb_build_object('status', 'gone');
end $$;

create or replace function public.admin_grant_cap(p_user_id uuid, p_cap text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email citext;
begin
  perform public.require_cap('admin_grant_cap');
  -- Consistency fix: the four sibling admin RPCs all carry this budget;
  -- grant/revoke_cap were the only two without one.
  if public.rate_hit('adm:' || auth.uid()::text, 30, 60) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  if p_user_id is null or not exists (
       select 1 from public.admins where user_id = p_user_id) then
    raise exception 'not_an_admin' using errcode = '22023';
  end if;
  if p_cap is null or not exists (
       select 1 from public.admin_capabilities where cap = p_cap) then
    raise exception 'unknown_capability' using errcode = '22023';
  end if;

  insert into public.admin_caps (user_id, cap, granted_by)
  values (p_user_id, p_cap, auth.uid())
  on conflict do nothing;

  perform public.audit_log('admin.grant_cap', 'user', p_user_id,
    jsonb_build_object('cap', p_cap));
  select email into v_email from public.admins where user_id = p_user_id;
  return jsonb_build_object('status', 'granted', 'cap', p_cap, 'email', v_email);
end $$;

create or replace function public.admin_revoke_cap(p_user_id uuid, p_cap text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_left integer;
begin
  perform public.require_cap('admin_revoke_cap');
  perform public.require_recent_auth(900);
  if public.rate_hit('adm:' || auth.uid()::text, 30, 60) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  if p_user_id is null or not exists (
       select 1 from public.admins where user_id = p_user_id) then
    raise exception 'not_an_admin' using errcode = '22023';
  end if;
  if p_cap is null or not exists (
       select 1 from public.admin_capabilities where cap = p_cap) then
    raise exception 'unknown_capability' using errcode = '22023';
  end if;

  -- The owner's empty grant row means "everything"; deleting the row for
  -- one capability would hand them a row that means "one capability".
  if exists (select 1 from public.admins
             where user_id = p_user_id and owner) then
    raise exception 'owner_protected' using errcode = '42501';
  end if;

  delete from public.admin_caps
  where user_id = p_user_id and cap = p_cap;

  select count(*) into v_left from public.admin_caps where user_id = p_user_id;
  if v_left = 0 then
    -- Undo the delete inside the same statement: revoking the last
    -- capability is not a thing an RPC should half-apply.
    insert into public.admin_caps (user_id, cap, granted_by)
    values (p_user_id, p_cap, auth.uid());
    raise exception 'last_capability' using errcode = '22023';
  end if;

  perform public.audit_log('admin.revoke_cap', 'user', p_user_id,
    jsonb_build_object('cap', p_cap));
  return jsonb_build_object('status', 'revoked', 'cap', p_cap, 'remaining', v_left);
end $$;

-- Step-up for account deletion too (0023's function, with the one-line
-- addition; everything else identical).
create or replace function public.delete_my_account()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  perform public.require_recent_auth(900);

  if public.rate_hit('del:' || v_user::text, 3, 3600) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  if exists (select 1 from public.admins a where a.user_id = v_user and a.owner) then
    raise exception 'owner_protected' using errcode = '42501';
  end if;
  if exists (select 1 from public.admins a where a.user_id = v_user)
     and (select count(*) from public.admins) = 1 then
    raise exception 'last_admin' using errcode = '42501';
  end if;

  -- Keep the audit trail, lose the pointer. Both columns are nullable for
  -- precisely this moment; the alternative (NO ACTION) made every grantor
  -- and inviter undeletable (B-07). The audit_events row below survives:
  -- its actor_id FK is ON DELETE SET NULL, so history keeps the action
  -- without keeping the person.
  update public.admins set added_by = null where added_by = v_user;
  update public.admin_caps set granted_by = null where granted_by = v_user;

  perform public.audit_log('account.delete', 'user', v_user, '{}'::jsonb);

  delete from auth.users where id = v_user;
  if not found then
    raise exception 'gone' using errcode = 'P0002';
  end if;

  return jsonb_build_object('status', 'deleted');
end $$;

-- ---------------------------------------------------------------------------
-- Hotfix re-grants (see header note): freshly-created overloads carry the
-- default PUBLIC execute grant until narrowed. The identical-identity
-- functions keep their original ACLs through CREATE OR REPLACE, but these
-- lines make the end state explicit and identical for both histories.
-- ---------------------------------------------------------------------------
revoke all on function public.admin_add(citext) from public;
grant execute on function public.admin_add(citext) to authenticated;
revoke all on function public.admin_grant(citext) from public;
grant execute on function public.admin_grant(citext) to authenticated;
revoke all on function public.admin_remove(uuid) from public;
grant execute on function public.admin_remove(uuid) to authenticated;
revoke all on function public.admin_resolve_report(uuid, text) from public;
grant execute on function public.admin_resolve_report(uuid, text) to authenticated;
revoke all on function public.admin_grant_cap(uuid, text) from public;
grant execute on function public.admin_grant_cap(uuid, text) to authenticated;
revoke all on function public.admin_revoke_cap(uuid, text) from public;
grant execute on function public.admin_revoke_cap(uuid, text) to authenticated;
