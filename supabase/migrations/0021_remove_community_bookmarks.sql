-- 0021: remove the community bookmark/save feature.
-- This is intentionally destructive and canonical: the feature is gone from
-- the product, its rows are deleted, and feed RPCs no longer expose save
-- fields. Older migration files remain immutable history.

begin;

-- Remove user bookmark data and its counter-maintenance trigger/policies.
drop table if exists public.saves cascade;
alter table public.generations drop column if exists save_count;

-- Recreate the public feed contract without bookmark fields.
drop function if exists public.feed_page(timestamptz, uuid, integer);
create or replace function public.feed_page(
  p_before_time timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 10
)
returns table (
  id uuid, author_id uuid, handle text, display_name text,
  prompt text, response text, kind text, remix_of uuid, root_id uuid,
  status text, addressed boolean, locked boolean, visibility text,
  comment_count integer, remix_count integer, challenge_count integer,
  created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select g.id, g.author_id, p.handle, p.display_name,
         g.prompt, g.response, g.kind, g.remix_of, g.root_id,
         g.status, g.addressed, g.locked, g.visibility,
         g.comment_count, g.remix_count, g.challenge_count,
         g.created_at, g.updated_at, g.deleted_at
    from public.generations g
    join public.profiles p on p.id = g.author_id
   where g.deleted_at is null
     and (g.visibility = 'public' or g.author_id = auth.uid())
     and (
       p_before_time is null
       or (g.created_at, g.id) < (p_before_time, coalesce(p_before_id, g.id))
     )
   order by g.created_at desc, g.id desc
   limit least(coalesce(p_limit, 10), 50);
$$;
revoke all on function public.feed_page(timestamptz, uuid, integer) from public;
grant execute on function public.feed_page(timestamptz, uuid, integer) to anon, authenticated;

-- Recreate profile feed with the same bookmark-free row shape.
drop function if exists public.profile_feed(text, timestamptz, uuid, integer);
create or replace function public.profile_feed(
  p_handle text,
  p_before_time timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 10
)
returns table (
  id uuid, author_id uuid, handle text, display_name text,
  prompt text, response text, kind text, remix_of uuid, root_id uuid,
  status text, addressed boolean, locked boolean, visibility text,
  comment_count integer, remix_count integer, challenge_count integer,
  created_at timestamptz, updated_at timestamptz, deleted_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select g.id, g.author_id, p.handle, p.display_name,
         g.prompt, g.response, g.kind, g.remix_of, g.root_id,
         g.status, g.addressed, g.locked, g.visibility,
         g.comment_count, g.remix_count, g.challenge_count,
         g.created_at, g.updated_at, g.deleted_at
    from public.generations g
    join public.profiles p on p.id = g.author_id
   where p.handle = ltrim(p_handle, '@')
     and g.deleted_at is null
     and (g.visibility = 'public' or g.author_id = auth.uid())
     and (
       p_before_time is null
       or (g.created_at, g.id) < (p_before_time, coalesce(p_before_id, g.id))
     )
   order by g.created_at desc, g.id desc
   limit least(coalesce(p_limit, 10), 50);
$$;
revoke all on function public.profile_feed(text, timestamptz, uuid, integer) from public;
grant execute on function public.profile_feed(text, timestamptz, uuid, integer) to anon, authenticated;

commit;
