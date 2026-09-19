-- 0022: canonical empty-project reset.
-- The current project is intentionally seeded with only the owner account.
-- Legacy auth users are not deleted here; application-owned data is reset and
-- the named owner is re-onboarded with full admin/workspace access.

begin;

do $$
declare
  v_owner uuid;
  v_email citext := 'rfarouq69@gmail.com';
  v_user record;
  v_base text;
  v_handle text;
  v_n integer;
begin
  select id into v_owner from auth.users where lower(email) = lower(v_email::text) limit 1;
  if v_owner is null then
    raise exception 'canonical_owner_missing';
  end if;

  delete from public.notifications;
  delete from public.reports;
  delete from public.comments;
  delete from public.generations;
  delete from public.workspace_state;
  delete from public.waitlist;
  delete from public.workspace_grants;
  delete from public.admin_caps;
  delete from public.admins;
  delete from public.admin_bootstrap;
  delete from public.profiles;

  insert into public.profiles (id, handle, display_name)
  values (v_owner, 'rfarouq69', 'rfarouq69');

  -- Keep existing auth identities usable after the data reset. They receive
  -- fresh profiles, but no workspace grant or admin capability.
  for v_user in select id, email from auth.users where id <> v_owner loop
    v_base := left(coalesce(nullif(regexp_replace(lower(split_part(v_user.email, '@', 1)), '[^a-z0-9_]', '', 'g'), ''), 'user'), 20);
    v_handle := v_base;
    v_n := 0;
    while exists (select 1 from public.profiles p where p.handle = v_handle) loop
      v_n := v_n + 1;
      v_handle := left(v_base, greatest(1, 20 - length(v_n::text))) || v_n::text;
    end loop;
    insert into public.profiles (id, handle, display_name)
    values (v_user.id, v_handle, split_part(v_user.email, '@', 1));
  end loop;

  insert into public.admins (user_id, email, owner, added_by)
  values (v_owner, v_email, true, null);

  insert into public.admin_caps (user_id, cap, granted_by)
  select v_owner, cap, v_owner from public.admin_capabilities;

  insert into public.workspace_grants (user_id, granted_by, note)
  values (v_owner, v_owner, 'Initial canonical owner grant');

  insert into public.waitlist (email, status, position, user_id)
  values (v_email, 'approved', 0, v_owner);

  insert into public.admin_bootstrap (id, claimed_by, note)
  values (1, v_owner, 'Canonical reset owner bootstrap');
end $$;

commit;
