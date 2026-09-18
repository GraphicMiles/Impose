-- Enforce locking and lineage inside the write RPC.
--
-- Found by driving the flow as two users: A locks a post, B remixes it
-- anyway, and the row lands in the database. The lock was cosmetic.
--
-- The rules were written in 0001 as part of the INSERT policy on
-- generations, and they were correct there. Then 0004 moved writes to
-- create_generation, which is SECURITY DEFINER because it needs to touch
-- idempotency_keys. A security definer function runs as the owner, and the
-- owner is not subject to RLS, so the policy stopped being consulted the
-- moment the RPC became the only write path. Nothing failed loudly; the
-- checks simply stopped happening.
--
-- The earlier schema test passed throughout because it inserted directly
-- into the table, which does go through the policy. It was testing a path
-- the product no longer uses. The new assertions go through the RPC.
--
-- Three rules move into the function:
--   1. a locked parent cannot be remixed or challenged
--   2. a parent you cannot see cannot be remixed
--   3. kind and remix_of must agree: an original has no parent, a remix has

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

  if coalesce(p_visibility, 'public') not in ('public', 'private') then
    raise exception 'bad_visibility' using errcode = '22023';
  end if;
  if v_kind not in ('original', 'remix', 'challenge') then
    raise exception 'bad_kind' using errcode = '22023';
  end if;

  -- Kind and parent must agree, or lineage counts and the tree both lie.
  if v_kind = 'original' and p_remix_of is not null then
    raise exception 'original_cannot_have_parent' using errcode = '22023';
  end if;
  if v_kind in ('remix', 'challenge') and p_remix_of is null then
    raise exception 'lineage_needs_parent' using errcode = '22023';
  end if;

  if p_remix_of is not null then
    -- Visibility first: refusing a private post for the same reason as a
    -- locked one would tell a stranger that the post exists.
    if not exists (
      select 1 from public.generations g
       where g.id = p_remix_of
         and g.deleted_at is null
         and (g.visibility = 'public' or g.author_id = v_user)
    ) then
      raise exception 'parent_gone' using errcode = '22023';
    end if;

    -- The lock. The author said no; the server is where that is decided,
    -- not the button's disabled attribute.
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

-- Remove the remix that got through while the lock was unenforced.
delete from public.generations
 where remix_of in (select id from public.generations where locked = true)
   and author_id <> (select author_id from public.generations g2
                      where g2.id = generations.remix_of);
