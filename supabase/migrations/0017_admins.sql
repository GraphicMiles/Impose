-- 0017: the admin role.
--
-- Until now "grant day" was a curl call holding the relay's key: no
-- named administrator, no in-product surface, nothing an operator could
-- do from the app. This migration roots the admin role in the database,
-- where a client cannot forge it: membership is a row keyed to a real
-- auth account, every privileged action is a SECURITY DEFINER RPC that
-- re-checks the caller, and the tables themselves carry no client
-- policies and no grants.
--
-- rfarouq69@gmail.com is seeded as the owner admin: removable by no
-- one (owner = true), so the role can never be emptied by accident or
-- by a compromised co-admin. Owner can add and remove other admins by
-- email; an admin must already have an account, because an admin who
-- cannot sign in cannot act.

create table public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  email      citext not null unique,
  owner      boolean not null default false,
  added_by   uuid references auth.users (id),
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;
-- No client policies and no grants, exactly like waitlist and reports:
-- everything below is SECURITY DEFINER and owns its own access.

-- ============ membership check ============
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

-- Shared gate for every admin RPC: one place to refuse, one errcode.
create or replace function public.require_admin()
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'not_admin' using errcode = '42501';
  end if;
end $$;

revoke all on function public.require_admin() from public;
grant execute on function public.require_admin() to authenticated;

-- ============ the queue ============
create or replace function public.admin_waitlist(
  p_status text default 'pending',
  p_limit  integer default 100
)
returns table (
  id uuid, email citext, status text, queue_position integer,
  created_at timestamptz, has_account boolean
)
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  if coalesce(p_status, '') not in ('pending', 'approved', 'rejected') then
    raise exception 'bad_status' using errcode = '22023';
  end if;

  return query
    select w.id, w.email, w.status, w.position, w.created_at,
           exists (
             select 1 from auth.users u
             where lower(u.email) = lower(w.email::text)
           ) as has_account
    from public.waitlist w
    where w.status = p_status
    order by w.created_at asc
    limit least(greatest(coalesce(p_limit, 100), 1), 500);
end $$;

revoke all on function public.admin_waitlist(text, integer) from public;
grant execute on function public.admin_waitlist(text, integer) to authenticated;

-- ============ the roster ============
create or replace function public.admin_roster()
returns table (
  user_id uuid, email citext, owner boolean,
  added_by uuid, created_at timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  return query
    select a.user_id, a.email, a.owner, a.added_by, a.created_at
    from public.admins a
    order by a.created_at asc;
end $$;

revoke all on function public.admin_roster() from public;
grant execute on function public.admin_roster() to authenticated;

-- ============ add / remove admins ============
create or replace function public.admin_add(p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email citext := lower(btrim(coalesce(p_email, '')));
  v_user  uuid;
begin
  perform public.require_admin();
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

  insert into public.admins (user_id, email, added_by)
  values (v_user, v_email, auth.uid())
  on conflict (user_id) do nothing;

  if found then
    return jsonb_build_object('status', 'added', 'user_id', v_user);
  end if;
  return jsonb_build_object('status', 'already', 'user_id', v_user);
end $$;

revoke all on function public.admin_add(text) from public;
grant execute on function public.admin_add(text) to authenticated;

create or replace function public.admin_remove(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_target public.admins;
  v_total  integer;
begin
  perform public.require_admin();

  select * into v_target from public.admins where user_id = p_user_id;
  if not found then
    return jsonb_build_object('status', 'gone');
  end if;
  if v_target.owner then
    raise exception 'owner_protected' using errcode = '22023';
  end if;

  select count(*) into v_total from public.admins;
  if v_total <= 1 then
    raise exception 'last_admin' using errcode = '22023';
  end if;

  delete from public.admins where user_id = p_user_id and owner = false;
  return jsonb_build_object('status', 'removed');
end $$;

revoke all on function public.admin_remove(uuid) from public;
grant execute on function public.admin_remove(uuid) to authenticated;

-- ============ grant workspace access ============
-- The in-product replacement for the curl-and-a-key ceremony: an admin
-- names an address, the account is resolved server-side, the grant is
-- recorded idempotently and the waitlist row is marked approved. The
-- approval email is a separate relay step; the database never pretends
-- to send mail.
create or replace function public.admin_grant(p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email citext := lower(btrim(coalesce(p_email, '')));
  v_user  uuid;
  v_new   boolean;
begin
  perform public.require_admin();
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

  update public.waitlist
  set status = 'approved'
  where email = v_email and status <> 'approved';

  return jsonb_build_object(
    'status', case when v_new then 'granted' else 'already' end,
    'user_id', v_user);
end $$;

revoke all on function public.admin_grant(text) from public;
grant execute on function public.admin_grant(text) to authenticated;

-- ============ reports, readable in-product ============
-- Same shape the relay's /admin/reports returns (newest first, reporter
-- embedded), so the panel and the curl path agree. Acting on a report
-- stays a database operation; reading it is what the panel needs.
create or replace function public.admin_reports(
  p_status text default 'pending',
  p_limit  integer default 50
)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  if coalesce(p_status, '') not in ('pending', 'reviewed', 'actioned', 'dismissed') then
    raise exception 'bad_status' using errcode = '22023';
  end if;

  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id, 'kind', r.kind, 'target_id', r.target_id,
      'reason', r.reason, 'status', r.status, 'created_at', r.created_at,
      'reporter', jsonb_build_object(
        'handle', p.handle, 'display_name', p.display_name))
      order by r.created_at desc)
    from (
      select * from public.reports
      where status = p_status
      order by created_at desc
      limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) r
    left join public.profiles p on p.id = r.reporter_id
  ), '[]'::jsonb);
end $$;

revoke all on function public.admin_reports(text, integer) from public;
grant execute on function public.admin_reports(text, integer) to authenticated;

-- ============ seed the owner ============
-- Runs wherever this migration runs. On the live project the owner account
-- exists and becomes the irremovable owner admin; on a scratch database
-- with no such user it is a no-op and the tests seed their own admins.
insert into public.admins (user_id, email, owner)
select id, email::citext, true
from auth.users
where lower(email) = 'rfarouq69@gmail.com'
on conflict (user_id) do update set owner = true;
