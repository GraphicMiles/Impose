# Original D-01–D-25 Closure Matrix

| ID | Current status | Verified evidence | Root cause | Affected data | Affected flow | Required decision | Safe to modify? | Verification required |
|---|---|---|---|---|---|---|---|---|
| D-01 | LEGACY / PARTIAL | saves schema/index/trigger exists; no current save UI producer found | bookmark removal left schema | saves/counters | Community cards/data cleanup | retain/migrate/drop forward | No | live row count + code/RPC references |
| D-02 | VERIFIED risk | repeated create/profile/admin function replacements in migrations | migration evolution without generated final contract | all RPC callers | every DB mutation | publish final catalog contract | No | pg_proc signatures/bodies |
| D-03 | UNKNOWN | purge functions found | scheduler not found in repo | auth/idempotency/rate rows | cleanup | choose/verify scheduler | No | cron/job/log query |
| D-04 | UNKNOWN risk | soft-delete fields/functions found; universal retention absent | soft delete without retention contract | generations/comments/related rows | moderation/read/notifications | retention policy | No | catalog + data audit |
| D-05 | VERIFIED risk | workspace-sync cache, `workspace_state`, rev/CAS and save path | two authority layers | workspace payload | cross-device edits | define cache-only semantics/conflict UI | No | two-tab authenticated test |
| D-06 | VERIFIED | debug log reports multiple GoTrueClient instances | independent module clients same storage key | JWT/session | all private reads/writes | one auth-client owner or proven safe sharing | No | client creation trace/expiry test |
| D-07 | VERIFIED local change / deploy UNKNOWN | old cache path existed; current source disables Community durable persistence | browser cache was treated as feed source | posts/comments | feed/detail | confirm deployed revision | No | live asset/source fingerprint |
| D-08 | VERIFIED tradeoff | old persisted outbox; current source memory-only | offline durable retry conflicted with DB-only requirement | pending generation/comments | response-loss/offline | choose durability vs DB-only | No | commit/response-loss test |
| D-09 | VERIFIED historical duplicate | profiles.avatar, workspace settings, creator caches/fallbacks all existed | identity source drift | avatars/names | header/cards/comments | canonical profile ID source | No | profile change all surfaces |
| D-10 | VERIFIED live | live profile avatar is null | no configured DB avatar | user avatar | header/community | configure value or accept empty | Yes only data entry | profile update/read |
| D-11 | VERIFIED fixed locally | `slice(4)` caused UUID first-char loss; current source uses `slice(3)` | route prefix migration | generation IDs | deep links/detail | retain clean route tests | Yes after deploy proof | exact UUID live route |
| D-12 | VERIFIED risk | post/comment identity now ID-based; profile route handle-based | two identity addressing schemes | author/profile links | rename/profile | immutable profile route or redirect decision | No | rename test |
| D-13 | VERIFIED risk | updated_at triggers and polling/realtime paths | event delivery not guaranteed | rows/cards | updates | reconnect/focus refetch guarantee | No | disconnect test |
| D-14 | UNKNOWN | notification refs exist; cleanup cascade not proven | source deletion/reference lifecycle | notifications/reports | inbox/detail | retain tombstone or purge refs | No | FK/cascade + deleted target test |
| D-15 | VERIFIED risk | relay admin routes + DB capability RPCs | two auth planes | admin operations | admin UI/API | shared authorization contract | No | matrix with invalid sessions/caps |
| D-16 | VERIFIED | no audit-log table found in migrations | admin changes not append-only | admin actions | forensic review | decide audit requirement | Yes only decision | privileged table inventory |
| D-17 | UNKNOWN risk | workspace payload serialized without proven version migration | schema-light blob | workspace state | upgrades/import | version/migration contract | No | corrupt/old payload tests |
| D-18 | VERIFIED | debug JWT expired/relay timeout; handlers vary | auth/network failure not uniform | optimistic/server state | all mutations | common retry/re-auth contract | No | expired JWT per mutation |
| D-19 | VERIFIED | standalone build duplicates modules | release artifact duplication | frontend behavior | deployment | build gate/hash | Yes after pipeline proof | source/artifact hash |
| D-20 | VERIFIED risk | service worker + non-hashed assets | stale clients | frontend/RPC contract | all routes | cache revision strategy | No | old SW/new server test |
| D-21 | UNKNOWN | attachment UI; no durable upload entity verified | browser attachment vs storage lifecycle | files/media | chat/exports | storage ownership decision | No | storage/catalog/backend trace |
| D-22 | VERIFIED | no like/share/follow tables/current controls; remix/challenge/discuss exist | product language exceeds implementation | engagement | action buttons | do not build assumed features | Yes | source/catalog search |
| D-23 | PARTIAL | profile-updated event is same-tab; realtime profile event not proven | event scope | profile/avatar | multi-tab | cross-tab/live profile event | No | two-tab profile update |
| D-24 | VERIFIED risk | optimistic paths differ; reads/auth/reconcile differ | no common mutation lifecycle | all feature state | update/delete/write | enumerate rollback/reconcile states | No | commit-loss/rollback matrix |
| D-25 | CRITICAL UNKNOWN | only migration source/public RPC probes available | production catalog not privileged-verified | entire DB/security model | every backend flow | obtain catalog dump before changes | No | production schema/RLS/function dump |

## Closure rule

A row is not closed merely because source code exists. It is closed only when the live catalog/role matrix or an explicit product decision proves the stated behavior. Current statuses remain open for all rows marked UNKNOWN, PARTIAL, risk, or deploy-unknown.
