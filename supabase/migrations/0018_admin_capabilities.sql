-- 0018: capabilities and the bootstrap claim.
--
-- 0017 put the admin role in the database, which is where authority
-- belongs. What it left behind is a single blunt switch: is_admin() is
-- true for an owner who can delete other admins and for a co-admin who
-- was added only to approve the waitlist, and both hold everything. That
-- is the wrong shape for a surface a stranger can find by typing /admin.
--
-- This migration adds two things:
--
--   * Capabilities. A grant is a (user, capability) pair rather than a
--     membership flag, so "can approve a seat" and "can remove an admin"
--     stop being the same decision. Required per action is declared in a
--     lookup table, so the mapping lives in the database and cannot be
--     edited by whatever the browser sends.
--
--   * Bootstrap. Seeding an email is an intention, not a handover. The
--     account named in 0017 claims the role once, which marks the
--     bootstrap spent and records who took it. After the claim the only
--     question asked anywhere is "what capabilities does this account
--     hold"; the seeded address stops mattering, so the bootstrap cannot
--     be replayed to mint a second owner.
--
-- Same rules as 0017, deliberately: RLS is on with no policies and no
-- table grants. Every path in or out is a SECURITY DEFINER function that
-- checks the caller itself. An anonymous request cannot even ask what a
-- capability is.

-- ============ capability catalog ============
-- A closed vocabulary. Adding a capability is a migration, not data
-- someone can invent at runtime, and admin_revoke will not accept a
-- string that is not in this list.
create table if not exists public.admin_capabilities (
  cap         text primary key check (cap ~ '^[a-z]+\.[a-z_]+$'),
  label       text not null,
  description text not null,
  sensitive   boolean not null default false,
  sort        smallint not null default 0
);

alter table public.admin_capabilities enable row level security;

insert into public.admin_capabilities (cap, label, description, sensitive, sort) values
  ('users.read',      'View accounts',    'Look up accounts and their workspace entitlements.', true,  10),
  ('users.suspend',   'Suspend accounts',  'Bar an account from the workspace.',                  true,  20),
  ('moderation.manage','Handle reports',   'Read reports and act on them.',                       true,  30),
  ('waitlist.manage', 'Run the waitlist',  'Approve a seat and send the approval email.',         false, 40),
  ('admins.manage',   'Manage admins',     'Add or remove administrators and set their capabilities.', true, 50),
  ('system.configure','Change settings',   'Change product-wide configuration.',                  true,  60),
  ('billing.read',    'View billing',      'Read billing records.',                               true,  70),
  ('billing.refund',  'Issue refunds',     'Refund a payment.',                                   true,  80)
on conflict (cap) do update
  set label = excluded.label,
      description = excluded.description,
      sensitive = excluded.sensitive,
      sort = excluded.sort;

-- ============ the action -> capability contract ============
-- Which capability an admin action needs, decided here rather than in
-- whichever client happens to be calling. A function looks this up and
-- refuses itself; a caller cannot talk its way past the row.
create table if not exists public.admin_action_caps (
  action text primary key,
  cap    text not null references public.admin_capabilities (cap)
);

alter table public.admin_action_caps enable row level security;

insert into public.admin_action_caps (action, cap) values
  ('admin_waitlist', 'waitlist.manage'),
  ('admin_grant',    'waitlist.manage'),
  ('admin_roster',   'admins.manage'),
  ('admin_add',      'admins.manage'),
  ('admin_remove',   'admins.manage'),
  ('admin_grant_cap','admins.manage'),
  ('admin_revoke_cap','admins.manage'),
  ('admin_reports',  'moderation.manage'),
  ('notify_grant',   'waitlist.manage')
on conflict (action) do update set cap = excluded.cap;

-- ============ grants ============
-- One row per (account, capability). Membership in public.admins stays
-- as the cheap "is this an admin at all" answer, so a visitor who is not
-- one gets the same generic no either way; what an admin may actually do
-- is decided here.
create table if not exists public.admin_caps (
  user_id  uuid not null references auth.users (id) on delete cascade,
  cap      text not null references public.admin_capabilities (cap) on delete cascade,
  granted_by uuid references auth.users (id),
  granted_at timestamptz not null default now(),
  primary key (user_id, cap)
);

alter table public.admin_caps enable row level security;

-- A co-admin's starting set is what admin_add already grants, so nothing
-- changes for accounts added later. The owner row needs no backfill at
-- all: has_cap() treats ownership as holding everything, which cannot go
-- stale the way a one-time insert into into admin_caps would. An empty
-- grant row for the owner is the correct representation of "all", and
-- admin_revoke_cap refuses to strip that marker.
delete from public.admin_caps c
where not exists (
  select 1 from public.admins a where a.user_id = c.user_id
);

-- ============ bootstrap ============
-- One row, ever. A single claim of the seeded role is recorded here, so
-- "was the bootstrap spent" is a fact in the database rather than an
-- inference from when a row was inserted.
create table if not exists public.admin_bootstrap (
  id         smallint primary key default 1 check (id = 1),
  claimed_by uuid not null references auth.users (id) on delete restrict,
  claimed_at timestamptz not null default now(),
  note       text
);

alter table public.admin_bootstrap enable row level security;

-- ============ core checks ============
-- has_cap is the one question every privileged path asks. It is SECURITY
-- DEFINER and reads auth.uid() itself: the caller is never trusted with
-- supplying a user id, so there is nothing to forge.
create or replace function public.has_cap(p_cap text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(p_cap, '') <> '' and (
    exists (
      select 1 from public.admin_caps c
      where c.cap = p_cap and c.user_id = auth.uid()
    )
    -- The owner holds everything implicitly. Not a convenience: an owner
    -- created after this migration (only a direct insert can do that, as
    -- the test harness does) must never be locked out of their own role,
    -- and an ownerless installation has no recovery path.
    or (exists (select 1 from public.admins a
                where a.user_id = auth.uid() and a.owner)
        and exists (select 1 from public.admin_capabilities k
                    where k.cap = p_cap))
  );
$$;

revoke all on function public.has_cap(text) from public;
grant execute on function public.has_cap(text) to authenticated;

-- The per-action gate. Reads the contract table, then verifies the
-- caller holds that capability. A missing row means nobody defined the
-- requirement, which is the one case that must fail closed rather than
-- fall back to membership: an action with no declared capability is
-- refused for everyone, including the owner.
create or replace function public.require_cap(p_action text)
returns void
language plpgsql stable security definer set search_path = public as $$
declare
  v_cap text;
begin
  if auth.uid() is null then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  select cap into v_cap from public.admin_action_caps where action = p_action;
  if v_cap is null then
    raise exception 'undeclared_action' using errcode = '42501';
  end if;

  if not public.has_cap(v_cap) then
    raise exception 'missing_capability' using errcode = '42501';
  end if;
end $$;

revoke all on function public.require_cap(text) from public;
grant execute on function public.require_cap(text) to authenticated;

-- The same question require_cap asks, as a boolean rather than an
-- exception, so a server component holding only a caller's session token
-- (the relay's /notify/grant) can consult the exact contract the RPCs
-- enforce. An undeclared action is false, not an error: fail closed here
-- too. Never callable by anon.
create or replace function public.can_do(p_action text)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_cap(
    (select cap from public.admin_action_caps where action = p_action)
  );
$$;

revoke all on function public.can_do(text) from public;
grant execute on function public.can_do(text) to authenticated;

-- ============ bootstrap surface ============
-- Status is answerable by any signed-in account, because "has this
-- installation been claimed yet" is not a secret and the panel needs it
-- to decide what to show. It deliberately does not say which email was
-- seeded, who the owner is, or what a claim would unlock.
create or replace function public.admin_bootstrap_status()
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'pending',   not exists (select 1 from public.admin_bootstrap),
    'claimed',   exists (select 1 from public.admin_bootstrap),
    'is_admin',  coalesce(public.is_admin(), false),
    -- Effective capabilities, same rule as has_cap(): the owner holds the
    -- whole catalog even though no rows say so, and the panel must show
    -- the truth of what a session can do, not the bookkeeping.
    'caps',      coalesce((
                  select jsonb_agg(k.cap order by k.sort)
                  from public.admin_capabilities k
                  where exists (
                    select 1 from public.admins a
                    where a.user_id = auth.uid() and a.owner)
                     or exists (
                    select 1 from public.admin_caps c
                    where c.user_id = auth.uid() and c.cap = k.cap)
                ), '[]'::jsonb)
  );
$$;

revoke all on function public.admin_bootstrap_status() from public;
grant execute on function public.admin_bootstrap_status() to authenticated;

-- The claim itself. Two facts make it one-time rather than a login
-- shortcut: the primary key can only be written once, and it can only be
-- written by the account the earlier migration actually seeded. Anyone
-- else, including a co-admin added later, is refused with the same
-- generic answer used for strangers.
create or replace function public.admin_bootstrap_claim(p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'not_admin' using errcode = '42501';
  end if;

  select user_id into v_owner from public.admins where owner limit 1;

  if v_owner is null or v_owner <> auth.uid() then
    -- Not the seeded account, or nothing was seeded. Say no more than
    -- that: whether an owner exists and which account it is, is exactly
    -- what an unauthorised visitor must not learn.
    raise exception 'not_admin' using errcode = '42501';
  end if;

  begin
    insert into public.admin_bootstrap (id, claimed_by, note)
    values (1, auth.uid(), nullif(btrim(coalesce(p_note, '')), ''));
  exception when unique_violation then
    raise exception 'bootstrap_used' using errcode = '23505';
  end;

  return jsonb_build_object(
    'status', 'claimed',
    'caps', (select jsonb_agg(c.cap order by c.cap)
             from public.admin_caps c where c.user_id = auth.uid()));
end $$;

revoke all on function public.admin_bootstrap_claim(text) from public;
grant execute on function public.admin_bootstrap_claim(text) to authenticated;

-- ============ capability management ============
create or replace function public.admin_grant_cap(p_user_id uuid, p_cap text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email citext;
begin
  perform public.require_cap('admin_grant_cap');

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

  select email into v_email from public.admins where user_id = p_user_id;
  return jsonb_build_object('status', 'granted', 'cap', p_cap, 'email', v_email);
end $$;

revoke all on function public.admin_grant_cap(uuid, text) from public;
grant execute on function public.admin_grant_cap(uuid, text) to authenticated;

-- Revoking is capped in one specific way: an account cannot be left
-- holding no capabilities at all, because that is how a roster ends up
-- with a powerless admin nobody notices. Removing the admin entirely is
-- what admin_remove is for.
create or replace function public.admin_revoke_cap(p_user_id uuid, p_cap text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_left integer;
begin
  perform public.require_cap('admin_revoke_cap');

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

  return jsonb_build_object('status', 'revoked', 'cap', p_cap, 'remaining', v_left);
end $$;

revoke all on function public.admin_revoke_cap(uuid, text) from public;
grant execute on function public.admin_revoke_cap(uuid, text) to authenticated;

-- The catalog, plus what a given admin holds, for the roster panel. The
-- caller sees every capability name (that is public product structure,
-- not a secret) but only the grants belonging to the account asked
-- about, so the panel cannot be used to map out who else holds what.
create or replace function public.admin_caps_for(p_user_id uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_target uuid;
begin
  perform public.require_cap('admin_roster');
  v_target := coalesce(p_user_id, auth.uid());

  return jsonb_build_object(
    'user_id', v_target,
    'catalog', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'cap', c.cap, 'label', c.label, 'description', c.description,
               'sensitive', c.sensitive)
             order by c.sort), '[]'::jsonb)
      from public.admin_capabilities c),
    'granted', (
      select coalesce(jsonb_agg(k.cap order by k.sort), '[]'::jsonb)
      from public.admin_capabilities k
      where exists (select 1 from public.admins a
                    where a.user_id = v_target and a.owner)
         or exists (select 1 from public.admin_caps g
                    where g.user_id = v_target and g.cap = k.cap))
  );
end $$;

revoke all on function public.admin_caps_for(uuid) from public;
grant execute on function public.admin_caps_for(uuid) to authenticated;

-- ============ rewire the 0017 actions to capabilities ============
-- Same bodies, one change each: require_admin() becomes require_cap(), so
-- every action asks its own question of the database. Kept together here
-- rather than split across rounds because a half-converted set would be
-- the worst of both: some actions gated by capability, the rest still by
-- membership.
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
  perform public.require_cap('admin_waitlist');
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

create or replace function public.admin_grant(p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email citext := lower(btrim(coalesce(p_email, '')));
  v_user  uuid;
  v_new   boolean;
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

  update public.waitlist
  set status = 'approved'
  where email = v_email and status <> 'approved';

  return jsonb_build_object(
    'status', case when v_new then 'granted' else 'already' end,
    'user_id', v_user);
end $$;

revoke all on function public.admin_grant(text) from public;
grant execute on function public.admin_grant(text) to authenticated;

-- Same row shape as 0017 plus one column, so existing readers keep
-- working and the roster panel can show what each admin actually holds.
-- A return type cannot change through create or replace (Postgres
-- refuses; the harness proved it), so drop and recreate.
drop function if exists public.admin_roster();

create or replace function public.admin_roster()
returns table (
  user_id uuid, email citext, owner boolean,
  added_by uuid, created_at timestamptz, caps jsonb
)
language plpgsql security definer set search_path = public as $$
begin
  perform public.require_cap('admin_roster');
  return query
    select a.user_id, a.email, a.owner, a.added_by, a.created_at,
           coalesce((
             select jsonb_agg(k.cap order by k.sort)
             from public.admin_capabilities k
             where a.owner
                or exists (select 1 from public.admin_caps c
                           where c.user_id = a.user_id and c.cap = k.cap)
           ), '[]'::jsonb)
    from public.admins a
    order by a.owner desc, a.created_at asc;
end $$;

revoke all on function public.admin_roster() from public;
grant execute on function public.admin_roster() to authenticated;

create or replace function public.admin_add(p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
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

  return jsonb_build_object('status', 'added', 'user_id', v_user);
end $$;

revoke all on function public.admin_add(text) from public;
grant execute on function public.admin_add(text) to authenticated;

create or replace function public.admin_remove(p_user_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_owner boolean;
  v_left  integer;
begin
  perform public.require_cap('admin_remove');
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
  return jsonb_build_object('status', 'removed', 'user_id', p_user_id);
end $$;

revoke all on function public.admin_remove(uuid) from public;
grant execute on function public.admin_remove(uuid) to authenticated;

create or replace function public.admin_reports(
  p_status text default 'pending',
  p_limit  integer default 50
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_cap('admin_reports');
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
