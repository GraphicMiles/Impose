-- Give the write RPCs defaults, so the API can actually call them.
--
-- Found by exercising the real endpoint rather than only psql. PostgREST
-- resolves an RPC by the exact set of argument NAMES in the JSON body, and
-- two things followed from the original signatures:
--
--   1. Omitting an argument is not "pass null", it is a different function
--      that does not exist, so the call 404s with PGRST202.
--   2. Passing an explicit JSON null for a uuid parameter gives PostgREST
--      nothing to infer a type from, so it 404s with 42883 instead.
--
-- Between them, every top-level post failed: the common case is exactly
-- the one with no parent. The SQL tests passed throughout because psql
-- types its own literals, which is why this needed an integration check.
--
-- Defaults fix both: an omitted argument resolves, and the optional ones
-- carry their own type.

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

  v_hash := encode(digest(
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

  v_hash := encode(digest(
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

  -- The reply-target rule, server side, where a stale tab cannot skip it.
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

-- The old four-argument create_comment would otherwise linger as an
-- overload, and PostgREST cannot choose between two candidates.
drop function if exists public.create_comment(uuid, uuid, uuid, text);

revoke all on function public.create_generation(uuid,text,text,boolean,text,text,text,uuid) from public;
revoke all on function public.create_comment(uuid,uuid,text,uuid) from public;
grant execute on function public.create_generation(uuid,text,text,boolean,text,text,text,uuid) to authenticated;
grant execute on function public.create_comment(uuid,uuid,text,uuid) to authenticated;
