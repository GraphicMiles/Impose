# Final Closure Pass — UI, Backend, CRUD, Authorization & Abuse

Date: 2026-09-19

## Closure verdict

The source-level closure pass is complete. The platform is **not production-closed** because privileged production catalog/RLS/RPC/job/deployment access and authenticated role credentials were unavailable. Every unresolved item is classified below as **BLOCKED**, **INTENTIONAL**, **LEGACY/REMOVE**, **DEFECT**, or **CLOSED**; no item is left as UNKNOWN, PARTIAL, OPEN, or generic RISK.

No feature or backend redesign was implemented. Existing working behavior was not intentionally changed during this audit.

## Evidence executed

- Ordered migration review: `supabase/migrations/0001_mvp.sql` through `0022_canonical_owner_reset.sql`.
- Source contract trace: `app.js`, `community.js`, `community-data.js`, `workspace-sync.js`, `access.js`, `auth-client.js`, `server.js`, relay references, tests.
- `node --check` on active JavaScript modules.
- `python3 build_inline.py --check` and standalone regeneration checks.
- `git diff --check`.
- Public live Supabase `feed_page` RPC.
- Public live generation REST lookup using the full UUID.
- Public live profile lookup by immutable author UUID.
- Existing production debug log reviewed for JWT expiry, relay timeout, duplicate GoTrue clients, and mutation traffic.

Browser/device, authenticated-role, and privileged-catalog execution was not available. Those items are explicitly BLOCKED rather than inferred closed.

## Required final closure table

| Area | Initial state | Evidence | Final state | Remaining risk |
|---|---|---|---|---|
| UI/backend contracts | OPEN | Source call-site/RPC trace; syntax/build checks; public feed/detail probes | BLOCKED | Authenticated response/error matrix and final live RPC bodies unavailable |
| CRUD | PARTIAL | Entity/function inventory and client lifecycle trace | BLOCKED | Final FK/cascade/RLS/return-shape production proof unavailable |
| Ownership | UNKNOWN | Source uses auth user/author IDs in mapping and ownership paths | BLOCKED | Forged cross-user direct requests not executable without role sessions |
| RLS | UNKNOWN | RLS declarations present in migrations | BLOCKED | Live policies/grants not catalog-queried |
| Admin | UNKNOWN | DB capability and relay admin paths identified | BLOCKED | Anonymous/normal/revoked/capability role matrix unavailable |
| Optimistic UI | PARTIAL | Mutation handlers and rollback paths inspected | BLOCKED | Commit-with-lost-response and expired-JWT browser tests unavailable |
| Workspace CAS | PARTIAL | `workspace-sync.js` revision/push/pull/conflict code traced | BLOCKED | Two-tab/offline/crash/corrupt payload tests unavailable |
| Realtime | UNKNOWN | channel/watch/unwatch paths found | BLOCKED | Live publication, reconnect, duplication, and cleanup tests unavailable |
| Rate limiting | PARTIAL | rate tables/functions, RPC checks, relay controls inventoried | BLOCKED | Concurrent direct RPC/REST/relay abuse tests unavailable |
| Resource limits | UNKNOWN | client/server size/time/page limits identified in source | BLOCKED | Production endpoint configuration and load tests unavailable |
| Idempotency | PARTIAL | idempotency table/functions and generation/comment keys traced | BLOCKED | Concurrent replay and purge execution unavailable |
| Deletion/orphans | UNKNOWN | soft-delete/restore/triggers/logical references inventoried | BLOCKED | Live FK `ON DELETE` actions and lifecycle mutations unavailable |
| Notifications | PARTIAL | trigger/RPC/UI paths traced | BLOCKED | source-delete, duplicate-event, RLS and realtime tests unavailable |
| Deployment parity | BLOCKED | local build current; Express asset/deep-link smoke tests passed | BLOCKED | Render commit/assets/SW version/production migration parity unavailable |
| Auth/session | OPEN | debug log proves expired JWT and duplicate GoTrue warning | DEFECT / BLOCKED | Duplicate-client session race is concrete; remediation requires live session matrix |
| Avatar/profile identity | PARTIAL | current source resolves Community avatars by author UUID/profile row; live profile avatar is null | BLOCKED | Cross-tab/profile-change and production profile policy proof unavailable |
| Community feed | PARTIAL | live `feed_page` returned current generation | BLOCKED | authenticated/private/empty/error/realtime behavior unavailable |
| Legacy saves | LEGACY | schema/index references remain; current UI producer not found | LEGACY/REMOVE | Remove only after live row/reference/count query |
| Purge/retention | UNKNOWN | purge functions exist; scheduler not found in repository | BLOCKED | production cron/job evidence required |
| Standalone/service worker | DUPLICATE | generated artifact/build path present | INTENTIONAL | Release parity and cache invalidation need deployment evidence |
| Likes/share/follow | UNKNOWN | no current tables/actions found | LEGACY/REMOVE | Verify outside-repository/deployed references before deletion |

## Canonical UI-to-server contract status

### Community generation

```text
composer → sendGeneration → optimistic in-memory row
→ BotoData queue/create_generation → auth.uid + RPC validation
→ rate/idempotency → generations insert
→ lineage/notification/recount triggers
→ server row → local ID reconciliation
```

Status: **BLOCKED** for production proof. The local source has a concrete caller and response reconciliation, but response-loss recovery is not proven after durable Community outbox removal.

### Comment/reply

```text
composer/reply → optimistic comment → create_comment
→ auth.uid/parent/generation/rate/idempotency
→ comments insert → recount/notification
→ server row → thread reconciliation
```

Status: **BLOCKED**. Parent and ownership behavior require direct role tests.

### Lock/delete/restore

Direct REST/PATCH and RPC paths exist. Status: **BLOCKED** because direct policy enforcement and rollback under expired sessions are not proven.

### Profile/avatar

```text
General profile action → profile RPC → profiles row
→ same-tab profile-updated event → immediate UI repaint
→ profile refetch by immutable user ID → reconciliation
```

Status: **BLOCKED** for cross-tab/live production proof. Source-level authority is `profiles.id/avatar`; local workspace settings are a separate Workspace display source.

### Workspace

```text
app mutation → in-memory/local account state
→ WSync cache + save_workspace CAS
→ workspace_state revision response
→ cache revision reconciliation
```

Status: **INTENTIONAL dual-domain design**, but **BLOCKED** for stale-tab/offline/expiry proof. Local chat/provider settings are intentionally browser-owned; Workspace sync is DB-backed when configured.

## Authorization closure

No UI restriction was accepted as security proof. The source indicates server-side controls through auth.uid, RLS, capability RPCs, and relay checks. Direct forged-ID tests were not executable without authenticated sessions, so authorization is **BLOCKED**, not closed.

The following boundaries remain required production verification:

- User A cannot read/update/delete/restore User B’s generation/comment.
- User A cannot read/mutate User B’s workspace state.
- Waitlisted/revoked users cannot enter Workspace.
- Admin without capability cannot perform restricted operations.
- Revoked admin cannot reuse a previous capability.
- Anonymous users cannot invoke authenticated mutations.
- Locked/deleted/private content cannot be modified or exposed through alternate reads.
- Relay service-role paths cannot bypass Supabase capability decisions.

## Abuse and rate-limit closure

Current source controls are classified as **BLOCKED** rather than sufficient:

- `rate_counters` and `rate_hit` exist in migration source.
- Generation/comment paths reference rate/idempotency controls.
- Auth code/ticket expiry and attempt fields exist.
- Relay route size/timeout/destination controls exist in source.
- Workspace payload/revision controls exist in source.
- Purge functions exist, but scheduler execution is not verified.
- Cross-route, multi-tab, concurrent, multi-session, and multi-instance bypasses were not executable.

No new limits were added during this pass.

## Dead/legacy closure

| System | Final classification | Basis |
|---|---|---|
| Community `saves` table/UI contract | LEGACY/REMOVE | UI bookmark feature was removed; schema remains for historical compatibility; live rows/references require proof before removal |
| Earlier migration RPC bodies | LEGACY | superseded by later ordered definitions; retain immutable migrations |
| Community durable browser cache/outbox | LEGACY/REMOVE | current DB-only direction removed durable authority; unreachable branches should be removed only after tests |
| Workspace local cache | INTENTIONAL | browser cache is a performance/offline copy of Workspace state, not Community authority |
| Standalone build | INTENTIONAL | required portable artifact, regenerated from modular sources |
| Service worker | INTENTIONAL | production asset cache, but parity remains blocked |
| Likes/share/follow | LEGACY/REMOVE | no verified current schema/UI producer/consumer |
| Purge RPCs | BLOCKED | functions exist, invocation is unverified |

## Exact blocker list

| Blocker | Evidence | Exact failure | Affected data/users | Required verification | Status |
|---|---|---|---|---|---|
| Production schema contract | migrations only; no privileged catalog | live DB may differ in columns/RPC/RLS/FK/jobs | all private and Community data | privileged pg catalog/RLS/grant/publication dump | BLOCKED |
| Session authority | debug duplicate GoTrue + expired JWT | 401 reads/writes and stale optimistic state | authenticated users | single-session/expiry/concurrency browser test | DEFECT/BLOCKED |
| RPC replacement parity | repeated function replacements | old caller/parameter/security body may be live | all mutations | final pg_proc comparison | BLOCKED |
| Workspace conflict integrity | cache + CAS + serialized payload | stale overwrite/corrupt/unresolved state | Workspace users | two-tab/offline/crash/oversize matrix | BLOCKED |
| Community response loss | non-durable local outbox direction | committed row can remain failed/pending or lose ID mapping | posts/comments | forced response-loss/re-read test | BLOCKED |
| Orphan/retention lifecycle | soft-delete/logical refs, cascade unknown | dead notifications/reports/saves/children | content owners/admins | FK cascade + delete lifecycle test | BLOCKED |
| Admin dual plane | relay + DB capability paths | authorization disagreement/bypass | admins and protected data | direct role matrix both paths | BLOCKED |
| Abuse bounds | controls in source, no concurrent execution | spam/provider/email/DB amplification | platform/users/providers | direct concurrent and multi-route tests | BLOCKED |
| Deployment parity | local generated artifact only | stale frontend/SW/backend/migration mismatch | all users | Render/SW/asset/catalog fingerprint | BLOCKED |

## Stop condition result

The closure pass is complete as an evidence classification exercise, but the platform is **not production-closed**. No item is being falsely called secure because a migration, UI guard, rate-limit function, or RPC exists in source. The remaining items are explicitly BLOCKED or DEFECT with a concrete verification dependency.
