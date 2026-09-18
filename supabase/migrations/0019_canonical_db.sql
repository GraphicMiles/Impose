-- 0019: the database finishes what it started.
--
-- Four gaps where the schema declared a fact and never maintained it, so
-- the client either rendered a hole or silently overwrote the truth:
--
--   * waitlist.position existed since 0001 and was never assigned. Every
--     row carried NULL, the admin queue rendered "#null", and the "you
--     are number N in line" promise never once showed a number. The
--     database now assigns the position at join time, under an advisory
--     lock so two simultaneous joins cannot share a number, and backfills
--     the rows that already exist in join order.
--
--   * save_workspace was unconditional last-write-wins over the whole
--     blob. Two devices editing in parallel silently destroyed each
--     other's workspace; the loser never learned. The write now carries
--     the revision the client believes it is updating; a mismatch raises
--     stale_workspace instead of overwriting, and the client resolves the
--     conflict with the person in front of it. Passing null keeps the old
--     behaviour so an unupgraded client is degraded, not broken.
--
--   * reports could be filed and read but never closed: the flow brief's
--     Reported -> Under Review -> Actioned had no Actioned. One RPC,
--     gated by the existing moderation.manage capability through the 0018
--     contract table, moves a pending report to its terminal state.
--
--   * purge_expired_auth_codes, purge_idempotency_keys and
--     purge_rate_counters were defined in 0004 and called by nothing.
--     Where pg_cron exists (the live project) they are scheduled here;
--     where it does not (the scratch harness) the block skips cleanly.

-- ============ waitlist: the queue gets its numbers ============

-- Backfill in join order, continuing after any position already taken.
update public.waitlist w
set position = s.rn + coalesce((select max(position) from public.waitlist), 0)
from (
  select id, row_number() over (order by created_at, id) as rn
  from public.waitlist
  where position is null
) s
where s.id = w.id and w.position is null;

-- Two people cannot hold the same place in one line.
create unique index if not exists waitlist_position_key
  on public.waitlist (position) where position is not null;

-- Same body as 0013 plus the assignment. The advisory lock serialises the
-- max()+1 so concurrent joins cannot collide; it is transaction-scoped and
-- taken only on the insert path, so the idempotent re-join stays lock-free.
create or replace function public.join_waitlist(p_email text)
returns table (waitlist_position integer, status text)
language plpgsql security definer set search_path = public as $$
declare
  v_row    public.waitlist;
  v_local  text;
  v_domain text;
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

  select * into v_row from public.waitlist where email = p_email;
  if not found then
    if (select count(*) from public.waitlist) >= 100000 then
      raise exception 'waitlist_full' using errcode = '53100';
    end if;

    -- Serialise the number handout. Without this, two joins in the same
    -- instant read the same max() and share a place in line.
    perform pg_advisory_xact_lock(hashtext('waitlist_position'));

    insert into public.waitlist (email, position)
    values (p_email,
            (select coalesce(max(w.position), 0) + 1 from public.waitlist w))
    on conflict (email) do nothing;

    select * into v_row from public.waitlist where email = p_email;
  end if;

  if v_row.status = 'approved' then
    return query select 0::integer, 'approved'::text;
  else
    return query select v_row.position, v_row.status;
  end if;
end $$;

revoke all on function public.join_waitlist(text) from public;
grant execute on function public.join_waitlist(text) to anon, authenticated;

-- ============ workspace: compare-and-set, not last-write-wins ============

-- The signature changes, and create or replace would leave the old
-- one-argument function alive beside it as an ambiguous overload.
drop function if exists public.save_workspace(jsonb);

create or replace function public.save_workspace(
  p_data jsonb,
  p_expected_rev bigint default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_cur  bigint;
  v_new_rev bigint;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
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

revoke all on function public.save_workspace(jsonb, bigint) from public;
grant execute on function public.save_workspace(jsonb, bigint) to authenticated;

-- ============ reports reach a terminal state ============

-- The action joins the 0018 contract so the same capability that reads
-- the queue closes it. A missing row would fail closed for everyone.
insert into public.admin_action_caps (action, cap) values
  ('admin_resolve_report', 'moderation.manage')
on conflict (action) do update set cap = excluded.cap;

create or replace function public.admin_resolve_report(
  p_id uuid,
  p_status text
)
returns jsonb
language plpgsql security definer set search_path = public as $$
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
    return jsonb_build_object('status', p_status);
  end if;
  if exists (select 1 from public.reports where id = p_id) then
    -- Two moderators, one report: the second learns it is settled
    -- instead of silently re-stamping it.
    return jsonb_build_object('status', 'already');
  end if;
  return jsonb_build_object('status', 'gone');
end $$;

revoke all on function public.admin_resolve_report(uuid, text) from public;
grant execute on function public.admin_resolve_report(uuid, text) to authenticated;

-- ============ the purges finally run ============

-- Scheduled where pg_cron exists (the live project); skipped where it
-- does not (the scratch harness). Idempotent: cron.schedule by name
-- replaces the existing job.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule('impose-purge-auth-codes', '17 * * * *',
                          'select public.purge_expired_auth_codes()');
    perform cron.schedule('impose-purge-idempotency', '23 3 * * *',
                          'select public.purge_idempotency_keys()');
    perform cron.schedule('impose-purge-rate-counters', '*/20 * * * *',
                          'select public.purge_rate_counters()');
  end if;
exception when others then
  raise notice 'pg_cron scheduling skipped: %', sqlerrm;
end $$;
