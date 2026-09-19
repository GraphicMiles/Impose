# D. Production Verification Blockers — Second-Pass Audit

## Must verify before any shared data/backend development

### Privileged Supabase catalog

- Applied migration/version history.
- `pg_class`, `pg_attribute`, `pg_type`: every live table/column/type/nullable/default.
- `pg_constraint`: PK, FK, unique, check, exclusion, and `ON DELETE`/`ON UPDATE` actions.
- `pg_indexes`: every index, predicate, included column, and uniqueness.
- `pg_proc`: every final function name, argument signature, return type, security definer/invoker, search path, and body.
- `pg_trigger`: enabled trigger names, order, event, function, and transition behavior.
- `pg_policies`: exact RLS predicates for every table.
- `information_schema.role_table_grants` and routine grants.
- Realtime publication membership/replica identity.
- Live extensions and scheduled jobs/cron invocation.

### Authenticated role matrix

Run with fresh sessions for anonymous, owner, active user, waitlisted user, revoked user, profile owner, non-owner, admin without capability, each capability holder, and a second concurrent tab:

- Feed/detail/profile/thread reads.
- Create/update/delete/restore generation.
- Create/delete/restore comment/reply.
- Remix/challenge locked/unlocked behavior.
- Profile/avatar update and cross-tab propagation.
- Waitlist/grant/revoke.
- Notifications read/mark-read.
- Reports submit/resolve.
- Admin/bootstrap/capability operations.
- Workspace save/CAS conflict/reset.

Capture request, JWT state, RPC response, row mutation, trigger side effects, realtime event, and UI state.

### Failure/race matrix

- JWT expires at pointerdown, during request, after commit, and while refreshing.
- Request commits but response is dropped.
- Two GoTrue clients refresh concurrently.
- Two tabs write the same workspace revision.
- Two users edit profile/avatar simultaneously.
- Parent is deleted while a reply is being submitted.
- Generation is deleted while notification/report/detail is open.
- Realtime disconnects while polling/relay also fails.
- Service worker serves old client against new RPC.
- Duplicate tap/retry with same idempotency key.

### Operational proof

- Render deployed commit and asset manifest.
- Service-worker cache version and stale-client behavior.
- Relay environment/CORS/origin/control-key/session verification.
- Production cron/purge invocation logs.
- Backup/restore and retention policy.
- Admin action/audit trail availability.

## Nice to verify later

- Provider-specific CORS/model behavior.
- Rare media/search adapter failures.
- Legal/static page cache behavior.
- Browser-specific speech input.
- Performance under large comment/feed volume.
- Non-critical icon/animation behavior.

## Current blockers

Until the privileged catalog and authenticated matrix are complete, do not modify:

1. migrations/RLS/RPC authorization;
2. generation/comment counters/triggers;
3. profile/avatar ownership or visibility;
4. workspace conflict/persistence semantics;
5. auth client/session architecture;
6. admin capabilities or relay authorization;
7. cleanup/retention/cascade behavior.

The repository is sufficiently mapped for evidence collection, but the live database contract is not yet proven.
