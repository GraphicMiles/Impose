-- 0016: per-account workspace state.
--
-- The workspace (chats, providers, folders, outbox, library, memories,
-- settings) lived entirely in one shared localStorage key. That made it
-- device-global and identity-blind: whoever opened the browser next saw
-- the previous person's chats, and signing out deliberately left them
-- behind ("Your local chats are still here"). The product decision is
-- that workspace data belongs to the account: it syncs per signed-in
-- user, and signing out leaves a clean session on the device.
--
-- Trust stance for the blob: the client encrypts provider API keys
-- before they leave the device (AES-GCM, key material never uploaded),
-- so the server stores ciphertext only and never sees plaintext keys.
-- The database therefore treats `data` as an opaque per-user document.
--
-- Shape: one row per user, last write wins, rev increments per write so
-- clients can tell a stale cache from a fresh one. No history: this is
-- working state, not an audit log, and chats already have export.

create table public.workspace_state (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  rev        bigint not null default 1,
  updated_at timestamptz not null default now()
);

alter table public.workspace_state enable row level security;

-- Owner-only access. `auth.uid()` is never set for the anon role, so
-- these four policies close anonymous access completely even though the
-- table grants below include only authenticated.
drop policy if exists workspace_state_select_own on public.workspace_state;
create policy workspace_state_select_own on public.workspace_state
  for select to authenticated
  using (auth.uid() = user_id);

drop policy if exists workspace_state_insert_own on public.workspace_state;
create policy workspace_state_insert_own on public.workspace_state
  for insert to authenticated
  with check (auth.uid() = user_id);

drop policy if exists workspace_state_update_own on public.workspace_state;
create policy workspace_state_update_own on public.workspace_state
  for update to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists workspace_state_delete_own on public.workspace_state;
create policy workspace_state_delete_own on public.workspace_state
  for delete to authenticated
  using (auth.uid() = user_id);

-- 0005 revoked table grants from both roles by default, so access is
-- opt-in per table. authenticated gets CRUD on its own rows (enforced by
-- the policies above); anon gets nothing.
grant select, insert, update, delete on public.workspace_state to authenticated;

-- ============ the one write path the client uses ============
-- Upsert with a size cap and a write rate limit. SECURITY DEFINER owns
-- its own access, but it can only ever touch the caller's row: user_id
-- is pinned to auth.uid() inside the statement, never taken from input.
create or replace function public.save_workspace(p_data jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid := auth.uid();
  v_new_rev bigint;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_data is null then
    raise exception 'bad_payload' using errcode = '22023';
  end if;
  -- 3 MiB. Image payloads are already downscaled client side; this stops
  -- a run-away client (or a hostile one) from parking megabytes per save.
  if octet_length(p_data::text) > 3145728 then
    raise exception 'payload_too_large' using errcode = '22023';
  end if;
  -- A debounced client saves at most once a second or so; thirty a minute
  -- leaves headroom for multi-tab churn while capping hammering.
  if public.rate_hit('ws:' || v_user::text, 30, 60) then
    raise exception 'rate_limited' using errcode = '53100';
  end if;

  insert into public.workspace_state (user_id, data, rev, updated_at)
  values (v_user, p_data, 1, now())
  on conflict (user_id) do update
    set data = excluded.data,
        rev = public.workspace_state.rev + 1,
        updated_at = now()
  returning rev into v_new_rev;

  return jsonb_build_object('rev', v_new_rev);
end $$;

revoke all on function public.save_workspace(jsonb) from public;
grant execute on function public.save_workspace(jsonb) to authenticated;
