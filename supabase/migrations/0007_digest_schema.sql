-- Qualify digest() explicitly.
--
-- Supabase installs pgcrypto into the `extensions` schema, not `public`.
-- The RPCs are declared `set search_path = public`, which is deliberate:
-- a security definer function with a loose search_path can be hijacked by
-- a caller who creates a same-named function in a schema that happens to
-- be searched first. The cost of that hardening is that digest() was not
-- visible, so every write RPC failed with
--   function digest(text, unknown) does not exist
--
-- Fixed by naming the schema at the call site rather than by widening
-- search_path, which would trade a real vulnerability for a convenience.
--
-- The local test harness never caught this because plain Postgres puts
-- pgcrypto in public. That difference between the test database and the
-- real one is the actual lesson here; the schema tests now create the
-- extension the way Supabase does.

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

-- handle_new_user also calls gen_random_uuid, which lives with pgcrypto.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_base   text;
  v_handle text;
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

  insert into public.profiles (id, handle, display_name)
  values (
    new.id,
    v_handle,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;

  update public.waitlist
     set user_id = new.id
   where email = new.email and user_id is null;
  return new;
end $$;

revoke all on function public.create_generation(uuid,text,text,boolean,text,text,text,uuid) from public;
revoke all on function public.create_comment(uuid,uuid,text,uuid) from public;
grant execute on function public.create_generation(uuid,text,text,boolean,text,text,text,uuid) to authenticated;
grant execute on function public.create_comment(uuid,uuid,text,uuid) to authenticated;
