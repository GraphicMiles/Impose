# C. Dead-End & Orphan Register — Second-Pass Audit

No records were deleted. “Dead” means no current producer/consumer was found in the repository; production proof is still required before removal.

| ID | Entity/path | Classification | Break sequence / orphan | Recovery | Owner of proof |
|---|---|---|---|---|---|
| O-01 | `saves` table/index/recount | LEGACY / DEAD CODE candidate | bookmark UI removed; rows and counts may remain without producer/consumer | catalog/data query and forward migration decision | DB owner |
| O-02 | old migration function bodies | LEGACY | earlier body is not effective after replacement; docs/tests may target wrong contract | final `pg_proc` dump | DB owner |
| O-03 | purge functions | PARTIAL IMPLEMENTATION | expired rows remain if no cron invokes purge | manual/cron verification | Ops/DB |
| O-04 | soft-deleted generations/comments | DATA INTEGRITY risk | notifications/reports/lineage/child references can outlive content | missing-target rendering; retention policy absent | DB/product |
| O-05 | notification targets | DATA INTEGRITY risk | source deleted before recipient opens notification | notification must resolve missing/deleted state; cleanup not proven | DB/community |
| O-06 | reports of deleted content | PARTIAL | target no longer visible but report remains | admin can resolve if target metadata retained | moderation/DB |
| O-07 | serialized workspace fields | DATA INTEGRITY risk | schema changes/corrupt JSON/oversize payload leave cache or DB state unreadable | import/export or conflict overwrite; migration not proven | workspace owner |
| O-08 | workspace stale revision | LOGIC/DATA integrity risk | tab A caches rev n, tab B writes n+1, A pushes stale payload | stale handler/pull/keep-mine, behavior needs authenticated proof | workspace/DB |
| O-09 | Community optimistic generation | PARTIAL | request commits, response lost, non-durable outbox cannot reconcile ID | feed reread may recover row; relation/comment mapping may not | community-data |
| O-10 | Community optimistic comment | PARTIAL | same response-loss sequence leaves pending memory row until reload | thread reread may replace; no durable queue | community-data |
| O-11 | auth codes/tickets/idempotency/rate rows | PARTIAL | purge function exists but invocation unknown | scheduler/manual purge | Ops |
| O-12 | duplicate GoTrue clients | SECURITY/DATA race | clients refresh same storage key concurrently; one request receives expired JWT | client consolidation/session refresh proof | auth owner |
| O-13 | access.js grant cache | DUPLICATE/CACHE | grant changes elsewhere but tab retains waitlisted/granted state | explicit refresh/session event | access owner |
| O-14 | service-worker old assets | OPERATIONAL dead-end | old JS calls old RPC while DB is new | cache version/clear | deployment |
| O-15 | standalone artifact | DUPLICATE | modular source and inline bundle diverge | build_inline regeneration | release owner |
| O-16 | profile/avatar cached creator object | DUPLICATE/CACHE | old card keeps old avatar until event/refetch | current profile event + id lookup; cross-tab proof incomplete | community |
| O-17 | local workspace provider/chat data | INTENTIONAL LOCAL | no DB row exists for default local use; device loss is expected by product model | export/import; not DB recovery | product decision |
| O-18 | notification actor/profile references | ORPHAN possibility | profile rename/deletion changes display lookup | stored actor snapshot vs live profile must be decided | DB/product |
| O-19 | parent comment/generation relationship | PARTIAL | concurrent parent soft-delete or hard-delete can reject/orphan child if FK cascade unknown | RPC rejection/thread pruning | DB catalog proof |
| O-20 | direct REST generation lock/delete | DUPLICATE mutation path | bypasses create RPC validation/rate/idempotency assumptions | RLS only if policy correct | DB/RLS proof |
| O-21 | admin bootstrap/capability state | PARTIAL | bootstrap claim/admin table/capability catalog can disagree under concurrent claims | DB transaction/unique constraints must be verified | admin/DB |
| O-22 | relay admin vs Supabase admin | SECURITY risk | relay allows action DB rejects, or relay misses capability DB requires | dual integration test | backend/security |
| O-23 | profile handle links | DATA integrity | rename makes old `/u/:handle` link resolve missing while generation author_id remains valid | immutable ID route/redirect not implemented | routing/product |
| O-24 | realtime channel | PARTIAL | disconnect causes UI not to receive update; polling/auth failure compounds | refetch on reconnect/focus | frontend/backend |
| O-25 | expired JWT | LOGIC dead-end | optimistic UI writes, request 401s, rollback/refresh not uniform | session refresh/sign-in/retry must be tested per mutation | auth/community/workspace |

## Entities with no verified current producer

- `saves` after bookmark removal.
- Purge invocation records (functions exist, scheduler not located).
- Any durable upload/object row; attachment UI is not proof of storage.
- Like/share/follow entities; none verified in migrations/current UI.
- Admin audit-log rows; no table verified.

## Entities with no verified current consumer

- Some historical save counters/rows.
- Potential legacy migration fields and superseded RPC signatures.
- Workspace serialized fields not represented by current app version.
- Notification related IDs after source deletion.

## Entities that can potentially exist without a valid parent

Production catalog proof required for all of these: notifications to deleted content, reports to deleted content, saves to deleted generations, comments to deleted generations, workspace state without a live auth identity, and admin capability rows after admin removal. Source functions attempt to protect several paths, but final FK `ON DELETE` actions and live RLS are not proven.
