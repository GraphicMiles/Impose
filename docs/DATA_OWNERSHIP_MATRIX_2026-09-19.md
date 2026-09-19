# B. Data Ownership Matrix — Second-Pass Audit

Legend: **DB** authoritative Supabase row/RPC; **AUTH** Supabase Auth; **LOCAL** browser-owned; **CACHE** non-authoritative copy; **UNKNOWN** production proof required.

| Data | Authoritative owner | Writers | Readers | Derived copies/cache | Delete owner | Recovery | Status |
|---|---|---|---|---|---|---|---|
| Auth identity/session | AUTH | Supabase/relay auth flows | auth-client, access, all private calls | browser auth session/GoTrue storage | Supabase sign-out/admin auth | refresh/sign-in | PARTIAL; duplicate clients/races observed |
| Profile handle/name/bio/avatar | DB `profiles` row keyed by auth uid | profile RPCs/triggers | community-data, app header, admin | in-memory cards/profile; prior caches | profile RPC/account lifecycle | reread by id | VERIFIED source in current code; production RLS UNKNOWN |
| Community generation | DB `generations` | create_generation RPC; direct lock/delete/restore paths | feed/detail/profile/thread | current in-memory card only in current source | owner/admin/RPC soft delete | restore RPC/Undo where supported | PARTIAL; final RLS/cascade UNKNOWN |
| Generation counts | DB derived columns/triggers/RPC | trigger paths | card/feed/profile | in-memory display | DB recount trigger | recount trigger/manual proof | DATA INTEGRITY risk until trigger coverage verified |
| Comment/reply | DB `comments` | create_comment/restore/delete RPCs | thread/profile/notifications | in-memory optimistic row | owner/RPC soft delete | restore with body | PARTIAL; response-loss/outbox semantics require proof |
| Legacy saves | DB `saves` | no current Community producer found | no current UI consumer found | stale counters possible | UNKNOWN | UNKNOWN | LEGACY/dead candidate |
| Notification | DB `notifications` | DB triggers/grant action | notification RPC/realtime | badge/list in memory | recipient read; source cleanup UNKNOWN | reread/mark read | PARTIAL |
| Report | DB `reports` | report RPC | admin reports | admin UI state | admin resolve; retention UNKNOWN | reread | PARTIAL |
| Waitlist | DB `waitlist` | join_waitlist/admin actions | access/admin | access.js grant cache | admin/database | refresh | PARTIAL; cache can stale |
| Workspace entitlement | DB `workspace_grants` | admin grant/revoke | my_workspace_access/access gate | grant cache | admin/RPC | refresh | PARTIAL |
| Workspace serialized state | DB `workspace_state` | save_workspace | WSync/app | encrypted account local cache, in-memory app | user reset/admin/data delete UNKNOWN | pull/revision conflict | DATA INTEGRITY risk |
| Workspace chats/providers/settings | LOCAL by default; DB workspace_state only when synced | app save/WSync | app | localStorage/cache/service worker | app/user local delete | import/export/cache | INTENTIONAL dual domain |
| Admin membership | DB `admins` | admin RPC/bootstrap | app admin + relay | session/UI flags | admin RPC | reread | PARTIAL; dual auth planes |
| Admin capabilities | DB capability tables/catalog | admin RPC/bootstrap | app/relay | UI capability snapshot | admin RPC | reread | PARTIAL |
| Idempotency | DB `idempotency_keys` | write RPCs | RPC internals | prior browser outbox was cache | purge function | server duplicate return | UNKNOWN scheduler |
| Rate counters | DB `rate_counters` | rate_hit functions | write RPCs | none | purge function | next window | UNKNOWN scheduler |
| Auth OTP/ticket | DB `auth_codes`/`auth_tickets` | relay/RPC | auth flows | sessionStorage pending fields | purge/consume | reissue | UNKNOWN scheduler |
| Provider keys | LOCAL encrypted browser state | app/settings | app/provider request | device key/passphrase/cache | user data delete | encrypted export | LOCAL by design |
| Service worker assets | CACHE | browser SW | browser | cache storage | SW version/clear | network reload | stale-contract risk |

## Ownership rules

1. A browser optimistic object is not a committed row.
2. A handle is an address, not an identity key; author/user UUID is the relationship key.
3. Profile avatar is owned by the profile row; Workspace settings may display a local copy but cannot be Community authority.
4. Derived counters are owned by database trigger/RPC logic, not client increments.
5. Access/admin decisions are owned by DB/RPC/relay checks, not cached UI booleans.
6. Browser-only chats/provider keys/settings are intentionally not equivalent to Community DB data.

## Contradictions requiring closure

- Profile/avatar: app header local settings versus Community DB profile; event reconciliation exists but cross-tab/expired-session proof is incomplete.
- Workspace: local encrypted cache can display before DB pull and can be overwritten by stale revision/conflict paths.
- Community: optimistic memory versus DB response; current source removed durable Community cache/outbox, which makes response-loss recovery incomplete.
- Auth: Supabase client instances can share storage key and race refresh.
- Admin: browser capability rendering, DB RPC capability checks, and relay checks are separate snapshots.
