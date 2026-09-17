-- Botocracy MVP schema - Supabase (managed Postgres).
-- Rationale for the platform choice lives in docs/PRODUCT_PLAN.md (7):
-- relational fits the domain (feed pagination, remix lineage, threaded
-- comments, grants), RLS enforces authorization server-side, and plain
-- Postgres keeps the exit path open. Run with: supabase db push
--
-- This file was written against an earlier version of the product than the
-- one that now ships, and was corrected before it was ever applied. The
-- differences are called out inline as WHY notes so the reasoning is not
-- lost: the client grew soft delete with undo, plain posts that never call
-- the agent, per-user saves, challenge lineage, and locking, and the
-- original schema would have rejected or corrupted all five.

-- ============ extensions ============
create extension if not exists pgcrypto; -- gen_random_uuid
create extension if not exists citext;   -- case-insensitive waitlist emails

-- ============ profiles (1:1 with auth.users) ============
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  handle      text unique,
  display_name text not null default 'You',
  created_at  timestamptz not null default now()
);
alter table public.profiles enable row level security;

create policy "profiles are public read"
  on public.profiles for select using (true);
create policy "own profile update"
  on public.profiles for update using (auth.uid() = id)
  with check (auth.uid() = id);
-- no client-side insert policy: rows are created by the handle_new_user trigger (below).

-- ============ waitlist (public, anonymous-writable, idempotent) ============
create table public.waitlist (
  id          uuid primary key default gen_random_uuid(),
  email       citext unique not null,      -- unique = idempotent join (double-tap/retry safe)
  status      text not null default 'pending'
              check (status in ('pending','approved','rejected')),
  position    integer,
  created_at  timestamptz not null default now(),
  ip_hash     text,                        -- sha256(ip + daily salt), abuse forensics only
  user_id     uuid references auth.users(id) on delete set null
);
create index waitlist_status_created_idx on public.waitlist (status, created_at);
alter table public.waitlist enable row level security;
-- No client policies at all: joins go through the security definer RPC,
-- reads go through my_workspace_access. Anon key cannot select the table.

-- ============ workspace grants (the gate) ============
create table public.workspace_grants (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  granted_by uuid references auth.users(id),  -- admin who approved
  note       text
);
create index workspace_grants_granted_at_idx on public.workspace_grants (granted_at desc);
alter table public.workspace_grants enable row level security;
-- No client policies: membership is read through my_workspace_access only.
-- Grants are inserted by the admin (service role / dashboard), never by clients.

-- ============ generations (community posts) ============
create table public.generations (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.profiles(id) on delete cascade,
  prompt      text not null check (char_length(prompt) between 1 and 4000),

  -- WHY the check is <= and not "between 1 and": two states hold an empty
  -- response and both are legitimate. A post that does not address @bot is
  -- a plain post: it never calls the agent and never gets a response at
  -- all. An addressed post is empty for as long as it streams. The
  -- original "between 1 and 20000" rejected every plain post outright.
  response    text not null default '' check (char_length(response) <= 20000),

  model       text,
  visibility  text not null default 'public' check (visibility in ('public','private')),

  -- WHY kind exists: remix_of alone cannot tell a remix from a challenge,
  -- and the card renders them differently and counts them separately.
  kind        text not null default 'original'
              check (kind in ('original','remix','challenge')),
  remix_of    uuid references public.generations(id) on delete set null, -- lineage parent
  root_id     uuid references public.generations(id) on delete set null, -- lineage tree root

  -- WHY status is persisted: a tab closed mid-stream would otherwise leave
  -- a post that looks complete but has no body. Persisting the state lets
  -- the reader see "failed" and the author retry.
  status      text not null default 'complete'
              check (status in ('streaming','complete','failed')),

  -- WHY addressed is stored rather than re-derived: the @bot prefix is
  -- stripped from the prompt before saving, so the text cannot be
  -- re-inspected later to decide whether this was a question for the agent.
  addressed   boolean not null default false,

  -- WHY locked is a column: it gates who may remix or challenge a post.
  -- Enforced in the insert policy below, because a client-side flag is a
  -- UI convenience and not a permission.
  locked      boolean not null default false,

  -- WHY soft delete: a deleted post keeps its id and its place in the
  -- lineage graph so descendants survive, and undo is exact rather than a
  -- best-effort rebuild. Nothing is ever hard deleted on the app path.
  deleted_at  timestamptz,

  created_at  timestamptz not null default now(),

  -- Denormalized counters, trigger-maintained. See the counters section.
  comment_count   integer not null default 0,
  remix_count     integer not null default 0,
  challenge_count integer not null default 0,
  save_count      integer not null default 0
);

-- Feed hot path: live public posts newest-first with keyset pagination.
create index generations_feed_idx on public.generations (created_at desc, id)
  where visibility = 'public' and deleted_at is null;
create index generations_author_idx on public.generations (author_id, created_at desc);
create index generations_remix_idx on public.generations (remix_of) where remix_of is not null;
create index generations_root_idx on public.generations (root_id) where root_id is not null;
alter table public.generations enable row level security;

-- Deleted posts stay selectable: the feed hides them, but a thread still
-- has to render a tombstone where descendants hang off one.
create policy "public generations are readable by everyone"
  on public.generations for select using (visibility = 'public' or author_id = auth.uid());

create policy "authors create their own generations"
  on public.generations for insert with check (
    auth.uid() = author_id
    and visibility = any (array['public','private'])
    -- A remix or challenge must point at something, an original must not.
    and (
      (kind = 'original' and remix_of is null)
      or (kind in ('remix','challenge') and remix_of is not null)
    )
    -- Locking is enforced here, not in the browser. A forged request that
    -- targets a locked parent is rejected by the database.
    --
    -- NOTE the generations.remix_of qualification. Written as a bare
    -- `remix_of`, Postgres resolves the name against the subquery's own
    -- table and the clause silently becomes `p.id = p.remix_of`, which is
    -- a row comparing itself to its own parent: never true, so every
    -- legitimate remix was rejected while the check appeared to work. The
    -- outer table has to be named explicitly.
    and (
      generations.remix_of is null
      or exists (
        select 1 from public.generations p
        where p.id = generations.remix_of
          and p.locked = false
          and p.deleted_at is null
          and (p.visibility = 'public' or p.author_id = auth.uid())
      )
    )
  );

create policy "authors update their own generations"
  on public.generations for update using (auth.uid() = author_id)
  with check (auth.uid() = author_id);
create policy "authors delete their own generations"
  on public.generations for delete using (auth.uid() = author_id);

-- Lineage root, resolved server side so the client cannot get it wrong.
create or replace function public.set_generation_root() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.remix_of is null then
    new.root_id := new.id;
  else
    select coalesce(g.root_id, g.id) into new.root_id
      from public.generations g where g.id = new.remix_of;
  end if;
  return new;
end $$;

create trigger generations_set_root
  before insert on public.generations
  for each row execute function public.set_generation_root();

-- ============ comments (threaded) ============
create table public.comments (
  id            uuid primary key default gen_random_uuid(),
  generation_id uuid not null references public.generations(id) on delete cascade,
  author_id     uuid not null references public.profiles(id) on delete cascade,

  -- WHY the parent reference does NOT cascade: replies outlive the comment
  -- they answer. Deleting a parent renders a tombstone that holds the
  -- branch together; cascading would silently delete other people's
  -- replies, which is both data loss and a moderation hole. Nothing on the
  -- app path hard deletes anyway, so this only guards the dashboard and
  -- any future admin purge.
  parent_id     uuid references public.comments(id) on delete set null,

  -- WHY the length check has no lower bound: a soft-deleted comment clears
  -- its body so the text is genuinely gone, while the row survives to keep
  -- the reply graph intact. "between 1 and 1000" made that impossible.
  -- Non-empty is required only while the comment is live, below.
  body          text not null default '' check (char_length(body) <= 1000),

  deleted_at    timestamptz,
  created_at    timestamptz not null default now(),

  constraint comments_live_body_not_empty
    check (deleted_at is not null or char_length(btrim(body)) > 0)
);
create index comments_thread_idx on public.comments (generation_id, created_at, id);
create index comments_parent_idx on public.comments (parent_id) where parent_id is not null;
alter table public.comments enable row level security;

-- Answers one question for the insert policy: does this parent comment
-- exist on this same post? Security definer so the policy does not recurse
-- into itself. It leaks nothing: the caller already supplied both ids and
-- only learns whether they agree.
create or replace function public.comment_parent_matches(p_parent uuid, p_generation uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select p_parent is null or exists (
    select 1 from public.comments c
     where c.id = p_parent and c.generation_id = p_generation
  );
$$;

revoke all on function public.comment_parent_matches(uuid, uuid) from public;
grant execute on function public.comment_parent_matches(uuid, uuid) to authenticated;

-- A comment is readable iff its parent generation is readable (no IDOR
-- through private posts), writable iff you are the author of the comment.
create policy "comments follow generation visibility"
  on public.comments for select using (
    exists (
      select 1 from public.generations g
      where g.id = generation_id
        and (g.visibility = 'public' or g.author_id = auth.uid())
    )
  );
create policy "authors create their own comments"
  on public.comments for insert with check (
    auth.uid() = author_id
    and exists (
      select 1 from public.generations g
      where g.id = generation_id
        and g.deleted_at is null
        and (g.visibility = 'public' or g.author_id = auth.uid())
    )
    -- A reply must answer a comment on the same post. Without this, a
    -- forged parent_id could graft a reply from one thread onto another.
    -- Delegated to a security definer helper rather than an inline
    -- subquery. A policy on comments that itself selects from comments
    -- re-enters the same policy and Postgres aborts with "infinite
    -- recursion detected in policy for relation". The function runs as the
    -- owner, so its lookup is not policy-checked, and it is the narrowest
    -- possible read: one boolean about one parent id.
    and public.comment_parent_matches(comments.parent_id, comments.generation_id)
  );
create policy "authors edit own comments"
  on public.comments for update using (auth.uid() = author_id)
  with check (auth.uid() = author_id);
create policy "authors delete own comments"
  on public.comments for delete using (auth.uid() = author_id);

-- ============ saves (per-user, not per-post) ============
-- WHY this is a table and not a column: saving is one reader's private
-- bookmark. As a boolean on the shared generations row, one person saving
-- a post would mark it saved for everybody who reads it.
create table public.saves (
  user_id       uuid not null references auth.users(id) on delete cascade,
  generation_id uuid not null references public.generations(id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (user_id, generation_id)
);
create index saves_generation_idx on public.saves (generation_id);
alter table public.saves enable row level security;

-- You can only see, make, or remove your own saves. The public total
-- lives in generations.save_count, maintained by trigger.
create policy "own saves are readable"
  on public.saves for select using (auth.uid() = user_id);
create policy "own saves are insertable"
  on public.saves for insert with check (auth.uid() = user_id);
create policy "own saves are deletable"
  on public.saves for delete using (auth.uid() = user_id);

-- ============ counters (denormalized, trigger-maintained) ============
-- Deliberate denormalization per the system-design skill: counts are read
-- on every feed row, so keeping them here avoids count(*) per card.
--
-- WHY these recompute instead of incrementing: the original triggers did
-- "+1 on insert, -1 on delete", which is wrong twice over. Soft delete is
-- an UPDATE, so a deleted comment stayed counted forever; and any parallel
-- mutation drifts a running total away from the truth. The client learned
-- this same lesson and replaced its own increments with a derived count.
-- One statement per change, always equal to what a reader can actually see.

create or replace function public.recount_comments() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  target uuid := coalesce(new.generation_id, old.generation_id);
begin
  update public.generations g
     set comment_count = (
       select count(*) from public.comments c
        where c.generation_id = target and c.deleted_at is null
     )
   where g.id = target;
  return null;
end $$;

create trigger comments_recount
  after insert or delete or update of deleted_at, generation_id
  on public.comments
  for each row execute function public.recount_comments();

create or replace function public.recount_lineage() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  target uuid := coalesce(new.remix_of, old.remix_of);
begin
  if target is null then return null; end if;
  update public.generations g
     set remix_count = (
       select count(*) from public.generations c
        where c.remix_of = target and c.kind = 'remix' and c.deleted_at is null
     ),
     challenge_count = (
       select count(*) from public.generations c
        where c.remix_of = target and c.kind = 'challenge' and c.deleted_at is null
     )
   where g.id = target;
  return null;
end $$;

-- Covers the deleted_at flip too, so deleting a remix decrements its parent.
create trigger generations_recount_lineage
  after insert or delete or update of deleted_at, remix_of, kind
  on public.generations
  for each row execute function public.recount_lineage();

create or replace function public.recount_saves() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  target uuid := coalesce(new.generation_id, old.generation_id);
begin
  update public.generations g
     set save_count = (select count(*) from public.saves s where s.generation_id = target)
   where g.id = target;
  return null;
end $$;

create trigger saves_recount
  after insert or delete on public.saves
  for each row execute function public.recount_saves();

-- ============ RPC: soft delete, so the rules live server side ============
-- Ownership is re-checked here rather than trusted from the caller, and
-- the body is cleared in the same statement that tombstones the row: a
-- "deleted" comment whose text is still readable through the API is not
-- deleted. Undo restores the flag but not the text, which is why the
-- client keeps the original body in memory for the undo window.
create or replace function public.soft_delete_comment(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.comments
     set deleted_at = now(), body = ''
   where id = p_id and author_id = auth.uid() and deleted_at is null;
  if not found then
    raise exception 'not_found_or_not_yours';
  end if;
end $$;

create or replace function public.restore_comment(p_id uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if char_length(btrim(coalesce(p_body, ''))) = 0 then
    raise exception 'empty_body';
  end if;
  update public.comments
     set deleted_at = null, body = left(p_body, 1000)
   where id = p_id and author_id = auth.uid() and deleted_at is not null;
  if not found then
    raise exception 'not_found_or_not_yours';
  end if;
end $$;

revoke all on function public.soft_delete_comment(uuid) from public;
revoke all on function public.restore_comment(uuid, text) from public;
grant execute on function public.soft_delete_comment(uuid) to authenticated;
grant execute on function public.restore_comment(uuid, text) to authenticated;

-- ============ RPC: join the waitlist (anon callable, idempotent) ============
-- NOTE: the output column is waitlist_position, not position. "position" is
-- a reserved word in a RETURNS TABLE list and Postgres rejects it outright.
create or replace function public.join_waitlist(p_email text)
returns table (waitlist_position integer, status text)
language plpgsql security definer set search_path = public as $$
declare
  v_row public.waitlist;
begin
  -- server-side validation (the client is untrusted)
  p_email := lower(btrim(p_email));
  if p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email';
  end if;

  insert into public.waitlist (email)
  values (p_email)
  on conflict (email) do nothing;      -- idempotent: retry returns the same row

  select * into v_row from public.waitlist where email = p_email;

  if v_row.status = 'approved' then
    return query select 0::integer, 'approved'::text;
  else
    return query select v_row.position, v_row.status;
  end if;
end $$;

revoke all on function public.join_waitlist(text) from public;
grant execute on function public.join_waitlist(text) to anon, authenticated;

-- ============ RPC: my workspace access (auth callable) ============
-- One typed verdict; the client renders the gate from exactly this answer.
create or replace function public.my_workspace_access()
returns table (can_use_workspace boolean, email text, waitlist_position integer)
language sql security definer set search_path = public stable as $$
  select
    exists (select 1 from public.workspace_grants g where g.user_id = auth.uid()),
    (select coalesce(p.handle, p.display_name) from public.profiles p where p.id = auth.uid()),
    (select w.position from public.waitlist w where w.user_id = auth.uid() limit 1);
$$;

revoke all on function public.my_workspace_access() from public;
grant execute on function public.my_workspace_access() to authenticated;

-- ============ new user -> profile (and waitlist claim) ============
-- WHY the handle is generated here: the UI shows @handle on every card and
-- every comment. The original trigger set only display_name, so every
-- profile had a null handle and the whole feed would have rendered "@null".
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_base   text;
  v_handle text;
  v_try    integer := 0;
begin
  -- Strip to a safe slug, then guarantee it is not empty.
  v_base := lower(regexp_replace(split_part(new.email, '@', 1), '[^a-z0-9_]', '', 'gi'));
  v_base := left(nullif(v_base, ''), 20);
  if v_base is null then
    v_base := 'user';
  end if;

  -- Handles are unique, and two people named the same thing is ordinary,
  -- not exceptional. Suffix until one is free rather than failing signup.
  v_handle := v_base;
  while exists (select 1 from public.profiles p where p.handle = v_handle) loop
    v_try := v_try + 1;
    v_handle := v_base || v_try::text;
    if v_try > 500 then
      v_handle := v_base || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
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

  -- claim any waitlist row for this email; approval is still a manual grant
  update public.waitlist
     set user_id = new.id
   where email = new.email and user_id is null;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
