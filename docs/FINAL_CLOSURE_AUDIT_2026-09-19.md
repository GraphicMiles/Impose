# Final Closure Audit — Contract Integrity, Live State, and Abuse Controls

Date: 2026-09-19. This pass performed source/migration/live-public evidence collection only. No new product feature, schema migration, RLS change, or backend refactor was implemented.

## Executive verdict

**NOT CLOSED.** The repository contract is mapped, but the platform cannot be declared clean because the production catalog, policies, final RPC bodies, realtime publication, jobs, roles, and authenticated role matrix were not available through privileged access. Public live evidence confirms the feed and profile endpoints exist, but cannot prove ownership/RLS/cascade behavior.

### Evidence actually obtained

- Ordered migrations `0001–0022` inspected.
- Current client call sites inspected in `community.js`, `community-data.js`, `app.js`, `access.js`, `auth-client.js`, `workspace-sync.js`.
- Current Express/static routes inspected.
- Live Supabase public `feed_page` returned generation `e817f9b4-4359-4249-9695-741e31552bf6`.
- Direct live REST lookup accepted the full UUID.
- Live profile lookup by immutable ID returned `avatar: null`.
- Existing debug log confirmed expired JWT, relay health failure, and multiple GoTrue clients.
- No privileged production catalog or authenticated role credentials were available.

## A. Production schema diff

| Migration expectation | Production observation | Result | Consequence |
|---|---|---|---|
| Core tables: profiles, waitlist, grants, generations, comments, saves | Public feed/profile calls work; full catalog unavailable | UNKNOWN | Cannot prove columns/FKs/RLS/cascades |
| Notifications/reports/workspace/admin tables | Source only; no privileged live query | UNKNOWN | Cannot prove final state or orphan rules |
| Repeated final RPC replacements | Source has repeated `create_generation`, `create_comment`, profile/admin definitions | PARTIAL | Production may be at a different replacement revision |
| Feed indexes/lineage/thread indexes | Migration text only | UNKNOWN | Planner/performance/uniqueness unproven |
| Recount/touch/notify/root triggers | Migration text only | UNKNOWN | Counters/notifications/lineage may drift if absent/old |
| RLS/grants/security definer/search path | Source text only | UNKNOWN / P0 if mismatch | UI restrictions cannot be treated as security |
| Realtime publication | Replica identity declarations found; publication membership unavailable | UNKNOWN | Update propagation may be absent |
| Purge jobs | purge functions found; no scheduler found in repository | UNKNOWN | Expired control rows may accumulate |

## B. Canonical ownership matrix

| Datum | Authority | Writers | Readers | Copies | Status |
|---|---|---|---|---|---|
| Auth identity | Supabase Auth | Auth/relay | auth clients, RPC auth.uid | GoTrue/browser session | PARTIAL; duplicate clients observed |
| Handle/name/bio/avatar | `profiles` keyed by auth UUID | profile RPC/trigger | app/community/comments/profile | in-memory card snapshots | VERIFIED source in current code; production RLS UNKNOWN |
| Workspace entitlement | grants/waitlist + access RPC | join/admin RPC | access/app/admin | access.js cache | PARTIAL/stale-cache risk |
| Community post | `generations` | create RPC/direct update/delete paths | feed/detail/profile/thread | in-memory optimistic row | PARTIAL response-loss risk |
| Comment/reply | `comments` | create/delete/restore RPC | thread/notifications | optimistic memory row | PARTIAL |
| Counters | DB triggers/RPCs | mutation triggers | cards/feed | in-memory display | UNKNOWN trigger parity |
| Notifications | notifications table/triggers | comment/lineage/grant paths | bell/inbox | in-memory badge | PARTIAL stale target risk |
| Reports | reports table | report RPC/admin | admin | UI list | PARTIAL retention unknown |
| Admin membership/caps | DB admin/cap tables/RPCs | admin/bootstrap | app/relay | UI capability snapshot | SECURITY risk if planes diverge |
| Workspace state | `workspace_state` | save_workspace | WSync/app | encrypted local cache | DATA integrity risk |
| Provider/chat/settings | local app state, optionally workspace_state | app/WSync | app | local cache/export | INTENTIONAL dual domain |

## C. Reader/writer matrix

| Entity | Readers | Writers | Backend boundary | Failure/reconcile |
|---|---|---|---|---|
| profiles | `myProfile`, profile RPC, latest avatar by ID, app header | `customize_profile`, `update_my_profile`, auth trigger | auth.uid/RPC/RLS | optimistic event then refetch; rollback avatar UI on profile write failure |
| generations | feed_page, generation REST, profile_feed, thread/lineage | create_generation, direct lock/delete/restore | RPC + direct REST/RLS | optimistic card/server-ID replacement; response-loss recovery not durable |
| comments | thread_for, realtime | create_comment, soft_delete/restore | RPC/RLS | optimistic row/thread refresh; non-durable response-loss path |
| saves | no current verified Community reader/writer | legacy schema only | UNKNOWN | legacy/dead candidate |
| notifications | notifications_page/unread/mark-read/realtime | DB triggers/admin grant | RLS/RPC | stale source target possible |
| reports | admin_reports | report_content/admin_resolve | RLS/capability RPC/relay | retention/audit unknown |
| workspace_state | WSync pull/boot | save_workspace | auth/RPC/CAS | stale rev conflict handler; cache can precede DB |
| admin | admin RPCs/relay | bootstrap/add/remove | DB caps + relay | two authorization planes |

## D. Orphan and referential-integrity matrix

| Relationship | Parent disappearance | Current evidence | Orphan outcome | Status |
|---|---|---|---|---|
| auth.users → profiles | auth deletion | trigger/backfill only; delete cascade not proven | profile may remain or be removed | UNKNOWN |
| profiles → generations/comments | profile deletion/rename | author UUID/logical joins | content may remain with missing identity | UNKNOWN |
| generations → comments | soft/hard delete | parent validation function exists | child can remain under tombstone; FK action unknown | PARTIAL |
| comments → comments | parent delete | parent-generation function exists | child may survive under deleted parent | PARTIAL |
| generations → notifications | content delete | notification refs/triggers | dead notification target | VERIFIED risk |
| generations → reports | content delete | report target logical reference | report remains or loses target | UNKNOWN |
| generations → saves | content delete | legacy saves retained | stale save/count row | LEGACY risk |
| auth.users → workspace_state | account delete | account-scoped table; cascade unknown | private serialized orphan | UNKNOWN |
| admins → capabilities | admin revoke/delete | separate tables/RPCs | capability orphan possible | UNKNOWN |

## E. RPC contract matrix

| RPC/path | Caller | Core validation/auth | Mutation/result | Status |
|---|---|---|---|---|
| `feed_page` | community-data | public/RLS expected | paginated generations | live public read verified |
| `feed_since` | community poll | public/RLS expected | count/newness | live log verified |
| `thread_for` | detail | generation visibility/RLS expected | comments | production auth not verified |
| `create_generation` | composer/outbox | auth, parent/kind/visibility/text/rate/idempotency expected | generation row | repeated migration definitions; final live body UNKNOWN |
| `create_comment` | comment composer | auth, parent, text/rate/idempotency expected | comment row | final live body UNKNOWN |
| profile RPCs | profile/settings | auth.uid/validation/quota | profile row/result | source caller alignment verified; production policy UNKNOWN |
| `my_workspace_access` | access/app | JWT/access tables | grant state | debug showed 401 expired JWT |
| `save_workspace` | WSync | auth.uid/expected revision/payload | workspace rev | source path verified; live conflict unknown |
| notification RPCs | bell | recipient ownership | page/count/read | source verified |
| admin RPCs | admin UI | capability/owner/bootstrap | admin state | DB vs relay parity UNKNOWN |
| direct generation PATCH | lock/delete/restore | RLS ownership | row update | bypasses create RPC invariants by design; policy proof required |

## F. Permission matrix

| Operation | Anonymous | Waitlisted | Active | Admin without cap | Capability owner |
|---|---:|---:|---:|---:|---:|
| Public feed/detail | intended allow | intended allow | allow | allow | allow |
| Create post/comment | expected deny/conditional | conditional | allow | conditional | allow subject to same validation |
| Own profile update | deny | own only | own only | own only | own only |
| Own post/comment mutation | deny | conditional | own only | own only | explicit moderation only if defined |
| Workspace | deny/waitlist | deny | allow | capability/access dependent | allow |
| Admin read/write | deny | deny | deny absent cap | deny | cap-specific |
| Direct REST/RPC bypass | must deny | must deny | ownership/capability | capability | allow |

**Production proof missing:** every cell involving RLS, admin, waitlist, revoked identity, and direct forged IDs.

## G. State/reconciliation matrix

| Mutation | Optimistic change | Server operation | Timeout/401 | Commit/response lost | Duplicate | Current status |
|---|---|---|---|---|---|---|
| Profile/avatar | header/cards update immediately | profile RPC | rollback event/UI; error toast | refetch can reconcile | RPC quota/idempotency unknown | PARTIAL |
| Create post | pending card | create_generation | failed card | durable outbox removed in current Community direction; feed reread may recover | key in RPC | DATA integrity blocker |
| Comment/reply | pending comment | create_comment | failed row/draft behavior | no durable Community outbox | key expected | PARTIAL |
| Lock | local flag/card | direct PATCH | rollback | reread needed | direct PATCH idempotence likely | PARTIAL |
| Delete/restore | soft-delete/undo | direct PATCH/RPC | rollback | reread needed | mostly idempotent | PARTIAL |
| Workspace save | local cache immediately | save_workspace CAS | pending/cache remains | revision response/cache update | payload overwrite/CAS | DATA integrity blocker |
| Mark notification read | UI badge/list | RPC | stale badge possible | refetch | expected idempotent | PARTIAL |
| Admin grant/cap | UI pending | RPC/relay | button/retry path varies | duplicate safety unknown | capability/idempotency unknown | SECURITY blocker |

## H. Dead/legacy register

- `saves`: LEGACY/possible dead system; schema remains after UI removal.
- Earlier migration function bodies: LEGACY, not effective unless production stopped before later migration.
- `latestAvatars(handles)`: LEGACY/duplicate reader; current Community post/comment path uses immutable IDs, but exported function remains.
- Community local cache/outbox code: current source has no durable Community authority; unreachable/dead persistence branches may remain and need reference cleanup only after tests.
- Workspace local cache: ACTIVE intentional cache, not dead; must not be mistaken for DB authority.
- Service worker and standalone build: ACTIVE deployment artifacts, drift risk.
- Like/share/follow: no current durable entity/control proven; UNKNOWN only if external code/deployed asset differs.
- Purge RPCs: ACTIVE definitions, execution UNKNOWN.

## I. Production verification matrix

| Test | Executed | Evidence | Result |
|---|---:|---|---|
| Public feed RPC | Yes | live `feed_page` returned one row | PASS |
| Full UUID REST lookup | Yes | generation ID returned 200/data | PASS |
| Live profile by author UUID | Yes | avatar returned null | PASS |
| Authenticated create/update/delete/restore | No | no production user credentials in audit runtime | BLOCKED |
| RLS forged-ID tests | No | privileged/authenticated sessions unavailable | BLOCKED |
| Admin/capability matrix | No | no role credentials | BLOCKED |
| Workspace CAS/two-tab | No | browser automation/auth unavailable | BLOCKED |
| JWT expiry/refresh | Observed only | debug log had 401 expired JWT | FAIL/OPEN |
| Multiple GoTrue clients | Observed | debug warning | OPEN |
| Render deployed commit parity | No | deployment metadata unavailable | BLOCKED |
| Production catalog/jobs/realtime | No | privileged DB access unavailable | BLOCKED |

## J. Rate-limit and abuse-control audit

| Operation | Auth | Cost | Limit/source | Key | Concurrency | Payload/timeout | Idempotency | Status |
|---|---|---|---|---|---|---|---|---|
| OTP request/verify | mixed | email/auth | auth code/rate functions + relay controls | email/IP/session varies by path | UNKNOWN | expiry/attempt fields | ticket/code | PARTIAL |
| Generation create | auth | DB/AI/write | rate_counters/RPC checks | expected auth uid | DB transaction unknown | text checks | idempotency_keys | PARTIAL |
| Comment create | auth | DB/notify | rate_counters/RPC checks | expected auth uid | parent race unknown | body checks | idempotency_keys | PARTIAL |
| Profile update | auth | low DB | quota fields/RPC | auth uid | concurrent updates unknown | name/bio checks | not proven | PARTIAL |
| Report | auth | DB/admin | source RPC references; limit unclear | reporter/target expected | unknown | reason bound unknown | likely schema uniqueness | UNKNOWN |
| Workspace save | auth | serialized DB | CAS/payload limits source | auth uid/rev | CAS | size/timeout source partial | revision not idempotency | PARTIAL |
| Feed/thread reads | public/auth | DB | page limits in client/RPC expected | none | unknown | page limit 10/client | N/A | PARTIAL |
| Relay search/read/media | route-dependent | external/CPU/network | source-specific controls | session/control/IP varies | route-specific | size/time checks in Python | N/A | PARTIAL |
| Admin grants/resends | admin | email/DB | capability; operational rate limit unclear | admin/session | unknown | payload small | unknown | SECURITY/ABUSE blocker |
| Purges | service | DB | no scheduler proof | global | unknown | bounded function likely | N/A | UNKNOWN |

### Abuse scenarios requiring proof

1. Concurrent generation/comment requests can race rate counters or parent checks.
2. Alternating direct Supabase RPC and relay paths may bypass a per-route limiter.
3. In-memory relay limits can be bypassed across instances if deployed horizontally.
4. OTP requests can flood a victim email if limits are not independently keyed by IP and normalized email.
5. Remote read/media endpoints can amplify downstream cost even when destination validation succeeds.
6. Persisted idempotency/rate rows can grow without verified purge execution.
7. Admin grant/resend can generate repeated email/provider work if no operation limit exists.

## K. Final blocker list

| Blocker | Evidence | Exact failure | Data/users | Required decision | Verification | Status |
|---|---|---|---|---|---|---|
| P0/P1 Production contract unknown | no privileged catalog | live DB may not match migrations/RLS/RPCs | all private/community/admin data | obtain catalog dump | Supabase privileged query | OPEN |
| P0 Auth client race | debug multiple GoTrue clients + expired JWT | private read/write 401; optimistic UI disagrees | user/session/workspace | one auth authority or proven coordination | expiry/concurrent refresh test | OPEN |
| P1 RPC replacement drift | repeated migration replacements | caller parameter/return mismatch or old security body | all mutations | final pg_proc contract | catalog diff | OPEN |
| P1 Workspace cache/CAS | WSync local cache + DB state | stale tab overwrite/corruption/pending ambiguity | workspace state | conflict/version contract | two-tab/offline/crash matrix | OPEN |
| P1 Community response-loss | non-durable current outbox direction | committed row but UI pending/failed or lost relation | posts/comments | recovery policy | drop response after commit | OPEN |
| P1 Orphan lifecycle | FK/cascade/job/retention unknown | dead notification/report/save/comment references | content graph | cascade/retention decision | catalog + deletion tests | OPEN |
| P1 Admin dual authorization | relay + DB planes | allow/reject disagreement or privilege bypass | admin/grants/caps | single tested contract | direct endpoint/RPC role matrix | OPEN |
| P2 Duplicate identity sources | profile/local/workspace/cache history | avatars/names stale or inconsistent | all user identity surfaces | profile ID authority | change avatar all surfaces | OPEN |
| P2 Unverified limits | many functions/relay routes, no complete matrix | spam, email/resource exhaustion | DB/relay/providers | prove existing bounds | concurrent abuse tests | OPEN |
| P2 Purge execution unknown | purge functions, no scheduler | control tables/logs grow forever | auth/idempotency/rate | schedule/monitor | production jobs query | OPEN |
| P2 Deployment parity | standalone/SW/modular/migrations | stale frontend/backend contract | all users | release fingerprint/versioning | Render/SW/assets/catalog | OPEN |

## Closure decision

The audit is complete as an evidence pass but the system is **not closed**. Every unresolved item above remains explicitly marked. No new feature or shared backend refactor is safe until the P0/P1 blockers are verified or formally decided.
