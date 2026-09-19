-- 0023: production closure fixes from the 2026-09-19 final closure audit.
--
-- Every change here closes a blocker registered in
-- docs/FINAL_CLOSURE_AUDIT_PRODUCTION_2026-09-19.md (artifacts E–J, part 3).
-- Nothing is renamed, no contract is widened: each public entry point keeps
-- its signature, and every check added below is one the audit showed was
-- missing from the layer that actually enforces the rule.
--
--   B-02  save_workspace and the workspace_state policies never checked the
--         workspace grant; revocation was UI-only.
--   B-03  join_waitlist returned any address's status/position verbatim —
--         an anonymous membership oracle.
--   B-04  join_waitlist had no ceiling: anonymous scripts could fill the
--         100k-row cap and DoS every future legitimate signup.
--   B-06  OTP issuance trusted the relay's per-process limiter; a restart
--         or second instance reset it, and the cooldown was a caller
--         parameter. The floor now lives in the database.
--   B-07  no path existed to delete an account; the audit columns now hand
--         the reference back (set null) so a grantor can leave.
--   B-10  three dead systems lingered in production.

-- ---------------------------------------------------------------------------
-- B-03 + B-04: join_waitlist answers the same thing to everyone, and anonymous
-- writes are budgeted per client IP (hashed with a daily salt so no raw
-- address is stored; the ip_hash column finally earns its keep).
--
-- The response is constant by design: membership and approval status of an
-- address are nobody's business without that mailbox, and the legitimate
-- unlock signal is my_workspace_access after sign-in, not this function.
-- ---------------------------------------------------------------------------
create or replace function public.join_waitlist(p_email text)
returns table(waitlist_position integer, status text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    public.waitlist;
  v_local  text;
  v_domain text;
  v_ip     text;
  v_iph    text;
begin
  p_email := lower(btrim(p_email));

  if char_length(p_email) > 254
     or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email';
  end if;

  v_local  := split_part(p_email, '@', 1);
  v_domain := split_part(p_email, '@', 2);

  if char_length(v_local) > 64
     or v_local like '.%' or v_local like '%.' or v_local like '%..%' then
    raise exception 'invalid_email';
  end if;

  if public.text_is_spammy(v_local) then
    raise exception 'invalid_email';
  end if;

  if v_domain in (
    'example.com', 'example.org', 'example.net', 'example.edu',
    'test.com', 'invalid', 'localhost', 'loadtest.invalid',
    'mailinator.com', 'tempmail.com', 'temp-mail.org', 'guerrillamail.com',
    '10minutemail.com', 'throwawaymail.com', 'yopmail.com', 'trashmail.com',
    'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc',
    'fakeinbox.com', 'mailnesia.com', 'spamgourmet.com', 'mintemail.com',
    'tempinbox.com', 'emailondeck.com', 'moakt.com', 'mohmal.com'
  ) or v_domain like 'mailinator.%' or v_domain like 'yopmail.%' then
    raise exception 'email_provider_not_accepted';
  end if;

  -- Write budget, keyed on the caller's IP as PostgREST forwarded it.
  -- Hashed with the day so the column can never be reversed into an
  -- address. A shared no-header bucket exists for transports that strip
  -- the header; hosted PostgREST always sends it, so that bucket is the
  -- documented degenerate case, not the norm.
  begin
    v_ip := split_part(
      coalesce(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', ''),
      ',', 1);
  exception when others then
    v_ip := '';
  end;
  v_ip := btrim(v_ip);

  if v_ip <> '' then
    v_iph := encode(extensions.digest(v_ip || ':' || to_char(now() at time zone 'utc', 'YYYY-MM-DD'), 'sha256'), 'hex');
    if public.rate_hit('wl:' || v_iph, 4, 3600) then
      raise exception 'rate_limited' using errcode = '53100';
    end if;
  else
    v_iph := null;
    if public.rate_hit('wl:noip', 8, 3600) then
      raise exception 'rate_limited' using errcode = '53100';
    end if;
  end if;

  select * into v_row from public.waitlist where email = p_email;
  if not found then
    if (select count(*) from public.waitlist) >= 100000 then
      raise exception 'waitlist_full' using errcode = '53100';
    end if;

    -- Serialise the number handout. Without this, two joins in the same
    -- instant read the same max() and share a place in line.
    perform pg_advisory_xact_lock(hashtext('waitlist_position'));

    insert into public.waitlist (email, position, ip_hash)
    values (p_email,
            (select coalesce(max(w.position), 0) + 1 from public.waitlist w),
            v_iph)
    on conflict (email) do nothing;

    select * into v_row from public.waitlist where email = p_email;
  end if;

  -- One answer for every caller and every address. 'received' says the
  -- request was well-formed; it confirms nothing about the row behind it.
  return query select null::integer, 'received'::text;
end $$;

-- Grants unchanged: anon and authenticated both keep execute (public form).

-- ---------------------------------------------------------------------------
-- B-02: the workspace write path now enforces the entitlement it previously
-- only displayed. my_workspace_access answered the question; save_workspace
-- never asked it.
-- ---------------------------------------------------------------------------
create or replace function public.save_workspace(p_data jsonb, p_expected_rev bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
  v_cur  bigint;
  v_new_rev bigint;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- Entitlement: a workspace grant is the difference between a member and
  -- a stranger with an account. Without this check a revoked or
  -- never-granted account kept syncing forever (B-02).
  if not exists (select 1 from public.workspace_grants g where g.user_id = v_user) then
    raise exception 'workspace_not_granted' using errcode = '42501';
  end if;

  if p_data is null then
    raise exception 'bad_payload' using errcode = '22023';
  end if;
  if octet_length(p_data::text) > 3145728 then
    raise exception 'payload_too_large' using errcode = '22023';
  end if;
  if public.rate_hit('ws:' || v_user::text, 30, 60) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  -- Row lock first: the compare and the write must see the same rev, or
  -- two racing saves both pass the check and one still vanishes.
  select rev into v_cur
  from public.workspace_state
  where user_id = v_user
  for update;

  if found then
    -- null keeps the pre-0019 behaviour (overwrite) so an old client
    -- degrades instead of breaking. A number is a claim: "I am editing
    -- rev N". A wrong claim means another device wrote since this one
    -- read, and overwriting would destroy that device's work silently.
    if p_expected_rev is not null and p_expected_rev <> v_cur then
      raise exception 'stale_workspace' using errcode = '40001';
    end if;
    update public.workspace_state
    set data = p_data, rev = v_cur + 1, updated_at = now()
    where user_id = v_user
    returning rev into v_new_rev;
  else
    -- First save for this account. The upsert covers the one race the
    -- row lock cannot: two first-saves arriving together.
    insert into public.workspace_state (user_id, data, rev, updated_at)
    values (v_user, p_data, 1, now())
    on conflict (user_id) do update
      set data = excluded.data,
          rev = public.workspace_state.rev + 1,
          updated_at = now()
    returning rev into v_new_rev;
  end if;

  return jsonb_build_object('rev', v_new_rev);
end $$;

-- The REST read/write surface gets the same rule, so a revoked member
-- cannot pull their old blob either (pull reads workspace_state directly).
drop policy if exists workspace_state_select_own on public.workspace_state;
create policy workspace_state_select_own on public.workspace_state
  for select using (
    auth.uid() = user_id
    and exists (select 1 from public.workspace_grants g where g.user_id = auth.uid())
  );

drop policy if exists workspace_state_insert_own on public.workspace_state;
create policy workspace_state_insert_own on public.workspace_state
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from public.workspace_grants g where g.user_id = auth.uid())
  );

drop policy if exists workspace_state_update_own on public.workspace_state;
create policy workspace_state_update_own on public.workspace_state
  for update using (
    auth.uid() = user_id
    and exists (select 1 from public.workspace_grants g where g.user_id = auth.uid())
  ) with check (
    auth.uid() = user_id
    and exists (select 1 from public.workspace_grants g where g.user_id = auth.uid())
  );

drop policy if exists workspace_state_delete_own on public.workspace_state;
create policy workspace_state_delete_own on public.workspace_state
  for delete using (
    auth.uid() = user_id
    and exists (select 1 from public.workspace_grants g where g.user_id = auth.uid())
  );

-- ---------------------------------------------------------------------------
-- B-06: the OTP issuance floor moves into the database. Before this, the
-- cooldown was a caller-supplied parameter and the only real ceilings lived
-- in relay process memory (alive until the next restart or second
-- instance). Now every address gets a hard hourly issue budget and a
-- minimum resend cooldown no caller can shrink, so attempt-burning a
-- victim's mailbox costs the attacker the whole hour, not one process
-- lifetime.
-- ---------------------------------------------------------------------------
create or replace function public.issue_auth_code(
  p_email citext, p_purpose text, p_hash text, p_user_id uuid,
  p_ttl integer default 600, p_cooldown integer default 60)
returns table(reused boolean, resend_in integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.auth_codes;
begin
  -- Server-owned floors. The caller may ask for more patience, never less.
  p_cooldown := greatest(coalesce(p_cooldown, 0), 30);

  -- One address, six issuances an hour, whoever asks. Attempt-burning a
  -- victim's code now exhausts this budget and stops, instead of
  -- continuing the moment a relay process restarts (B-06).
  if public.rate_hit('otpissue:' || lower(p_email::text), 6, 3600) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  select * into v_row
    from public.auth_codes
   where email = p_email and purpose = p_purpose
   for update;

  if found and v_row.expires_at > now()
     and v_row.issued_at > now() - make_interval(secs => p_cooldown) then
    return query select true,
      greatest(1, p_cooldown - extract(epoch from (now() - v_row.issued_at))::integer);
    return;
  end if;

  insert into public.auth_codes (email, purpose, code_hash, user_id, attempts, issued_at, expires_at)
  values (p_email, p_purpose, p_hash, p_user_id, 0, now(), now() + make_interval(secs => p_ttl))
  on conflict (email, purpose) do update
    set code_hash  = excluded.code_hash,
        user_id    = excluded.user_id,
        attempts   = 0,
        issued_at  = excluded.issued_at,
        expires_at = excluded.expires_at;

  return query select false, p_cooldown;
end $$;

-- ---------------------------------------------------------------------------
-- B-07: a person can now leave. delete_my_account removes the caller's own
-- auth.users row; every owned row cascades, and audit references to the
-- departing account are nulled (they are nullable by design) so history
-- keeps its shape without keeping the person. The owner and the last admin
-- are protected exactly as admin_remove protects them — an ownerless
-- installation is the worse failure.
-- ---------------------------------------------------------------------------
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
  -- and inviter undeletable (B-07).
  update public.admins set added_by = null where added_by = v_user;
  update public.admin_caps set granted_by = null where granted_by = v_user;

  delete from auth.users where id = v_user;
  if not found then
    raise exception 'gone' using errcode = 'P0002';
  end if;

  return jsonb_build_object('status', 'deleted');
end $$;

revoke all on function public.delete_my_account() from public;
grant execute on function public.delete_my_account() to authenticated;

-- ---------------------------------------------------------------------------
-- B-10: dead systems resolved. recount_saves targets the saves table dropped
-- in 0021 (any call raises 42P01) and require_admin is referenced by nothing
-- since require_cap replaced it — both go.
--
-- rls_auto_enable was registered as drift ("no migration"), but the drop
-- attempt surfaced what the audit's caller-grep could not see: the
-- ensure_rls event trigger depends on it. That trigger is a protective
-- default-deny net — any table created directly in production immediately
-- gets RLS enabled, CLOSED by default until a migration grants access. The
-- right closure is adoption, not deletion: identical behavior, now declared
-- here so fresh projects get the same floor. Its pg_catalog-only search_path
-- is correct (every call it makes is a catalog call).
-- ---------------------------------------------------------------------------
drop function if exists public.recount_saves();
drop function if exists public.require_admin();

create or replace function public.rls_auto_enable()
returns event_trigger
language plpgsql
security definer
set search_path = 'pg_catalog'
as $$
declare
  cmd record;
begin
  for cmd in
    select *
    from pg_event_trigger_ddl_commands()
    where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      and object_type in ('table','partitioned table')
  loop
     if cmd.schema_name is not null and cmd.schema_name in ('public') and cmd.schema_name not in ('pg_catalog','information_schema') and cmd.schema_name not like 'pg_toast%' and cmd.schema_name not like 'pg_temp%' then
      begin
        execute format('alter table if exists %s enable row level security', cmd.object_identity);
        raise log 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      exception
        when others then
          raise log 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      end;
     else
        raise log 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     end if;
  end loop;
end;
$$;

drop event trigger if exists ensure_rls;
create event trigger ensure_rls on ddl_command_end
  when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
  execute function public.rls_auto_enable();

-- ---------------------------------------------------------------------------
-- F-03: the badge counted rows the page refuses to show. notifications_page
-- drops notices whose subject was soft-deleted (nothing to open), while
-- notifications_unread counted them, so the number could exceed the list
-- forever. Both now read the same set.
-- ---------------------------------------------------------------------------
create or replace function public.notifications_unread()
returns integer
language sql
security definer
set search_path = public
as $$
  select count(*)::integer
    from public.notifications n
    left join public.comments c on c.id = n.comment_id and c.deleted_at is null
    left join public.generations g on g.id = n.generation_id and g.deleted_at is null
   where n.user_id = auth.uid()
     and n.read_at is null
     and (n.comment_id is null or c.id is not null)
     and (n.generation_id is null or g.id is not null);
$$;
