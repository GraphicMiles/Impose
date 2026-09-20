-- ============================================================
-- 0028 — workspace_state policies must not read workspace_grants directly
-- ------------------------------------------------------------
-- 0023 hardened the REST surface of workspace_state with policies whose
-- predicates query public.workspace_grants. Policy expressions are part
-- of the caller's query: they run with the INVOKER's privileges, and
-- clients have no GRANT on workspace_grants (RPC-only by design, the same
-- isolation the waitlist carries). Since then, any direct select on
-- workspace_state as authenticated fails with
--
--   permission denied for table workspace_grants
--
-- which is exactly the pull half of workspace sync (workspace-sync.js
-- reads the table through PostgREST). Pushes were unaffected: they go
-- through save_workspace, a SECURITY DEFINER RPC that checks the grant
-- with owner privileges.
--
-- The question the policies ask already has a definer helper with the
-- right grant surface: my_workspace_access() (SECURITY DEFINER, granted
-- to authenticated, reads the grant as owner). The policies now ask the
-- helper instead of the table. Same rule, answered at the right
-- privilege: a member sees only their own row, a revoked or
-- never-granted account sees nothing.
-- ============================================================

drop policy if exists workspace_state_select_own on public.workspace_state;
create policy workspace_state_select_own on public.workspace_state
  for select using (
    auth.uid() = user_id
    and (select can_use_workspace from public.my_workspace_access())
  );

drop policy if exists workspace_state_insert_own on public.workspace_state;
create policy workspace_state_insert_own on public.workspace_state
  for insert with check (
    auth.uid() = user_id
    and (select can_use_workspace from public.my_workspace_access())
  );

drop policy if exists workspace_state_update_own on public.workspace_state;
create policy workspace_state_update_own on public.workspace_state
  for update using (
    auth.uid() = user_id
    and (select can_use_workspace from public.my_workspace_access())
  ) with check (
    auth.uid() = user_id
    and (select can_use_workspace from public.my_workspace_access())
  );

drop policy if exists workspace_state_delete_own on public.workspace_state;
create policy workspace_state_delete_own on public.workspace_state
  for delete using (
    auth.uid() = user_id
    and (select can_use_workspace from public.my_workspace_access())
  );
