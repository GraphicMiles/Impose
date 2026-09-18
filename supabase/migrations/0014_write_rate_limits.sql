-- Write rate limits, and closing the deleted-post comment leak.
--
-- Second adversarial pass found two things:
--
--   1. NOTHING RATE-LIMITED A WRITE. 0004 built rate_hit and rate_counters
--      for exactly this and granted them to the service role, but no write
--      path ever called them. One account could post, comment, or invoke
--      @bot thousands of times a minute: feed spam, notification storms,
--      and -- the moment addressed posts reach a real model -- a way to
--      keep the GPU box permanently busy with one browser tab. The limits
--      live in the RPCs because the RPCs are the only write path (direct
--      INSERT is not granted), and they run AFTER the idempotency check,
--      so a retry of the same key never spends budget twice.
--
--      Buckets, per fixed one-minute window:
--        gen:<user>            8   posts of any kind
--        bot:<user>            3   addressed posts: the @bot cooldown
--        bot:global           12   addressed posts across everyone: one
--                                  GPU box streams only so many answers
--        com:<user>           15   comments
--        com:<user>:<post>     5   comments on one thread
--
--      Generous for a person typing, useless for a script.
--
--   2. COMMENTS ON A DELETED POST STAYED READABLE. The comments select
--      policy gated on the parent's visibility but not its soft delete,
--      and thread_for -- security definer, so RLS does not apply to it --
--      had the same gap. Anyone holding a generation id could read a
--      deleted post's discussion through the raw API while the UI showed
--      a tombstone. Both now require the parent to be live.

-- ============ comments of deleted posts are gone with the post ==========
drop policy if exists "comments follow generation visibility" on public.comments;
create policy "comments follow generation visibility"
  on public.comments for select using (
    exists (
      select 1 from public.generations g
      where g.id = generation_id
        and g.deleted_at is null
        and (g.visibility = 'public' or g.author_id = auth.uid())
    )
  );

-- ============ one thread, one query (deleted-aware) ============
create or replace function public.thread_for(p_gen uuid)
returns table (
  id uuid, generation_id uuid, author_id uuid, handle text, display_name text,
  parent_id uuid, body text, created_at timestamptz, updated_at timestamptz,
  deleted_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select c.id, c.generation_id, c.author_id, p.handle, p.display_name,
         c.parent_id, c.body, c.created_at, c.updated_at, c.deleted_at
    from public.comments c
    join public.profiles p on p.id = c.author_id
   where c.generation_id = p_gen
     and exists (
       select 1 from public.generations g
        where g.id = p_gen
          and g.deleted_at is null
          and (g.visibility = 'public' or g.author_id = auth.uid())
     )
   order by c.created_at asc, c.id asc;
$$;

-- ============ posts: bounded, and agent calls on a cooldown ============
-- Identical to the 0013 definition except for the three rate_hit calls
-- after the idempotency replay check. A replay returns the stored row
-- before reaching them, which is the point: the budget counts decisions,
-- not retries.
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

grant execute on function public.create_generation(uuid,text,text,boolean,text,text,text,uuid) to authenticated;

-- ============ comments: bounded, per person and per thread ============
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

  if char_length(btrim(coalesce(p_body, ''))) < 1
     or char_length(coalesce(p_body, '')) > 1000 then
    raise exception 'body_length' using errcode = '22023';
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

grant execute on function public.create_comment(uuid,uuid,text,uuid) to authenticated;
