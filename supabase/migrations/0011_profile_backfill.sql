-- Every auth user must have a profile, including ones created before the
-- trigger existed.
--
-- Found in production from a debug log: a signed-in user could not post at
-- all. Every write failed with
--
--   insert or update on table "generations" violates foreign key
--   constraint "generations_author_id_fkey"
--   Key (author_id)=(955f8cbc...) is not present in table "profiles"
--
-- generations.author_id references profiles, not auth.users, so an account
-- with no profile row can sign in, read the feed, and fail on every single
-- write. Both real accounts on this project were in that state: created
-- before handle_new_user was fixed, and nothing ever went back for them.
--
-- Two parts, because a backfill alone leaves the same hole open for any
-- user created by a path that bypasses the trigger: an admin import, a
-- future OAuth provider, a restore from backup.

-- ============ 1. backfill ============
-- Same handle rules as handle_new_user. One statement with a window
-- function rather than a loop, so two users whose emails slug to the same
-- base cannot collide with each other.
with missing as (
  select u.id,
         u.email,
         coalesce(
           nullif(left(lower(regexp_replace(split_part(u.email, '@', 1),
                                            '[^a-z0-9_]', '', 'gi')), 20), ''),
           'user'
         ) as base,
         coalesce(u.raw_user_meta_data->>'display_name',
                  split_part(u.email, '@', 1)) as display_name
    from auth.users u
    left join public.profiles p on p.id = u.id
   where p.id is null
),
numbered as (
  select m.*,
         row_number() over (partition by m.base order by m.id) as n,
         (select count(*) from public.profiles p2 where p2.handle = m.base) as taken
    from missing m
)
insert into public.profiles (id, handle, display_name)
select id,
       case when n = 1 and taken = 0 then base
            else base || (n + taken)::text end,
       display_name
  from numbered
on conflict (id) do nothing;

-- ============ 2. stop it recurring ============
-- A profile is a hard requirement of every write, so its absence is
-- repaired where it is noticed rather than surfacing as a foreign key
-- error the user can do nothing about.
create or replace function public.ensure_profile()
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user   uuid := auth.uid();
  v_email  text;
  v_base   text;
  v_handle text;
  v_try    integer := 0;
begin
  if v_user is null then return; end if;
  if exists (select 1 from public.profiles where id = v_user) then return; end if;

  select email into v_email from auth.users where id = v_user;

  v_base := lower(regexp_replace(split_part(coalesce(v_email, 'user'), '@', 1),
                                 '[^a-z0-9_]', '', 'gi'));
  v_base := left(nullif(v_base, ''), 20);
  if v_base is null then v_base := 'user'; end if;

  v_handle := v_base;
  while exists (select 1 from public.profiles p where p.handle = v_handle) loop
    v_try := v_try + 1;
    v_handle := v_base || v_try::text;
    if v_try > 500 then
      v_handle := v_base || substr(replace(extensions.gen_random_uuid()::text, '-', ''), 1, 8);
      exit;
    end if;
  end loop;

  insert into public.profiles (id, handle, display_name)
  values (v_user, v_handle,
          coalesce(nullif(split_part(coalesce(v_email, ''), '@', 1), ''), 'Someone'))
  on conflict (id) do nothing;
end $$;

revoke all on function public.ensure_profile() from public;
grant execute on function public.ensure_profile() to authenticated;

-- ============ 3. call it on the write path ============
-- Redefining both RPCs so the profile check runs before the insert that
-- would otherwise fail on the foreign key. Everything else about these is
-- unchanged from 0007.

create or replace function public.create_generation(
  p_key        uuid,
  p_prompt     text,
  p_response   text    default '',
  p_addressed  boolean default false,
  p_status     text    default 'complete',
  p_visibility text    default 'public',
  p_kind       text    default 'original',
  p_remix_of   uuid    default null
)
returns public.generations
language plpgsql security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_hash  text;
  v_prior public.idempotency_keys;
  v_row   public.generations;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  -- An account with no profile can sign in and read but fails every write
  -- on the foreign key. Repair it here rather than returning 23503.
  perform public.ensure_profile();

  v_hash := encode(extensions.digest(
    coalesce(p_prompt,'') || '|' || coalesce(p_response,'') || '|' ||
    coalesce(p_visibility,'') || '|' || coalesce(p_kind,'') || '|' ||
    coalesce(p_remix_of::text,''), 'sha256'), 'hex');

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

  insert into public.generations
    (author_id, prompt, response, addressed, status, visibility, kind, remix_of)
  values
    (v_user, p_prompt, coalesce(p_response,''), coalesce(p_addressed,false),
     coalesce(p_status,'complete'), coalesce(p_visibility,'public'),
     coalesce(p_kind,'original'), p_remix_of)
  returning * into v_row;

  insert into public.idempotency_keys (key, user_id, request_hash, response)
  values (p_key, v_user, v_hash, jsonb_build_object('id', v_row.id));

  return v_row;
end $$;

create or replace function public.create_comment(
  p_key    uuid,
  p_gen    uuid,
  p_body   text,
  p_parent uuid default null
)
returns public.comments
language plpgsql security definer set search_path = public as $$
declare
  v_user  uuid := auth.uid();
  v_hash  text;
  v_prior public.idempotency_keys;
  v_row   public.comments;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  perform public.ensure_profile();

  v_hash := encode(extensions.digest(
    p_gen::text || '|' || coalesce(p_parent::text,'') || '|' || coalesce(p_body,''),
    'sha256'), 'hex');

  select * into v_prior from public.idempotency_keys where key = p_key for update;
  if found then
    if v_prior.user_id <> v_user or v_prior.request_hash <> v_hash then
      raise exception 'idempotency_key_reused' using errcode = '22023';
    end if;
    select * into v_row from public.comments where id = (v_prior.response->>'id')::uuid;
    return v_row;
  end if;

  if p_parent is not null then
    if not exists (
      select 1 from public.comments c
       where c.id = p_parent and c.generation_id = p_gen and c.deleted_at is null
    ) then
      raise exception 'parent_gone' using errcode = '22023';
    end if;
  end if;

  if not exists (
    select 1 from public.generations g
     where g.id = p_gen and g.deleted_at is null
       and (g.visibility = 'public' or g.author_id = v_user)
  ) then
    raise exception 'post_gone' using errcode = '22023';
  end if;

  insert into public.comments (generation_id, author_id, parent_id, body)
  values (p_gen, v_user, p_parent, p_body)
  returning * into v_row;

  insert into public.idempotency_keys (key, user_id, request_hash, response)
  values (p_key, v_user, v_hash, jsonb_build_object('id', v_row.id));

  return v_row;
end $$;

grant execute on function public.create_generation(uuid,text,text,boolean,text,text,text,uuid) to authenticated;
grant execute on function public.create_comment(uuid,uuid,text,uuid) to authenticated;
