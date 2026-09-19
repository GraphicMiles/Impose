# A. Final Database Contract — Second-Pass Truth Audit

Date: 2026-09-19. Scope: migrations 0001–0022, current browser modules, Express server, relay references, tests, and unauthenticated live Supabase probes. This is an effective-contract map, not a recommendation to refactor.

## Evidence boundary

**VERIFIED FROM REPOSITORY:** ordered migration text, final textual replacement order, client call sites, RLS/policy/function/trigger declarations where present, and public live RPC responses. **UNKNOWN:** exact production catalog/function bodies/RLS until a privileged schema query is run. A migration file is not proof of production application.

## Final entity graph

```text
auth.users [Supabase-owned]
 ├─ profiles.id (1:1, trigger/backfill/ensure)
 ├─ waitlist.user_id / normalized email
 ├─ workspace_grants.user_id
 ├─ generations.author_id
 ├─ comments.author_id
 ├─ saves.user_id [legacy retained]
 ├─ notifications.recipient_id / actor_id
 ├─ reports.reporter_id / reviewer_id
 ├─ workspace_state.user_id
 ├─ admins.user_id
 ├─ admin_capabilities.user_id
 └─ admin_bootstrap.claimed_by

profiles
 ├─ generations.author_id → profile identity/name/avatar
 └─ comments.author_id → profile identity/name/avatar

generations
 ├─ generations.remix_of → generations.id
 ├─ generations.root_id → generations.id (trigger-derived lineage)
 ├─ comments.generation_id → generations.id
 ├─ saves.generation_id → generations.id [legacy]
 ├─ notifications.generation_id → generations.id
 ├─ reports.target_id/type → content
 └─ feed/profile/thread RPCs

comments
 ├─ comments.parent_id → comments.id
 ├─ comments.generation_id → generations.id
 ├─ notifications.comment_id → comments.id
 └─ reports.target_id/type → content

waitlist → workspace_grants → workspace mode
admins + admin_capabilities + admin_action_caps + admin_bootstrap → admin RPC/relay decisions
workspace_state → serialized Workspace payload → browser account cache → CAS save_workspace
```

## Durable entities and effective responsibilities

| Entity | Effective key/owner | Fields and semantics established by migrations | Derived/dependent data | Cleanup/retention evidence |
|---|---|---|---|---|
| `profiles` | `id = auth.users.id`; own profile writes | handle, display_name, bio, avatar, username quota fields; handle uniqueness and validation are migration/RPC controlled | generation/comment display identity | Trigger/backfill/ensure; no universal profile deletion path verified |
| `waitlist` | normalized email/user identity | status, position, created/approved/granted timestamps and email | workspace grant and notifications | unique position/index and RPC idempotency; purge unknown |
| `workspace_grants` | user_id | grant/status/timestamps | `my_workspace_access`, access gate | revoke/update path exists; retention unknown |
| `generations` | id; author_id | prompt/response, addressed/status/kind, visibility, locked, remix_of/root_id, timestamps, deleted_at, counters | feed/profile/thread, lineage notifications, comments | soft delete; no universal purge verified |
| `comments` | id; author_id | generation_id, parent_id, body, timestamps, deleted_at | comment count, thread, notifications | soft delete/restore RPC; no universal purge verified |
| `saves` | user_id + generation relationship | legacy Community bookmark relation and count trigger | no current UI producer found | retained after bookmark removal; cleanup unknown |
| `notifications` | recipient/content references | kind, actor, generation/comment references, read/dismiss timestamps | bell/count/inbox | trigger-created; source deletion cleanup not proven |
| `reports` | reporter/content target | reason/status/review fields | admin reports | resolution path; retention unknown |
| `workspace_state` | user_id, revision/CAS | serialized data, rev/timestamps | app/local cache and save_workspace | overwrite/conflict handler; schema version migration not proven |
| `auth_codes` | email/code identity | purpose, hash, expiry, attempts, consumed/user reference | auth flows | purge function exists; scheduler unknown |
| `auth_tickets` | hashed ticket | expiry/one-time redemption | reset/auth bridge | purge function/index; scheduler unknown |
| `idempotency_keys` | request key/user scope | response/result/created timestamp | generation/comment RPC retries | purge function; scheduler unknown |
| `rate_counters` | user/IP/window | hit/window values | write/auth rate limits | purge function; scheduler unknown |
| `admins` | user_id | admin membership/owner protections | admin authorization | admin removal path; audit history absent |
| `admin_capabilities` | user_id + capability | assignment | `require_cap`/UI sections/relay | revoke path; audit history absent |
| `admin_action_caps` | action/capability | capability mapping | authorization decisions | seed/config only; no lifecycle UI proven |
| `admin_caps` | capability catalog/assignment per final migration | capability metadata/assignment model | admin UI/RPC | exact final role is production-unknown due repeated migrations |
| `admin_bootstrap` | singleton/claim | one-time bootstrap state | owner claim flow | permanent claim; no audit log |

## Constraints, indexes, triggers, and function replacement

The migration text declares PK/FK/unique/check/default/index behavior for the above entities, including feed `(created_at desc,id)`, author, lineage, thread, parent, notification, report, waitlist, auth expiry, idempotency and rate indexes. The effective function is the last ordered `create or replace function` definition for a given signature; earlier bodies are **LEGACY**, not concurrent overloads, unless signatures differ. A privileged catalog dump is required to verify exact `pg_proc` signatures and final bodies.

Trigger families verified in source: root lineage, updated_at touch, comment/lineage/save recount, profile creation/backfill, comment/lineage notifications, and realtime replica identity setup. Cascades are not uniformly proven from the migration text; every FK must be catalog-queried for `confdeltype` before relying on deletion behavior.

## End-to-end mutation contracts

### Create generation

```text
composer → community.js sendGeneration
→ optimistic in-memory card
→ BotoData.queue/create_generation
→ Supabase session/auth.uid
→ RPC validation (kind, parent, visibility, spam/length/rate)
→ idempotency key
→ generations insert
→ root/lineage + recount/notification triggers
→ RPC row
→ optimistic ID replacement/server row reconciliation
```

Failure risks: commit/response loss is safe only if idempotency key is retained; the current DB-only Community direction removes durable browser outbox recovery. Expired JWT can leave an optimistic card failed/orphaned in memory.

### Create comment/reply

```text
comment composer → optimistic comment → create_comment RPC
→ auth.uid/parent-generation validation/rate/idempotency
→ comments insert → recount + notification trigger
→ server row → optimistic ID replacement/thread refresh
```

Parent deletion between read and write is rejected by the RPC; optimistic draft recovery is client-owned.

### Lock/update generation

```text
lock button → in-memory locked mutation → direct generations PATCH
→ RLS/ownership → updated_at trigger → response → card replacement/rollback
```

This is a direct REST update rather than the create RPC path; exact RLS and returned-row behavior require production proof.

### Delete/restore generation/comment

```text
More/delete → optimistic soft-delete → direct PATCH or soft_delete RPC
→ ownership/RLS → deleted_at mutation → feed/detail rerender or Undo
```

Related notifications/reports/saves and child references are not proven to cascade or be purged.

### Profile/avatar update

```text
General profile UI → customize_profile/update_my_profile RPC
→ auth.uid/validation/quota → profiles update
→ profile-updated browser event → immediate optimistic repaint
→ server profile re-read by author_id → reconciliation
```

The profile row is the canonical Community avatar source. Workspace local settings remain a separate source for Workspace identity unless the profile update succeeds and reconciles them.

### Workspace save

```text
Workspace mutation → app save → WSync local account cache
→ debounced/immediate save_workspace RPC → expected revision CAS
→ workspace_state update → rev response → cache rev update
```

Current checkout has immediate push scheduling, but JWT failures, stale revision handling, serialized payload versioning and cache adoption still require authenticated production proof.

## Reads, authority, cache, invalidation, failure

| Read | Authority | Fallback/cache | Invalidation | Failure dead end |
|---|---|---|---|---|
| Feed | `feed_page` RPC | current in-memory render only; prior Community local persistence was removed in current source | explicit reload/poll/realtime | failed RPC may leave empty/error state |
| Detail | generation REST + `thread_for` | in-memory current route | route/thread realtime | malformed IDs/JWT/network show missing/error |
| Avatar | `profiles.avatar` by immutable author_id | no generated fallback; empty slot when null | profile event + feed refresh | stale if realtime/poll fails |
| Profile | profile RPC by handle plus profile feed | in-memory current view | profile event/route refresh | handle rename can make old links diverge |
| Notifications | notification RPC | in-memory badge | realtime/refetch | source deletion target may be stale |
| Access | `my_workspace_access` | access.js browser grant cache | explicit refresh/session events | expired JWT/cache can show stale gate |
| Workspace | `workspace_state` | encrypted per-account local cache | revision comparison/pull | stale cache or corruption can win UI before pull |
| Auth | Supabase Auth session | auth-client/local session storage | GoTrue events/refresh | multiple clients can race refresh |
| Admin | DB capability RPCs and relay checks | no trusted client authority | explicit dashboard reads | relay/DB policy drift |

## Final authority statement

Supabase Postgres/Auth is authoritative for Community, profiles, access, notifications, reports, admin data, and workspace_state. Browser memory/localStorage/service-worker state is a cache or local-only product state, never proof of committed server state. Provider keys/chat history/settings remain intentionally browser-owned unless workspace sync writes them to workspace_state. The architecture therefore has two intentional data domains, not one universal DB.

## Remaining production contract unknowns

Exact final catalog definitions, production migration level, FK cascade actions, RLS policy predicates, grants, realtime publication membership, scheduler/cron execution, relay environment, and authenticated role results require privileged verification.
