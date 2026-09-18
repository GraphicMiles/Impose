-- 0020: Waitlist approval notifications, beta auto-grant, and profile customization quota.

-- ============ 1. allow waitlist_approved notification kind ============
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications
  add constraint notifications_kind_check
  check (kind in ('comment','reply','remix','challenge','waitlist_approved'));

-- ============ 2. profile avatar and handle customization quota ============
alter table public.profiles add column if not exists avatar text;
alter table public.profiles add column if not exists username_changes_count integer not null default 0;
alter table public.profiles add column if not exists username_quota_exhausted_at timestamptz;

-- ============ 3. auto-grant on signup for approved waitlist emails ============
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_base   text;
  v_handle text;
  v_name   text;
  v_try    integer := 0;
begin
  v_base := lower(regexp_replace(split_part(new.email, '@', 1), '[^a-z0-9_]', '', 'gi'));
  v_base := left(nullif(v_base, ''), 20);
  if v_base is null then
    v_base := 'user';
  end if;

  v_handle := v_base;
  while exists (select 1 from public.profiles p where p.handle = v_handle) loop
    v_try := v_try + 1;
    v_handle := v_base || v_try::text;
    if v_try > 500 then
      v_handle := v_base || substr(replace(extensions.gen_random_uuid()::text, '-', ''), 1, 8);
      exit;
    end if;
  end loop;

  v_name := public.sanitize_display_name(
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  if v_name = '' then
    v_name := 'Someone';
  end if;

  insert into public.profiles (id, handle, display_name)
  values (new.id, v_handle, v_name)
  on conflict (id) do nothing;

  update public.waitlist
     set user_id = new.id
   where email = new.email and user_id is null;

  -- If this email was already approved on the waitlist, grant workspace access at once
  if exists (select 1 from public.waitlist where email = new.email and status = 'approved') then
    insert into public.workspace_grants (user_id) values (new.id)
    on conflict (user_id) do nothing;
  end if;

  return new;
end $$;

-- ============ 4. admin_grant notifies and handles pre-signup approvals ============
create or replace function public.admin_grant(p_email text)
returns jsonb
language plpgsql security definer set search_path = public as $$
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

  return jsonb_build_object(
    'status', case
      when v_new then 'granted'
      else 'already'
    end,
    'user_id', v_user);
end $$;

revoke all on function public.admin_grant(text) from public;
grant execute on function public.admin_grant(text) to authenticated;

-- ============ 5. admin_bootstrap_claim returns full caps catalog ============
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
    'caps', (select coalesce(jsonb_agg(k.cap order by k.sort), '[]'::jsonb)
             from public.admin_capabilities k));
end $$;

revoke all on function public.admin_bootstrap_claim(text) from public;
grant execute on function public.admin_bootstrap_claim(text) to authenticated;

-- ============ 6. customize_profile with 3 changes per 21 days quota ============
create or replace function public.customize_profile(
  p_display_name text,
  p_bio text,
  p_handle text default null,
  p_avatar text default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid      uuid := auth.uid();
  v_name     text;
  v_bio      text;
  v_handle   text;
  v_avatar   text;
  v_cur      public.profiles%rowtype;
  v_count    integer;
  v_exhaust  timestamptz;
  v_now      timestamptz := clock_timestamp();
  v_cooldown interval := interval '21 days';
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select * into v_cur from public.profiles where id = v_uid;
  if v_cur.id is null then
    raise exception 'no_profile' using errcode = '22023';
  end if;

  -- 1. Bio validation
  v_bio := nullif(btrim(coalesce(p_bio, '')), '');
  if v_bio is not null then
    if char_length(v_bio) > 300 then
      raise exception 'bio_too_long' using errcode = '22023';
    end if;
    if v_bio ~ '[\u0001-\u001f\u007f]' then
      raise exception 'bio_has_control_characters' using errcode = '22023';
    end if;
  end if;

  -- 2. Display name validation
  v_name := btrim(coalesce(p_display_name, ''));
  if p_display_name is not null and v_name <> '' then
    if v_name ~ '[\u0001-\u001f\u007f]' then
      raise exception 'name_has_control_characters' using errcode = '22023';
    end if;
    if char_length(v_name) > 40 then
      raise exception 'name_too_long' using errcode = '22023';
    end if;
    v_name := public.sanitize_display_name(v_name);
    if char_length(v_name) < 2 then
      raise exception 'name_too_short' using errcode = '22023';
    end if;
    if v_name !~ '[A-Za-z0-9]' then
      raise exception 'name_needs_letter_or_digit' using errcode = '22023';
    end if;
    if public.text_is_spammy(v_name) then
      raise exception 'name_not_acceptable' using errcode = '22023';
    end if;
  else
    v_name := v_cur.display_name;
  end if;

  -- 3. Avatar validation
  v_avatar := nullif(btrim(coalesce(p_avatar, '')), '');
  if v_avatar is null then
    v_avatar := v_cur.avatar;
  end if;

  -- 4. Handle customization quota check (3 changes per 21 days)
  v_count := coalesce(v_cur.username_changes_count, 0);
  v_exhaust := v_cur.username_quota_exhausted_at;

  -- If cooldown passed since last exhaustion, reset quota
  if v_exhaust is not null and v_now >= (v_exhaust + v_cooldown) then
    v_count := 0;
    v_exhaust := null;
  end if;

  v_handle := nullif(lower(btrim(coalesce(p_handle, ''))), '');
  if v_handle is not null then
    v_handle := ltrim(v_handle, '@');
  end if;

  if v_handle is not null and v_handle <> coalesce(v_cur.handle, '') then
    -- Check quota
    if v_count >= 3 then
      raise exception 'username_quota_exhausted' using errcode = '53100';
    end if;

    -- Validate handle format
    if char_length(v_handle) < 2 then
      raise exception 'handle_too_short' using errcode = '22023';
    end if;
    if char_length(v_handle) > 30 then
      raise exception 'handle_too_long' using errcode = '22023';
    end if;
    if v_handle !~ '^[a-z0-9_]+$' then
      raise exception 'handle_invalid_characters' using errcode = '22023';
    end if;
    if exists (select 1 from public.profiles where handle = v_handle and id <> v_uid) then
      raise exception 'handle_already_taken' using errcode = '23505';
    end if;

    v_count := v_count + 1;
    if v_count >= 3 then
      v_exhaust := v_now;
    end if;
  else
    v_handle := v_cur.handle;
  end if;

  update public.profiles
     set display_name = v_name,
         bio = v_bio,
         avatar = v_avatar,
         handle = v_handle,
         username_changes_count = v_count,
         username_quota_exhausted_at = v_exhaust
   where id = v_uid;

  return jsonb_build_object(
    'display_name', v_name,
    'bio', v_bio,
    'handle', v_handle,
    'avatar', v_avatar,
    'username_changes_count', v_count,
    'username_changes_remaining', greatest(0, 3 - v_count),
    'username_quota_exhausted_at', v_exhaust,
    'quota_exhausted', (v_count >= 3)
  );
end $$;

revoke all on function public.customize_profile(text, text, text, text) from public;
grant execute on function public.customize_profile(text, text, text, text) to authenticated;
