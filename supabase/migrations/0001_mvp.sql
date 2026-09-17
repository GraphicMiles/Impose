-- Botocracy MVP schema — Supabase (managed Postgres).
-- Rationale for the platform choice lives in docs/PRODUCT_PLAN.md (§7):
-- relational fits the domain (feed pagination, remix lineage, threaded
-- comments, grants), RLS enforces authorization server-side, and plain
-- Postgres keeps the exit path open. Run with: supabase db push

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
create unique index waitlist_email_key on public.waitlist (email);
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
  response    text not null check (char_length(response) between 1 and 20000),
  model       text,
  visibility  text not null default 'public' check (visibility in ('public','private')),
  remix_of    uuid references public.generations(id) on delete set null, -- lineage tree
  created_at  timestamptz not null default now()
);
-- Feed hot path: public posts newest-first with keyset pagination.
create index generations_feed_idx on public.generations (created_at desc, id)
  where visibility = 'public';
create index generations_author_idx on public.generations (author_id, created_at desc);
create index generations_remix_idx on public.generations (remix_of) where remix_of is not null;
alter table public.generations enable row level security;

create policy "public generations are readable by everyone"
  on public.generations for select using (visibility = 'public' or author_id = auth.uid());
create policy "authors create their own generations"
  on public.generations for insert with check (
    auth.uid() = author_id
    and visibility = any (array['public','private'])
  );
create policy "authors update their own generations"
  on public.generations for update using (auth.uid() = author_id)
  with check (auth.uid() = author_id);
create policy "authors delete their own generations"
  on public.generations for delete using (auth.uid() = author_id);

-- ============ comments (threaded) ============
create table public.comments (
  id            uuid primary key default gen_random_uuid(),
  generation_id uuid not null references public.generations(id) on delete cascade,
  author_id     uuid not null references public.profiles(id) on delete cascade,
  parent_id     uuid references public.comments(id) on delete cascade, -- reply tree
  body          text not null check (char_length(body) between 1 and 1000),
  created_at    timestamptz not null default now()
);
create index comments_thread_idx on public.comments (generation_id, created_at, id);
create index comments_parent_idx on public.comments (parent_id) where parent_id is not null;
alter table public.comments enable row level security;

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
        and (g.visibility = 'public' or g.author_id = auth.uid())
    )
  );
create policy "authors edit own comments"
  on public.comments for update using (auth.uid() = author_id)
  with check (auth.uid() = author_id);
create policy "authors delete own comments"
  on public.comments for delete using (auth.uid() = author_id);

-- ============ counters (denormalized, trigger-maintained) ============
-- Deliberate denormalization per the system-design skill: counts are read
-- on every feed row; keeping them here avoids count(*) per card. The
-- trigger is the single writer, so the copies cannot drift.
alter table public.generations
  add column comment_count integer not null default 0,
  add column remix_count   integer not null default 0;

create or replace function public.bump_comment_count() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.generations
     set comment_count = comment_count + (case when tg_op = 'INSERT' then 1 else -1 end)
   where id = coalesce(new.generation_id, old.generation_id);
  return null;
end $$;

create trigger comments_count_ai
  after insert on public.comments
  for each row execute function public.bump_comment_count();
create trigger comments_count_ad
  after delete on public.comments
  for each row execute function public.bump_comment_count();

-- ============ RPC: join the waitlist (anon callable, idempotent) ============
create or replace function public.join_waitlist(p_email text)
returns table (position integer, status text)
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
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)))
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
