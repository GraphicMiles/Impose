-- Content reports: the minimum moderation path.
--
-- Until now a reader who found abuse had exactly one recourse: the
-- feedback email. That is not moderation, it is hope. The flow brief
-- requires Created -> Visible -> Reported -> Under Review -> Actioned,
-- and the plan deferred it to "Phase C" on the assumption the corpus was
-- still seeded. It is no longer seeded: real posting is live, so the
-- report flag exists now and the operator works it from the dashboard
-- (or /admin/reports on the relay) until there is volume enough to
-- justify a queue UI.
--
-- Deliberately minimal:
--   * one report per person per target (unique constraint makes the RPC
--     naturally idempotent: a double-tap cannot stack reports);
--   * the reporter must actually be able to see what they report, which
--     also stops the table becoming a probe for private post ids;
--   * reporters are rate limited (20/hour) because a report IS an action
--     against someone, and an unreadable pile of them buries the real
--     ones;
--   * the reported user sees nothing: no state change happens at report
--     time, and revealing "under review" would hand abusers a probe.

create table public.reports (
  id          uuid primary key default extensions.gen_random_uuid(),
  kind        text not null check (kind in ('post', 'comment')),
  target_id   uuid not null,
  reporter_id uuid not null references public.profiles(id) on delete cascade,
  reason      text,
  status      text not null default 'pending'
              check (status in ('pending', 'reviewed', 'actioned', 'dismissed')),
  created_at  timestamptz not null default now(),

  -- Idempotency lives in the schema, not in a check-then-insert: two
  -- concurrent reports from the same person collide and the second
  -- simply sees the first.
  unique (target_id, reporter_id)
);

create index reports_pending_idx on public.reports (status, created_at)
  where status = 'pending';

alter table public.reports enable row level security;
-- No client policies, exactly like waitlist and workspace_grants: RLS is
-- on and nothing is granted to anon or authenticated, so PostgREST
-- returns nothing to a browser. Reports are read through the service
-- role only. The RPC below is SECURITY DEFINER, so it owns its own
-- access; it never exposes another person's report.

-- ============ the one write path ============
create or replace function public.report_content(
  p_kind   text,
  p_target uuid,
  p_reason text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_seen boolean := false;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  perform public.ensure_profile();

  if coalesce(p_kind, '') not in ('post', 'comment') then
    raise exception 'bad_kind' using errcode = '22023';
  end if;
  if char_length(coalesce(p_reason, '')) > 500 then
    raise exception 'reason_too_long' using errcode = '22023';
  end if;

  -- A report of something the reporter cannot see would confirm the
  -- existence of private content, so visibility doubles as validation.
  if p_kind = 'post' then
    v_seen := exists (
      select 1 from public.generations g
       where g.id = p_target
         and g.deleted_at is null
         and (g.visibility = 'public' or g.author_id = v_user)
    );
  else
    v_seen := exists (
      select 1 from public.comments c
       where c.id = p_target
         and c.deleted_at is null
         and exists (
           select 1 from public.generations g
            where g.id = c.generation_id
              and g.deleted_at is null
              and (g.visibility = 'public' or g.author_id = v_user)
         )
    );
  end if;

  if not v_seen then
    raise exception 'target_gone' using errcode = '22023';
  end if;

  -- One person flagging twenty things an hour is already a moderation
  -- event in itself; beyond that the flag loses meaning.
  if public.rate_hit('rep:' || v_user::text, 20, 3600) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  insert into public.reports (kind, target_id, reporter_id, reason)
  values (p_kind, p_target, v_user, nullif(btrim(coalesce(p_reason, '')), ''))
  on conflict (target_id, reporter_id) do nothing;

  if found then
    return jsonb_build_object('status', 'reported');
  end if;
  return jsonb_build_object('status', 'already');
end $$;

revoke all on function public.report_content(text, uuid, text) from public;
grant execute on function public.report_content(text, uuid, text) to authenticated;
