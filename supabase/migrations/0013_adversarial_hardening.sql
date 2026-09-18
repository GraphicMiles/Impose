-- Adversarial hardening after a live-project privilege and flow audit.
--
-- Four findings, all confirmed against the real project before writing:
--
--   1. TRUNCATE, REFERENCES and TRIGGER were granted to anon and
--      authenticated on almost every table. Supabase's project defaults
--      grant ALL on new tables to the API roles, and the tables created in
--      0001-0004 predate the default-privilege revoke in 0005. TRUNCATE is
--      the one that matters: it does not consult row level security at all,
--      so a signed-out visitor one mistake away from a callable code path
--      could wipe the community. notifications, created after 0005, shows
--      what correct looks like: none of the three.
--
--   2. update_my_profile accepted anything: no length bound, no character
--      rules, no spam shape check. The display name column had no check
--      constraint either, so a megabyte name or one built from control and
--      zero-width characters stored fine and rendered on every feed card.
--      The browser prompts and slices, but a request does not have to come
--      from our page.
--
--   3. join_waitlist validated shape only. Disposable domains and
--      keyboard-mash local parts ("skskdjdjdjdh", "18w8e7shshsysysy")
--      joined freely, and nothing bounded table growth.
--
--   4. The signup trigger copied the raw email local part into
--      display_name. Now that account creation runs through the relay it is
--      validated there, but the database must not depend on one caller
--      behaving: admin imports and future OAuth paths fire the same
--      trigger. Sanitize where the data lands.
--
-- The spam-shape rules are deliberately mechanical and deliberately narrow:
-- they catch patterns (runs, block repetition, vowel-free letter soup),
-- never judgement. A real name always survives; a bot's random string
-- almost never does.

-- ============ 1. pull back the accidental privileges ============
-- Table level: TRUNCATE, REFERENCES, TRIGGER. The intended grants (SELECT
-- on the public tables, the column UPDATEs from 0005/0010) are untouched.
do $$
declare
  t record;
begin
  for t in
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
  loop
    execute format('revoke truncate, references, trigger on table public.%I from anon, authenticated', t.table_name);
  end loop;
end $$;

-- Column level: the same default grant can also leave per-column
-- REFERENCES that a table-level revoke does not remove, so sweep anything
-- the loop above still reports. SELECT grants stay: they are how the
-- public read policies are reached. (TRIGGER has no column form.)
do $$
declare
  g record;
begin
  for g in
    select distinct table_name, column_name, grantee
      from information_schema.column_privileges
     where table_schema = 'public'
       and privilege_type = 'REFERENCES'
       and grantee in ('anon', 'authenticated')
  loop
    execute format('revoke references (%I) on table public.%I from %I',
                   g.column_name, g.table_name, g.grantee);
  end loop;
end $$;

-- ============ 2. shared quality rules ============
-- One shape for both the profile name and the waitlist address. Mirrors
-- the relay's _local_part_is_spammy: same rules, same thresholds, so the
-- browser, the relay and the database refuse the same strings.
--
--   (.)\1{4}      the same character five or more times in a row
--   (..)\1\1      a two-character block repeated three times in a row
--   (...)\1\1     a three-character block repeated three times in a row
--   letters >= 6 with no vowel: letter soup
--
-- Pure and immutable: it reads nothing and decides nothing, so granting
-- nothing beyond the definer's use is fine.
create or replace function public.text_is_spammy(p_text text)
returns boolean
language sql immutable set search_path = public as $$
  select
       coalesce(p_text, '') ~ '(.)\1{4}'
    or coalesce(p_text, '') ~ '(..)\1\1'
    or coalesce(p_text, '') ~ '(...)\1\1'
    or (
      char_length(regexp_replace(coalesce(p_text, ''), '[^A-Za-z]', '', 'g')) >= 6
      and regexp_replace(coalesce(p_text, ''), '[^A-Za-z]', '', 'g') !~ '[aeiouAEIOU]'
    );
$$;

revoke all on function public.text_is_spammy(text) from public;

-- Storage sanitizer: control characters cannot be displayed and are a
-- classic way to smuggle structure past a length check; zero-width and
-- bidi marks let one name impersonate another. Strip them, collapse
-- whitespace runs, cap the length. Trimming is the caller's job because
-- "empty after trim" and "not supplied" mean different things upstream.
create or replace function public.sanitize_display_name(p_name text)
returns text
language sql immutable set search_path = public as $$
  select left(
    regexp_replace(
      regexp_replace(
        coalesce(p_name, ''),
        '[\u0001-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]', '', 'g'),
      '\s+', ' ', 'g'),
    40);
$$;

revoke all on function public.sanitize_display_name(text) from public;

-- ============ 3. profile writes are validated server side ============
-- Postgres has no ADD CONSTRAINT IF NOT EXISTS, so the guard is explicit.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'profiles_display_name_bounds') then
    alter table public.profiles
      add constraint profiles_display_name_bounds
      check (char_length(display_name) between 1 and 40);
  end if;
end $$;

create or replace function public.update_my_profile(p_display_name text, p_bio text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_name text;
  v_bio  text;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  v_bio := nullif(btrim(coalesce(p_bio, '')), '');
  if v_bio is not null then
    if char_length(v_bio) > 300 then
      raise exception 'bio_too_long' using errcode = '22023';
    end if;
    if v_bio ~ '[\u0001-\u001f\u007f]' then
      raise exception 'bio_has_control_characters' using errcode = '22023';
    end if;
  end if;

  -- A null or blank name means "keep the current one", which is what the
  -- earlier version did; only a name that is actually supplied is judged.
  v_name := btrim(coalesce(p_display_name, ''));
  if p_display_name is not null and v_name <> '' then
    if v_name ~ '[\u0001-\u001f\u007f]' then
      raise exception 'name_has_control_characters' using errcode = '22023';
    end if;
    if char_length(v_name) > 40 then
      raise exception 'name_too_long' using errcode = '22023';
    end if;

    v_name := public.sanitize_display_name(v_name);

    if char_length(v_name) < 2 then
      raise exception 'name_too_short' using errcode = '22023';
    end if;
    if v_name !~ '[A-Za-z0-9]' then
      raise exception 'name_needs_letter_or_digit' using errcode = '22023';
    end if;
    if public.text_is_spammy(v_name) then
      raise exception 'name_not_acceptable' using errcode = '22023';
    end if;
  end if;

  update public.profiles
     set display_name = coalesce(nullif(v_name, ''), display_name),
         bio = v_bio
   where id = auth.uid();
end $$;

-- The signature is unchanged, so the 0010 grants carry over untouched.

-- ============ 4. signup-derived names are sanitized at the boundary ====
-- The relay now refuses spam local parts before an account can exist, but
-- the trigger serves every path that can create an auth user, not just the
-- relay. Sanitize instead of trusting the caller; the constraint above is
-- the final check.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_base   text;
  v_handle text;
  v_name   text;
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
      v_handle := v_base || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
      exit;
    end if;
  end loop;

  v_name := public.sanitize_display_name(
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  if v_name = '' then
    v_name := 'Someone';
  end if;

  insert into public.profiles (id, handle, display_name)
  values (new.id, v_handle, v_name)
  on conflict (id) do nothing;

  update public.waitlist
     set user_id = new.id
   where email = new.email and user_id is null;
  return new;
end $$;

create or replace function public.ensure_profile()
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_user   uuid := auth.uid();
  v_email  text;
  v_base   text;
  v_handle text;
  v_name   text;
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

  v_name := public.sanitize_display_name(split_part(coalesce(v_email, ''), '@', 1));
  if v_name = '' then v_name := 'Someone'; end if;

  insert into public.profiles (id, handle, display_name)
  values (v_user, v_handle, v_name)
  on conflict (id) do nothing;
end $$;

-- ============ 5. the waitlist gets the same email rules as signup =======
-- Mirror the relay's domain list. The two are deliberately duplicated
-- rather than shared: this function runs in the database, the relay's list
-- runs in Python, and a join table across that boundary would be a third
-- moving part for no gain. Keep them in sync.
create or replace function public.join_waitlist(p_email text)
returns table (waitlist_position integer, status text)
language plpgsql security definer set search_path = public as $$
declare
  v_row    public.waitlist;
  v_local  text;
  v_domain text;
begin
  p_email := lower(btrim(p_email));

  if char_length(p_email) > 254
     or p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'invalid_email';
  end if;

  v_local  := split_part(p_email, '@', 1);
  v_domain := split_part(p_email, '@', 2);

  if char_length(v_local) > 64
     or v_local like '.%' or v_local like '%.' or v_local like '%..%' then
    raise exception 'invalid_email';
  end if;

  -- A keyboard-mash address cannot be reached, warned or suspended, which
  -- is exactly what an approval queue must not fill up with.
  if public.text_is_spammy(v_local) then
    raise exception 'invalid_email';
  end if;

  if v_domain in (
    'example.com', 'example.org', 'example.net', 'example.edu',
    'test.com', 'invalid', 'localhost', 'loadtest.invalid',
    'mailinator.com', 'tempmail.com', 'temp-mail.org', 'guerrillamail.com',
    '10minutemail.com', 'throwawaymail.com', 'yopmail.com', 'trashmail.com',
    'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc',
    'fakeinbox.com', 'mailnesia.com', 'spamgourmet.com', 'mintemail.com',
    'tempinbox.com', 'emailondeck.com', 'moakt.com', 'mohmal.com'
  ) or v_domain like 'mailinator.%' or v_domain like 'yopmail.%' then
    raise exception 'email_provider_not_accepted';
  end if;

  -- Idempotent: an address already on the list always gets its status,
  -- even a full list.
  select * into v_row from public.waitlist where email = p_email;
  if not found then
    -- Growth bound: the table is anonymously writable by design, so an
    -- unbounded insert is a slow way to spend the project's storage.
    -- Nobody realistically waits in a queue this long.
    if (select count(*) from public.waitlist) >= 100000 then
      raise exception 'waitlist_full' using errcode = '53100';
    end if;

    insert into public.waitlist (email)
    values (p_email)
    on conflict (email) do nothing;

    select * into v_row from public.waitlist where email = p_email;
  end if;

  if v_row.status = 'approved' then
    return query select 0::integer, 'approved'::text;
  else
    return query select v_row.position, v_row.status;
  end if;
end $$;

revoke all on function public.join_waitlist(text) from public;
grant execute on function public.join_waitlist(text) to anon, authenticated;

-- ============ 6. clean errors at the write RPCs ============
-- The table constraints already hold these bounds; the RPC is the only
-- write path, so checking here turns a constraint violation into a named
-- error the client can word for a person. Limits are unchanged.
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

  insert into public.comments (generation_id, author_id, parent_id, body)
  values (p_gen, v_user, p_parent, p_body)
  returning * into v_row;

  insert into public.idempotency_keys (key, user_id, request_hash, response)
  values (p_key, v_user, v_hash, jsonb_build_object('id', v_row.id));

  return v_row;
end $$;

grant execute on function public.create_comment(uuid,uuid,text,uuid) to authenticated;
