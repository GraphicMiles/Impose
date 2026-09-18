-- Notifications, and the data a profile page needs.
--
-- Community could post and read but not tell anyone they had been
-- answered. Someone replies to your post and you find out only if you
-- happen to reopen that thread, which is the half of a social loop that
-- makes a feed worth returning to. flow.txt 2 asks "who else is affected"
-- for every action; for a comment the answer is the post's author, and
-- nothing was done with it.
--
-- Written by trigger rather than by the client. A notification the sender
-- composes is one the sender can forge, and it would also be missing
-- whenever a write arrived through any path other than the one the client
-- knows about.

-- ============ notifications ============
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),

  -- Who is being told. Not who caused it.
  user_id     uuid not null references auth.users(id) on delete cascade,
  actor_id    uuid not null references public.profiles(id) on delete cascade,

  kind        text not null check (kind in ('comment','reply','remix','challenge')),

  -- What it happened to. Both nullable because a remix has no comment and
  -- the referenced row may later be deleted.
  generation_id uuid references public.generations(id) on delete cascade,
  comment_id    uuid references public.comments(id) on delete cascade,

  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- The unread badge is read on every page load, so it gets its own index
-- rather than scanning a growing history.
create index notifications_unread_idx
  on public.notifications (user_id, created_at desc)
  where read_at is null;
create index notifications_inbox_idx
  on public.notifications (user_id, created_at desc);

alter table public.notifications enable row level security;

-- You can read and dismiss your own. Nobody can create one directly: the
-- triggers below are security definer and are the only writers.
create policy "own notifications are readable"
  on public.notifications for select using (auth.uid() = user_id);
create policy "own notifications are dismissable"
  on public.notifications for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

grant select, update (read_at) on public.notifications to authenticated;

-- ============ who gets told ============
create or replace function public.notify_on_comment() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_post_author uuid;
  v_parent_author uuid;
begin
  select author_id into v_post_author from public.generations where id = new.generation_id;

  if new.parent_id is not null then
    select author_id into v_parent_author from public.comments where id = new.parent_id;
  end if;

  -- Answering a comment tells the comment's author. Answering a post tells
  -- the post's author. A reply to your own comment on your own post is one
  -- event, not two, and never a notification to yourself.
  if v_parent_author is not null and v_parent_author <> new.author_id then
    insert into public.notifications (user_id, actor_id, kind, generation_id, comment_id)
    values (v_parent_author, new.author_id, 'reply', new.generation_id, new.id);
  end if;

  if v_post_author is not null
     and v_post_author <> new.author_id
     and v_post_author is distinct from v_parent_author then
    insert into public.notifications (user_id, actor_id, kind, generation_id, comment_id)
    values (v_post_author, new.author_id, 'comment', new.generation_id, new.id);
  end if;

  return null;
end $$;

create trigger comments_notify
  after insert on public.comments
  for each row execute function public.notify_on_comment();

create or replace function public.notify_on_lineage() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_author uuid;
begin
  if new.remix_of is null then return null; end if;
  select author_id into v_author from public.generations where id = new.remix_of;
  if v_author is null or v_author = new.author_id then return null; end if;

  insert into public.notifications (user_id, actor_id, kind, generation_id)
  values (v_author, new.author_id,
          case when new.kind = 'challenge' then 'challenge' else 'remix' end,
          new.id);
  return null;
end $$;

create trigger generations_notify
  after insert on public.generations
  for each row execute function public.notify_on_lineage();

-- ============ reading the inbox ============
-- Joined, so the client does not fetch an actor profile per row: the N+1
-- that made the feed slow before it had traffic.
create or replace function public.notifications_page(p_limit integer default 20)
returns table (
  id uuid, kind text, actor_handle text, actor_name text,
  generation_id uuid, comment_id uuid, excerpt text,
  read_at timestamptz, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select n.id, n.kind, p.handle, p.display_name,
         n.generation_id, n.comment_id,
         coalesce(left(c.body, 140), left(g.prompt, 140)),
         n.read_at, n.created_at
    from public.notifications n
    join public.profiles p on p.id = n.actor_id
    left join public.comments c on c.id = n.comment_id and c.deleted_at is null
    left join public.generations g on g.id = n.generation_id and g.deleted_at is null
   where n.user_id = auth.uid()
     -- A notification whose subject was deleted has nothing to open.
     and (n.comment_id is null or c.id is not null)
     and (n.generation_id is null or g.id is not null)
   order by n.created_at desc
   limit least(coalesce(p_limit, 20), 50);
$$;

create or replace function public.notifications_unread()
returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer from public.notifications
   where user_id = auth.uid() and read_at is null;
$$;

create or replace function public.notifications_mark_read()
returns void
language sql security definer set search_path = public as $$
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null;
$$;

revoke all on function public.notifications_page(integer) from public;
revoke all on function public.notifications_unread() from public;
revoke all on function public.notifications_mark_read() from public;
grant execute on function public.notifications_page(integer) to authenticated;
grant execute on function public.notifications_unread() to authenticated;
grant execute on function public.notifications_mark_read() to authenticated;

-- ============ profiles ============
-- @handle rendered on every card and linked nowhere, so a reader could not
-- see who they were talking to or what else that person had written.
-- flow.txt 3: every button must have a destination.

alter table public.profiles add column if not exists bio text
  check (bio is null or char_length(bio) <= 300);

create or replace function public.profile_by_handle(p_handle text)
returns table (
  id uuid, handle text, display_name text, bio text,
  created_at timestamptz, post_count integer, is_me boolean
)
language sql stable security definer set search_path = public as $$
  select p.id, p.handle, p.display_name, p.bio, p.created_at,
         (select count(*)::integer from public.generations g
           where g.author_id = p.id and g.deleted_at is null
             and (g.visibility = 'public' or g.author_id = auth.uid())),
         p.id = auth.uid()
    from public.profiles p
   where p.handle = ltrim(p_handle, '@');
$$;

-- Someone's posts, same keyset shape as the main feed so the client reuses
-- one pagination path rather than growing a second.
create or replace function public.profile_feed(
  p_handle      text,
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
   where p.handle = ltrim(p_handle, '@')
     and g.deleted_at is null
     -- A visitor sees public posts; the owner also sees their own private ones.
     and (g.visibility = 'public' or g.author_id = auth.uid())
     and (
       p_before_time is null
       or (g.created_at, g.id) < (p_before_time, coalesce(p_before_id, g.id))
     )
   order by g.created_at desc, g.id desc
   limit least(coalesce(p_limit, 10), 50);
$$;

create or replace function public.update_my_profile(p_display_name text, p_bio text)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  update public.profiles
     set display_name = coalesce(nullif(btrim(p_display_name), ''), display_name),
         bio = nullif(btrim(coalesce(p_bio, '')), '')
   where id = auth.uid();
end $$;

revoke all on function public.profile_by_handle(text) from public;
revoke all on function public.profile_feed(text, timestamptz, uuid, integer) from public;
revoke all on function public.update_my_profile(text, text) from public;
grant execute on function public.profile_by_handle(text) to anon, authenticated;
grant execute on function public.profile_feed(text, timestamptz, uuid, integer) to anon, authenticated;
grant execute on function public.update_my_profile(text, text) to authenticated;

-- Notifications are realtime: the badge should not wait for a page load.
alter publication supabase_realtime add table public.notifications;
alter table public.notifications replica identity full;
