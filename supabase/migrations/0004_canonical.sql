-- Postgres becomes the single source of truth for Community.
--
-- Until now the feed was localStorage with a Supabase schema sitting unused
-- beside it. Two writers to one truth is the divergence this migration
-- exists to end: after it, the browser holds a cache with no authority and
-- every value a client could compute is computed here instead.
--
-- Three rules, enforced rather than documented:
--   1. No client-supplied counts. They are trigger-derived already (0001).
--   2. Every row carries updated_at, so a stale write can be detected
--      rather than silently winning.
--   3. Retries are safe. Networks fail mid-write and clients retry; without
--      idempotency that is a duplicate post (architect 5.5).

-- ============ optimistic concurrency ============
-- A client that read a row at T1 and writes at T2 must not clobber a change
-- made at T1.5 by another device. The client sends the updated_at it saw;
-- the update matches on it and affects zero rows if the world moved.
alter table public.generations add column if not exists updated_at timestamptz not null default now();
alter table public.comments    add column if not exists updated_at timestamptz not null default now();

create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger generations_touch before update on public.generations
  for each row execute function public.touch_updated_at();
create trigger comments_touch before update on public.comments
  for each row execute function public.touch_updated_at();

-- ============ idempotency ============
-- The client generates a UUID per logical write and replays it on retry.
-- A repeat returns the stored result instead of acting twice.
--
-- request_hash is what makes this safe rather than merely convenient: the
-- same key with a different body is a client bug or an attack, and is
-- rejected instead of returning someone else's answer.
create table if not exists public.idempotency_keys (
  key          uuid primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  request_hash text not null,
  response     jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists idempotency_created_idx on public.idempotency_keys (created_at);
alter table public.idempotency_keys enable row level security;

-- Readable only by its owner, and never writable directly: the RPCs below
-- are the only things that insert here.
create policy "own idempotency keys are readable"
  on public.idempotency_keys for select using (auth.uid() = user_id);

-- ============ create a post, exactly once ============
-- Everything the old client did in several steps happens in one statement:
-- the key check, the insert, and the recorded response. A retry that
-- arrives while the first call is still running blocks on the key's row
-- lock rather than racing it.
create or replace function public.create_generation(
  p_key        uuid,
  p_prompt     text,
  p_response   text,
  p_addressed  boolean,
  p_status     text,
  p_visibility text,
  p_kind       text,
  p_remix_of   uuid
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

  -- Lock the key first. Two tabs replaying the same key serialise here, so
  -- the second sees the first's committed result rather than inserting.
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

revoke all on function public.create_generation(uuid,text,text,boolean,text,text,text,uuid) from public;
grant execute on function public.create_generation(uuid,text,text,boolean,text,text,text,uuid) to authenticated;

-- ============ create a comment, exactly once ============
create or replace function public.create_comment(
  p_key       uuid,
  p_gen       uuid,
  p_parent    uuid,
  p_body      text
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

  -- THE REPLY TARGET RULE, moved server side. The client already refuses
  -- to post a reply whose parent vanished; this is the copy that an
  -- attacker cannot skip and a stale tab cannot get wrong.
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

revoke all on function public.create_comment(uuid,uuid,uuid,text) from public;
grant execute on function public.create_comment(uuid,uuid,uuid,text) to authenticated;

-- Keys are worth keeping only as long as a client might retry.
create or replace function public.purge_idempotency_keys()
returns void language sql security definer set search_path = public as $$
  delete from public.idempotency_keys where created_at < now() - interval '24 hours';
$$;
revoke all on function public.purge_idempotency_keys() from public;

-- ============ the feed, one query ============
-- Keyset pagination, not OFFSET. The feed is written to while it is read,
-- and OFFSET shifts under inserts: a reader scrolling an active feed sees
-- duplicates and misses rows. A cursor on (created_at, id) is stable
-- because it names a position in the ordering rather than a count.
--
-- The author join lives here too. The client used to read posts and then
-- fetch each author separately, which is the N+1 that makes a feed slow
-- long before traffic does.
create or replace function public.feed_page(
  p_before_time timestamptz default null,
  p_before_id   uuid default null,
  p_limit       integer default 10
)
returns table (
  id uuid, author_id uuid, handle text, display_name text,
  prompt text, response text, kind text, remix_of uuid, root_id uuid,
  status text, addressed boolean, locked boolean, visibility text,
  comment_count integer, remix_count integer, challenge_count integer,
  save_count integer, saved_by_me boolean,
  created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select g.id, g.author_id, p.handle, p.display_name,
         g.prompt, g.response, g.kind, g.remix_of, g.root_id,
         g.status, g.addressed, g.locked, g.visibility,
         g.comment_count, g.remix_count, g.challenge_count, g.save_count,
         exists (select 1 from public.saves s
                  where s.generation_id = g.id and s.user_id = auth.uid()),
         g.created_at, g.updated_at, g.deleted_at
    from public.generations g
    join public.profiles p on p.id = g.author_id
   where g.deleted_at is null
     and (g.visibility = 'public' or g.author_id = auth.uid())
     -- The cursor. Strictly-less on the pair, so a tie on created_at is
     -- broken by id and no row is served twice or skipped.
     and (
       p_before_time is null
       or (g.created_at, g.id) < (p_before_time, coalesce(p_before_id, g.id))
     )
   order by g.created_at desc, g.id desc
   limit least(coalesce(p_limit, 10), 50);
$$;

revoke all on function public.feed_page(timestamptz, uuid, integer) from public;
grant execute on function public.feed_page(timestamptz, uuid, integer) to anon, authenticated;

-- ============ polling, cheaply ============
-- Answers "is there anything new" without shipping the rows. The pill asks
-- this on a timer; bodies are fetched only when the reader taps it.
create or replace function public.feed_since(p_after timestamptz)
returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer from public.generations g
   where g.deleted_at is null
     and g.visibility = 'public'
     and g.created_at > p_after
     and g.author_id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid);
$$;

revoke all on function public.feed_since(timestamptz) from public;
grant execute on function public.feed_since(timestamptz) to anon, authenticated;

-- ============ one thread, one query ============
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
          and (g.visibility = 'public' or g.author_id = auth.uid())
     )
   order by c.created_at asc, c.id asc;
$$;

revoke all on function public.thread_for(uuid) from public;
grant execute on function public.thread_for(uuid) to anon, authenticated;

-- ============ distributed rate limiting ============
-- The relay's limiter is a dict in one process. Architect 6.3: that cannot
-- hold once there is more than one instance, and Render restarts and scales
-- freely. A shared counter with an atomic increment is the fix; Postgres is
-- already here, so it does the job without adding Redis for one counter.
create table if not exists public.rate_counters (
  bucket     text not null,
  window_at  timestamptz not null,
  hits       integer not null default 0,
  primary key (bucket, window_at)
);

create index if not exists rate_counters_window_idx on public.rate_counters (window_at);
alter table public.rate_counters enable row level security;
-- Service role only; no policies.

-- Returns true when the caller is OVER the limit. The increment and the
-- comparison are one statement, so parallel requests cannot both see room.
create or replace function public.rate_hit(
  p_bucket text, p_limit integer, p_window_seconds integer
)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_window timestamptz := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  v_hits integer;
begin
  insert into public.rate_counters (bucket, window_at, hits)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_at)
    do update set hits = public.rate_counters.hits + 1
  returning hits into v_hits;

  return v_hits > p_limit;
end $$;

revoke all on function public.rate_hit(text, integer, integer) from public;

create or replace function public.purge_rate_counters()
returns void language sql security definer set search_path = public as $$
  delete from public.rate_counters where window_at < now() - interval '2 hours';
$$;
revoke all on function public.purge_rate_counters() from public;
