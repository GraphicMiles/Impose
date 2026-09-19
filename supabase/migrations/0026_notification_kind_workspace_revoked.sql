-- 0026: notifications.kind must accept 'workspace_revoked'.
--
-- Defect found by the 29-account behavioral simulation (tests/simulate_29_accounts.js):
-- admin_revoke_grant deleted the grant row and wrote the audit event, then
-- raised 23514 notifications_kind_check while inserting the member's
-- `workspace_revoked` inbox notice. The revoke therefore half-applied:
-- access was revoked with neither the notice nor a visible error path a
-- client could shape into a user-friendly message.
--
-- Allowing the new kind on the CHECK constraint is the whole fix: the RPC's
-- insert statement, the client inbox renderer (community.js kind mapping)
-- and the relay's /admin/revoke_grant inbox parity notice all already speak
-- the same kind string.

begin;

alter table public.notifications
  drop constraint if exists notifications_kind_check;

alter table public.notifications
  add constraint notifications_kind_check
  check (kind = any (array[
    'comment'::text,
    'reply'::text,
    'remix'::text,
    'challenge'::text,
    'waitlist_approved'::text,
    'workspace_revoked'::text
  ]));

commit;
