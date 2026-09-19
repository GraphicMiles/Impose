# Forensic Data and Backend Architecture Map

**Forensic scope:** repository source, ordered Supabase migrations `0001`–`0022`, frontend data modules, Express deployment, backend relay references, tests, and the live public Supabase feed/profile response.

**Evidence rule:** VERIFIED means directly observed; PARTIAL means source path exists but production execution was unavailable; UNKNOWN means it cannot be established from this checkout. No schema or production data was changed during this mapping pass.

> This report supersedes the older inventory below by adding the current ordered migration inventory, live-row evidence, and explicit dead-end/inconsistency register.

## Current live evidence captured

- Live feed RPC returned one generation: `e817f9b4-4359-4249-9695-741e31552bf6`.
- Its author is `955f8cbc-f53f-4ce9-9989-ff73bdd55afa` / `rfarouq69`.
- Live profile lookup by that immutable user ID returned `avatar: null`; no non-null avatar can be proven for that account.
- The public feed and direct generation REST lookup both accepted the complete UUID.
- The previously observed UUID truncation was a client clean-route bug (`slice(4)` retained from `#/g/` after migration to `/g/`; clean `/g/` requires `slice(3)`).
- `/workspace-sync.js` is explicitly served by Express.

## Ordered database object inventory

The migration set defines or revises these durable objects. Repeated function names are replacement definitions; the last ordered definition is the effective contract.

### Tables

`profiles`, `waitlist`, `workspace_grants`, `generations`, `comments`, `saves` (legacy schema retained after Community bookmark UI removal), `auth_codes`, `auth_tickets`, `idempotency_keys`, `rate_counters`, `notifications`, `reports`, `workspace_state`, `admins`, `admin_capabilities`, `admin_action_caps`, `admin_caps`, and `admin_bootstrap`; Supabase-managed `auth.users` is external to the migrations but is referenced by foreign keys/triggers.

### Indexes

`waitlist_status_created_idx`; `workspace_grants_granted_at_idx`; `generations_feed_idx`, `generations_author_idx`, `generations_remix_idx`, `generations_root_idx`; `comments_thread_idx`, `comments_parent_idx`; `saves_generation_idx`; `auth_codes_expiry_idx`; `auth_tickets_expiry_idx`; `idempotency_created_idx`; `rate_counters_window_idx`; `notifications_unread_idx`, `notifications_inbox_idx`; `reports_pending_idx`; and `waitlist_position_key`. Partial indexes are used for non-null lineage/parent rows. Exact production presence is UNKNOWN until migration status is queried with a privileged schema connection.

### Triggers and derived mutation paths

- `on_auth_user_created` creates/ensures a profile.
- `generations_set_root` derives root lineage.
- `generations_touch` and `comments_touch` derive `updated_at`.
- `comments_recount`, `generations_recount_lineage`, and `saves_recount` derive engagement counters.
- `comments_notify` and `generations_notify` derive notifications.
- Profile backfill/ensure functions create missing profile rows.

### Scheduled/purge mechanisms

Purge functions exist for expired auth codes, idempotency keys, and rate counters. A verified scheduler/cron invoking them was not found. Therefore expiry cleanup is defined but operational execution is UNKNOWN. Soft-deleted generations/comments and notifications/reports are not shown to have a universal retention purge.

## Effective data-flow dependency map

```text
auth.users
  └─ profile trigger/backfill → profiles
       ├─ avatar/name/handle → community cards/comments/profile pages
       ├─ waitlist/access identity → waitlist → workspace_grants
       ├─ admin identity → admins → admin_caps/action_caps/bootstrap
       └─ author/recipient/reporter ownership

generations(author_id)
  ├─ root/remix lineage → generations
  ├─ comments(generation_id,parent_id)
  ├─ legacy saves(generation_id,user_id)
  ├─ notifications(triggers)
  ├─ reports(target)
  └─ feed/profile/thread RPCs

comments(author_id,generation_id,parent_id)
  ├─ thread RPC + soft delete/restore
  ├─ comment/reply notifications
  └─ derived generation comment count

workspace_state(user_id)
  └─ serialized workspace payload → browser cache → app state → save_workspace CAS write

Browser-only app state
  └─ chats/providers/prompts/memory/usage/settings → local account cache or provider network
\Relay
  └─ auth/admin/mail/search/media/read/provider bridges → Supabase/service role/external providers
```

## Explicit inconsistency and dead-end register

| ID | Finding | Severity | Evidence / consequence |
|---|---|---:|---|
| D-01 | Community `saves` table remains after bookmark UI removal | Medium | Schema/data surface is retained with recount trigger/index but no current Community save path; rows can become unreachable. |
| D-02 | Migration history repeatedly replaces core RPCs | High | `create_generation`, `create_comment`, `handle_new_user`, profile functions, and others have multiple definitions; source files cannot prove production is at the final revision. |
| D-03 | Purge functions have no verified scheduler | High | Expired codes/idempotency/rate rows can accumulate indefinitely. |
| D-04 | Soft-deleted records have no universal retention path | Medium | Generations/comments/notifications/reports may remain permanently; references remain in notifications/reports/workspace payloads. |
| D-05 | Workspace uses local cache plus DB `workspace_state` | High | Cache, pending debounce, CAS revision, and server data are multiple state authorities; stale-tab and expired-JWT paths can terminate without visible reconciliation. |
| D-06 | Client uses multiple Supabase clients | High | Auth warning confirms multiple GoTrue clients with the same storage key; concurrent refresh can produce JWT races/401s. |
| D-07 | Community feed previously hydrated browser cache | High | Legacy posts/comments could be stale or orphaned; current code is being changed to DB-only but deployed parity must be verified. |
| D-08 | Community outbox previously persisted writes locally | High | A queued write could outlive UI callbacks and remain “Sending”; current DB-only direction removes durable outbox but loses offline resume semantics. |
| D-09 | Profile/avatar has multiple historical sources | High | `profiles.avatar`, workspace account settings, cached generation creator objects, and generated handle fallbacks have existed; avatar changes can diverge across surfaces. |
| D-10 | Live profile avatar is null | Medium | Current live `profiles` row has no configured avatar; any visible non-empty avatar is necessarily a fallback/local source, not live profile data. |
| D-11 | Clean route parser had prefix-length regression | High | Valid UUID lost its first character and generated Supabase `22P02`; fixed locally, deployed parity must be checked. |
| D-12 | Feed/thread data and profile/avatar data use different resolution paths | Medium | Posts now resolve by author ID; profile pages resolve by handle RPC; rename/delete and stale handles can diverge. |
| D-13 | `updated_at` is derived for generations/comments but reads are mostly page/poll/realtime driven | Medium | A committed change may not repaint if realtime disconnects and polling fails. |
| D-14 | Notification references can outlive source content | Medium | Deleted posts/comments can leave inbox rows with dead destinations unless cleanup or missing-target handling is guaranteed. |
| D-15 | Admin has two authorization planes | High | Relay capability checks and Supabase admin RPC/RLS checks can drift; every action needs both-path tests. |
| D-16 | No immutable admin audit log table verified | Medium | Admin grants, revocations, report resolutions, and bootstrap actions may be difficult to reconstruct. |
| D-17 | Workspace payload is serialized and schema-light | High | Missing/renamed fields, oversized data, corrupted JSON, and incompatible versions can make a user state unreachable without migration. |
| D-18 | Auth/session expiry can terminate reads/writes without a guaranteed UI retry | High | Debug log showed JWT expired and relay timeout; current code has several failure-swallowing paths. |
| D-19 | Static standalone build duplicates modular source | Medium | `impose-standalone.html` can drift from `index.html` modules and deployed behavior. |
| D-20 | Service worker/cache can preserve old frontend/backend contracts | Medium | Non-hashed assets and a service worker make revision parity an operational concern. |
| D-21 | No verified durable upload/object lifecycle | Medium | Attachment UI can create browser-only references with no confirmed storage ownership/cleanup. |
| D-22 | Likes/follows/share are not durable implemented entities | Medium | Current UI has Remix/Challenge/Discuss/Lock/More; do not infer like/share behavior from requested product language. |
| D-23 | Profile cache invalidation is event-driven only within one tab | Medium | Cross-tab profile changes need realtime/storage/session event coverage; otherwise another tab waits for poll/reload. |
| D-24 | Optimistic UI and authoritative DB reconciliation are uneven | High | Some actions mutate in memory first; reads/profile/avatar and workspace sync can wait on auth/network; rollback coverage differs by feature. |
| D-25 | RLS/RPC final production state is unverified | Critical | Repository migrations are not proof that the live Supabase project has the same policies, triggers, indexes, or function bodies. |

## Unresolved proof requirements before development

1. Query the live Supabase catalog with a privileged connection and record final columns, types, defaults, constraints, indexes, triggers, RLS policies, publications, and function definitions.
2. Run authenticated tests for owner, active user, waitlisted user, anonymous user, revoked user, admin without capability, and capability owner.
3. Trace every mutation with network logs from pointer action through DB response, trigger, notification, and UI repaint.
4. Test expired JWT, refresh race, duplicate Supabase clients, offline/reconnect, two tabs, stale workspace revision, and server-commit/response-loss.
5. Verify purge invocation and retention policies.
6. Decide whether legacy `saves` is intentionally retained, migrated, or dropped in a new forward migration.
7. Establish one canonical avatar source and one canonical profile identity key.
8. Establish one canonical durable state owner per feature; explicitly classify browser cache as cache, never authority.
9. Verify Render’s deployed commit, asset set, service-worker revision, and applied migration revision.
10. Do not begin new feature development until D-02, D-05, D-06, D-15, D-18, D-24, and D-25 are closed.

---

# Impose: Complete Platform Inventory & Adjustment Readiness Audit

**Audit date:** 2026-09-19 (Africa/Lagos)  
**Repository:** `GraphicMiles/Impose`, branch `main`, inspected checkout `566d463`  
**Scope:** source tree, migrations, tests, deployment configuration, and live application at `https://impose-web.onrender.com/`  
**Change policy:** no application source was modified. This report is the only deliverable created during this pass.

## Evidence legend

- **VERIFIED**: directly observed in source, configuration, test, or live response.
- **PARTIALLY VERIFIED**: code path is present, but external infrastructure or a complete live flow could not be exercised.
- **INFERRED**: conclusion from naming, documentation, or unexecuted branches.
- **UNKNOWN**: not determinable from this checkout or unauthenticated production access.

---

## 1. Executive Inventory

Impose is two products sharing one static document:

1. A browser-first BYOK AI chat client with demo replies, provider configuration, streaming, chat history, search, attachments, prompt library, usage, encrypted export, retention, memory, PII redaction, voice input, and local settings.
2. A community/workspace product layered into the same page. Community exposes a public feed of “generations”, comments/replies, remix/lineage, profiles, notifications, reports, waitlist access, and an admin console.

The frontend is mostly vanilla HTML/CSS/JavaScript, not a framework application. `index.html` is the shell; `app.js`, `community.js`, `auth-client.js`, `access.js`, `workspace-sync.js`, and related modules attach behavior. `impose-standalone.html` is a large bundled/inlined copy. The backend is optional for the original chat client but required for community/auth and relay-backed retrieval. Supabase is the authoritative application database/auth platform for community data. A Python FastAPI relay supplies authentication adjuncts, search, source reading, media/file discovery, provider proxying, OTP/password flows, and admin bridge operations. A separate FastAPI Lightning gateway proxies a local llama server.

### High-confidence implementation status

| Area | Status | Evidence summary |
|---|---|---|
| Static web shell and chat UI | **PARTIAL/IMPLEMENTED** | Extensive controls and handlers exist; provider/demo paths are implemented. |
| Direct BYOK providers | **IMPLEMENTED, externally unverified** | Provider presets, model listing/probing, request shapes, key storage and calls exist. |
| Demo mode | **IMPLEMENTED** | Default live page shows demo replies. |
| Community feed | **PARTIAL** | UI, Supabase RPCs, notifications and tests exist; live unauthenticated page reports feed load failure. |
| Auth | **PARTIAL** | UI and relay OTP/password endpoints exist; full Supabase/relay production configuration is unknown. |
| Waitlist/access | **IMPLEMENTED in code, live outcome unverified** | RPCs and `access.js` exist. |
| Admin console | **IMPLEMENTED with capability model** | Same document, `/admin` rewrite, server/database checks. Unauthenticated live page correctly shows sign-in state. |
| Relay retrieval/media | **IMPLEMENTED, provider-dependent** | Search/image/video/file/read modules and route handlers exist. |
| Lightning model gateway | **IMPLEMENTED, infrastructure-dependent** | Authenticated proxy and watchdog exist. |
| Notifications | **IMPLEMENTED in migrations/UI** | DB triggers/RPCs and notification controls exist; live authenticated verification unavailable. |
| Uploads | **PARTIAL** | Browser file attachment exists; no durable application upload table/storage path was verified. Relay can retrieve remote files. |
| Production parity | **PARTIAL/UNKNOWN** | Live page is served and matches the shell, but authenticated backend/database state and deployed asset revision cannot be fully compared without credentials. |

The main adjustment risk is not a single monolith; it is the coupling of one large browser state machine to local storage, Supabase RPC contracts, relay routes, and an evolving sequence of migrations. The latest migration files override earlier definitions, so the database cannot be understood from `0001` alone.

---

## 2. Application Architecture

### Frontend

- **Runtime:** browser JavaScript, no package manifest or framework build was found.
- **Shell:** `index.html`; public/legal pages are separate static HTML files.
- **Core chat:** `app.js` (~9,321 lines), `styles.css`, `ui-core.js`, `debug-bus.js`, `avatars.js`, `config.js`.
- **Community:** `community.js`, `community.css`, `community-data.js`, community markup in `index.html`.
- **Authentication:** `auth.html`, `auth.css`, `auth.js`, `auth-client.js`.
- **Access gate:** `access.js`.
- **Workspace persistence/synchronization:** `workspace-sync.js`.
- **Agent/audit tooling:** `agent/*`, `audit/*`; these are not the primary user runtime but contain substantial alternate feature/test logic.
- **Libraries:** vendored `lucide.min.js`, `anime.min.js`, `supabase.min.js`; service worker `sw.js`.
- **Portable build:** `impose-standalone.html`, regenerated by `build_inline.py`. It is a potential duplication/drift surface.

### Backend

**Relay (`backend/relay/server.py`)** is FastAPI/uvicorn. It exposes health, model/chat/search proxies, source intelligence, images, videos, files, remote file retrieval, OTP/password flows, generic fetch, page reading, and admin routes. Supporting modules include provider catalog, search parsers, image/video/media adapters, mailer, OTP store, Supabase service-role bridge, reports store, and source intelligence.

**Lightning gateway (`backend/lightning/server.py`)** is FastAPI/uvicorn. It authenticates a control key, proxies `/v1/models` and `/v1/chat/completions` to a local llama-server, proxies search, and manages model startup/idle reaping. Its intended upstream is `127.0.0.1:8080`.

### Database/authentication

Supabase provides Postgres, Auth, REST/RPC exposure, RLS, and realtime publication. Twenty migrations are present. Auth is partly native Supabase session-based and partly relay-mediated OTP/password orchestration. The relay uses a service key for privileged account creation/confirmation/password operations; the browser uses Supabase URL/anon-style access for public RPCs and session-bound calls. Exact production keys and deployed migration level are **UNKNOWN**.

### Deployment/build

`render.yaml` defines:

- `impose-web`: static Render site, copies a selected file list into `dist`, rewrites extensionless routes, and sets CSP/cache/security headers.
- `impose-relay`: Python Render web service rooted at `backend`, running `uvicorn relay.server:app`.

GitHub Actions run regression and migration workflows. `supabase/apply.sh` applies migrations using a configured Supabase URL/key. No container, npm, lockfile, or conventional frontend test/build pipeline was found.

### External integrations

- Supabase REST/RPC/Auth/realtime.
- Render static hosting and relay hosting.
- Cloudflare Web Analytics beacon in `index.html`.
- Configurable AI providers: OpenAI-compatible, Anthropic, Gemini, Groq, OpenRouter, arbitrary endpoints.
- Optional relay search providers: DuckDuckGo, Wikipedia, Bing/Yahoo/SearxNG paths, Tavily, Brave, Serper depending on environment.
- Openverse, Wikimedia, Iconify/simple-icons and image sources.
- YouTube/Twitch discovery and verification adapters.
- Sendlib mail delivery.
- Lightning AI API and local llama-server.

### Missing/unclear infrastructure

No durable job queue, cron worker, object-storage upload subsystem, subscription/billing integration, or observability platform beyond browser debug tooling, health endpoints, and Cloudflare beacon was verified. `render.yaml` explicitly disables wake/idle features by default.

---

## 3. Route Inventory

### Browser routes

| Route | Purpose | Access | Data/actions |
|---|---|---|---|
| `/` | Main community/workspace/chat shell | Public shell; workspace access is gated | Local chat state; community Supabase reads/writes; auth/access checks |
| `/admin`, `/admin/` | Admin mode of the same shell | Publicly discoverable shell, but actions re-check session capabilities | Admin waitlist/roster/reports/grants/capabilities |
| `/sign-in`, `/sign-up` | Auth mode in `auth.html` | Public | OTP/password auth calls |
| `/forgot-password` | Password reset request | Public | Relay OTP/reset calls |
| `/otp` | OTP verification | Public | Code verification/session ticket flow |
| `/reset-password` | Password reset completion | Public with valid ticket | Password update |
| `/about`, `/privacy`, `/terms`, `/data-security`, `/contact`, `/acceptable-use` | Legal/informational pages | Public | Mostly static |
| `404`/fallback | Branded not-found page | Public | Navigation only |

Render rewrites these paths. Any other path is rewritten to `404.html`; this means client-side deep links not listed in `render.yaml` are not expected to work.

### Backend routes (relay)

Verified from `backend/relay/server.py`: `GET /health`; `GET /v1/models`; `POST /v1/chat/completions`; `GET /v1/source/catalog`; `GET/POST /v1/search`; `GET /v1/image-convert`; `GET/POST /v1/images`; `GET/POST /v1/videos`; `GET/POST /v1/files`; `POST /v1/file`; `POST /v1/auth/otp/request`; `POST /v1/auth/otp/verify`; `POST /v1/auth/password/reset`; `POST /v1/fetch`; `POST /v1/read`; `GET /admin/accounts`; `GET /admin/reports`; `GET /admin/waitlist`; `POST /admin/grant`; `POST /notify/grant`; `GET /admin/status`; `POST /admin/wake-llm`.

All relay routes requiring control/session authorization should be treated as authenticated; `/health` is open. Exact per-route auth and capability requirements are documented in code and tests, not a single central schema. `GET /v1/image-convert` uses a signed source mechanism and is an artifact endpoint rather than a general open converter.

### Backend routes (Lightning)

`GET /health` is open. `GET /v1/models`, `POST /v1/chat/completions`, `GET/POST /v1/search`, `GET /admin/status`, and `POST /admin/start-llm` are control-key protected. Chat supports SSE proxying when upstream streams.

### Route-state notes

Loading, empty, retry, signed-out, denied, bootstrap, and no-capability admin states are explicitly represented in markup. The public live response showed both a feed error/retry surface and an unauthenticated admin sign-in surface. A complete authenticated route matrix is **PARTIALLY VERIFIED** because no production user session was available.

---

## 4. Feature Inventory

| Feature | Entry point | Reads | Writes | Status / findings |
|---|---|---|---|---|
| Demo chat | Composer, model menu | Local chats/settings | Local chat messages | **IMPLEMENTED**; live default is demo. |
| BYOK provider management | Settings > Providers/onboarding | Local encrypted provider records; provider `/models` | Local storage; network probes | **IMPLEMENTED, external-dependent**. Keys are intended to remain browser-local. |
| Streaming generation | Send button | Provider/relay response | Local message state, usage | **IMPLEMENTED**; timeout/partial stream behavior needs live verification. |
| Chat history | Sidebar | Local storage | Create/rename/pin/folder/delete/duplicate | **IMPLEMENTED**; browser-only, not Supabase chat history. |
| Search chats | Cmd/Ctrl-K/sidebar | Local chats | Search UI state | **IMPLEMENTED**. |
| Command palette/shortcuts | Palette and keyboard | Local UI state | Navigation/actions | **IMPLEMENTED**. |
| Prompt library | Settings > Prompts and `/` | Local prompt records | Local prompt records | **IMPLEMENTED**. |
| Usage/cost | Settings > Usage | Local generation statistics | Local counters | **IMPLEMENTED**; price estimates depend on user input. |
| Data import/export | Settings > Data | Local state | JSON export/import; encrypted backup | **IMPLEMENTED**; import validation and oversized files should be regression-tested. |
| Retention/delete | Settings > Data | Local chats | Local deletion | **IMPLEMENTED**; destructive action is hold-to-delete. |
| Memory/PII/follow-ups/auto-name | Settings > General | Local settings/chats | Local settings | **IMPLEMENTED/PARTIAL**; feature interactions are coupled to generation prompts. |
| Attachments | Composer file picker | Browser files | Message attachment state | **PARTIAL**; no verified durable upload backend. |
| Voice input | Mic button | Browser speech API | Composer text | **PARTIAL, browser-dependent**. |
| Web search | Tools and agent logic | Relay/gateway search | Message evidence/citations | **IMPLEMENTED, provider-dependent**. |
| Image/video/file/source retrieval | Agent tools and relay | Relay providers | Message cards/evidence | **IMPLEMENTED in code; external provider success unverified**. |
| Community feed | Community mode | Supabase feed RPC | Supabase generations | **PARTIAL**; unauthenticated production currently showed feed failure. |
| Generation/post | Community composer `@bot` | Access/session/profile | `create_generation` RPC | **PARTIAL/IMPLEMENTED in migrations**, needs authenticated live confirmation. |
| Comments/replies | Detail/feed cards | `thread_for`/comment reads | `create_comment`, edit/delete RPC/RLS | **IMPLEMENTED in code**. |
| Remix/lineage | Remix context/actions | Generation lineage | New generation with root/remix fields | **IMPLEMENTED in schema/UI**, edge behavior needs verification. |
| Saves | Card actions | Own saves | Insert/delete saves | **IMPLEMENTED in schema; UI connection needs confirmation.** |
| Profiles | Profile surface | `profile_by_handle`, profile feed | Profile RPC | **IMPLEMENTED/PARTIAL**. |
| Notifications | Bell/dot/inbox | Notification RPCs/realtime | Mark read/dismiss | **IMPLEMENTED in migrations/UI; production delivery unknown.** |
| Reports | Content action/admin reports | Reports | `report_content`, admin resolve | **IMPLEMENTED**. |
| Waitlist | Workspace gate | `my_workspace_access` | `join_waitlist` | **IMPLEMENTED in code; live grant state unavailable.** |
| Admin | `/admin` | Capability and admin RPCs/relay | Grants, roster, caps, reports | **IMPLEMENTED; live unauthenticated boundary verified.** |
| Workspace sync | Workspace mode | `workspace_state` | `save_workspace` | **IMPLEMENTED/PARTIAL**; conflict semantics are not fully clear. |
| Service worker/PWA | `sw.js`, manifest | Cached static assets | Cache state | **IMPLEMENTED**; offline data/network behavior requires device testing. |

---

## 5. Component Inventory

### Navigation and shells

Sidebar chat history, desktop/mobile collapse controls, top model bar, community/workspace mode bar, account avatar menus, notification button, admin header, back-to-community link, legal page links.

### Chat components

Empty state, message list, composer, attachment picker/preview, send/stop controls, token estimate, mic control, model menu, chat parameters, generation banners, scroll-to-latest, search, command palette, folder/move UI, share/export/duplicate/delete actions, tool cards, citations, markdown/media renderers, toast/debug surfaces.

### Community components

Feed list, new-posts pill, pull-to-refresh, infinite-scroll sentinel, feed loader/end/error/empty states, generation cards, comments/detail view, profile view, remix context, public/private visibility toggle, composer, report action, avatar stacks, notifications indicator.

### Settings/onboarding

Onboarding dialog, Settings modal with General/Providers/Prompts/Usage/Data tabs, provider wizard, provider probe/model selector, relay status/wake control, memory list, toggles, import/export, passphrase lock/unlock, retention selector, hold-to-delete.

### Auth/access

Email/password/OTP forms, verification and reset states, waitlist form, workspace private-beta gate, sign-in redirect-back handling, signed-out and denied admin states.

### Admin

Booting, signed out, denied, bootstrap claim, no-capability, waitlist table, approved users, roster, capability editor, reports table, grant/resend operations, sign-out.

For every component above, visibility is primarily controlled by mode/session/access/capabilities in the client, but authoritative community/admin writes are intended to be protected by Supabase RLS/RPC or relay checks. Client hiding alone must not be treated as authorization.

---

## 6. Data Model Inventory

### Supabase entities

| Entity | Purpose / key fields | Ownership and security |
|---|---|---|
| `profiles` | User profile, handle/display name/bio/avatar-related data | Public reads; own updates through controlled RPC/RLS. |
| `waitlist` | Email, status, position/timestamps | Public join via RPC; admin reads/grants. |
| `workspace_grants` | Active workspace entitlement/user/grant timestamps | User access check; admin grant path. |
| `generations` | Community posts/AI generations, author, body, public visibility, counts, root/remix lineage, timestamps, soft-delete fields | Public readable generations; author writes/deletes under policies/RPC. |
| `comments` | Threaded comments/replies, generation/parent/author/body, soft-delete/count fields | Visibility follows generation; author edit/delete; parent-generation consistency checked. |
| `saves` | User-to-generation saved relation | Own rows only. |
| `notifications` | Recipient, kind, related IDs/payload, read/dismiss timestamps | Own read/dismiss. Triggered by comments/lineage. |
| `reports` | Reporter/content/reason/status/review metadata | User submit; admin/operator review/resolve. |
| `workspace_state` | Per-user serialized workspace state | Own select/insert/update/delete, controlled `save_workspace`. |
| `auth_codes` | Hashed OTP/reset codes, purpose, expiry/attempt/consumed metadata | Server/RPC only; RLS enabled. |
| `auth_tickets` | Short-lived reset/session tickets | Server/RPC only; one-time redemption. |
| `idempotency_keys` | Request de-duplication for write RPCs | Own keys; server checks. |
| `rate_counters` | Windowed write/API rate limiting | Server functions; RLS enabled. |
| `admins` | Admin membership and protected owner behavior | Capability/admin functions, not client direct manipulation. |
| `admin_capabilities` | User-to-capability assignments | Capability-controlled access. |
| `admin_action_caps` | Action/capability mapping | Server policy model. |
| `admin_caps` | Canonical capability records/possibly assignments depending on migration revision | Latest migration must be authoritative. |
| `admin_bootstrap` | One-time owner claim state/note | Bootstrap RPC; permanent close behavior. |

Supabase Auth’s `auth.users` is also used, though it is managed by Supabase rather than these migrations. Triggers create/backfill profiles and coordinate waitlist/grants.

### Local/browser data

Provider records and sealed keys, current chats/messages, folders, prompt library, usage counters, memory, general settings, theme/UI preferences, retention rules, device key/passphrase metadata, imported/exported chat data, workspace sync payload/cache, and service-worker cache. Exact key names are implementation details in `app.js`/`workspace-sync.js`; this data is user-controlled and can be deleted or corrupted outside backend validation.

### Relay/transient data

OTP storage delegates hashed data to Supabase RPCs; in-process rate/auth-failure and idle-monitor state exists in Python. No durable relay-owned business database was verified. Provider catalog is a static JSON file.

### Lifecycle / orphan risks

Soft deletes and recount triggers exist for generations/comments/saves/lineage. Related notification payloads, reports, workspace serialized references, browser-local messages, and external media URLs can outlive their source. Migration code addresses some count/lineage cases, but complete cascade behavior across all entities and deployed schema is **PARTIALLY VERIFIED**.

---

## 7. Read/Write Map

| Feature | UI read/write | API/database path | Auth/validation | Main risk |
|---|---|---|---|---|
| Direct chat | Local read/write; provider network write | Direct provider or relay `/v1/chat/completions`; no platform DB | Provider key and endpoint validation in browser; relay/control key where used | Browser key exposure to selected provider is intentional; arbitrary endpoint trust is user-controlled. |
| Provider discovery | UI reads model list/probe | Direct provider `/models` or relay `/v1/models` | URL/scheme and request-shape checks | CORS/provider incompatibility; sensitive headers must not leak. |
| Workspace access | UI reads grant | Supabase `my_workspace_access`; `join_waitlist` write | Session/RPC validation; email normalization | Client cache can become stale; server must remain authority. |
| Feed | UI reads pages/new posts | `feed_page`, `feed_since` | Public read/RLS | Live page showed load error; cause unknown. |
| Generation | Composer writes | `create_generation` latest RPC | `auth.uid`, limits, spam/text validation, rate hit, idempotency | Contract drift across 0004/0006/0007/0011/0012/0013/0014. |
| Comments | UI reads/writes | `thread_for`, `create_comment`, RLS | Parent-generation check, spam/rate/idempotency | Halfway failures/count/notification consistency. |
| Profiles | UI reads/writes | `profile_by_handle`, profile feed, `customize_profile`/`update_my_profile` | Own-user checks and sanitization | Older/newer profile RPC naming drift. |
| Notifications | UI reads/marks | notification RPCs/triggers/realtime | Recipient ownership | Missing trigger or stale related IDs. |
| Reports | UI submits | `report_content`; admin resolve | authenticated reporter/admin capability | Abuse and report spam depend on DB limits. |
| Admin | UI reads/writes | Relay admin routes plus Supabase admin RPCs | session verification + `session_can`/`require_cap`/`require_admin` | Two authorization planes must stay aligned. |
| Files/read/search/media | UI writes request/read results | Relay `/v1/*` | Control key, public-host/IP guards, size/time caps | SSRF/provider availability/large result abuse. |
| Workspace state | UI serializes state | `save_workspace` / `workspace_state` | Own user RLS, payload limits | Last-write-wins/conflict and stale-tab overwrites. |

There are intentional client-side writes for local-only chat/product preferences. Community and admin writes are designed to be server-side/RPC-authoritative. Direct database access from the browser is through Supabase REST/RPC with anon/session credentials; privileged relay operations use service-role server-side code.

---

## 8. Permission Matrix

This matrix reflects code policy, not guessed product intent. “Conditional” means the route/surface is visible but the operation must satisfy a further server check.

| Resource/action | Anonymous | Authenticated, waitlisted | Active/granted user | Admin/capability holder |
|---|---:|---:|---:|---:|
| Public static pages | Allow | Allow | Allow | Allow |
| Demo/direct local chat | Allow | Allow | Allow | Allow |
| Public community feed read | Intended allow | Allow | Allow | Allow |
| Join waitlist | Allow via RPC | Allow/idempotent | Allow | Allow |
| Workspace chat/history | Local UI allow; platform workspace gate | Deny/waitlist gate | Allow | Allow |
| Create generation/post | Deny unless authenticated/access rule permits | Likely denied until active; verify latest RPC | Allow subject to validation/rate limits | Allow subject to same or admin path |
| Comment/reply | Auth/access/RLS conditional | Conditional | Allow subject to validation/rate limits | Conditional |
| Read public generation/comment | Allow if public | Allow | Allow | Allow |
| Edit/delete own generation/comment | Deny | Own only if permitted | Own only | Own plus any explicit admin moderation capability; no blanket assumption |
| Save own generation | Deny | Conditional | Allow | Allow |
| Notifications | Deny | Own only | Own only | Own only |
| Submit report | Deny or auth-required per RPC | Conditional | Allow | Allow |
| Admin console shell | Public shell | Public shell | Public shell | Public shell |
| Admin data/actions | Deny | Deny without capability | Deny without capability | Capability-specific allow |
| Bootstrap ownership | Deny | Only seeded eligible account | Only eligible account | Owner/bootstrap rules |
| Grant workspace | Deny | Deny | Deny absent capability | Grant capability required |
| Add/remove admin/capabilities | Deny | Deny | Deny absent owner/admin capability | Owner/capability required |
| Relay health | Allow | Allow | Allow | Allow |
| Relay protected AI/search/media/read | Deny without control key | Key/session dependent | Key/session dependent | Key/session dependent |

**Important:** exact generation/comment creation access for a merely waitlisted authenticated user should be confirmed against the final deployed RPC definitions and live RLS; migration history shows multiple revisions. This is an adjustment blocker for access-control changes.

---

## 9. User Journey Map

### Anonymous visitor

Entry at `/` → sees demo/chat/community shell → can use local demo and browse public/legal surfaces → may submit waitlist email → may open auth → may encounter feed error/retry if backend unavailable → can enter provider configuration locally. Anonymous users cannot be assumed to have workspace or admin data access.

### New user

Sign-up → email/OTP or password flow → relay creates/confirms account through Supabase bridge → session/ticket is redeemed → profile trigger/backfill → account returns to app → access RPC determines waitlisted vs granted → workspace gate or workspace. Failure points: mail delivery, missing relay/Supabase env, expired code, duplicate confirmed address, stale redirect `back`, and account/session disagreement.

### Authenticated waitlisted user

Session restore → `my_workspace_access` → private-beta gate → can continue Community, see waitlist confirmation/position → waits for admin grant/email → refresh/access check needed to enter workspace. Potential stuck state: grant occurs but cached access state remains waitlisted until refresh or explicit recheck.

### Active user

Session/access check → workspace available → local chat/provider setup and/or community post → read feed/profile/comments → write generations/comments/saves/reports/profile → notifications → sign out. Data is split: chat history/provider keys are browser-local while community/profile/entitlement are Supabase-backed.

### Admin

Visit `/admin` → booting → signed out, denied, bootstrap, no-capabilities, or dashboard → capability-specific sections → read waitlist/approved/admin/reports → grant/resend/add/remove/edit caps/resolve reports as allowed → sign out. The live unauthenticated page verified the shell does not trust browser admin state and offers sign-in.

### Stuck/contradictory conditions identified

- Live home response simultaneously contains a feed “could not load” state and normal empty/end states; this may be a normal failed request fallback but is confusing if not mutually exclusive in the browser.
- Admin is intentionally public as a shell but is described as protected; users may reasonably interpret route discovery as exposure even though actions are checked.
- Workspace state and local chat state have different persistence/permission models under one “workspace” label.
- Provider keys are described as encrypted at rest but browser local storage/device key/passphrase security remains dependent on the same browser profile and user device.
- Migration history contains several replacement versions of the same RPCs; source-level route tracing must use the final migration order, not the first definition.

---

## 10. State Matrix

| Area | Present states | Missing/unclear states to verify |
|---|---|---|
| Auth | Form, submitting, code requested, code verified, invalid/expired code, reset, signed out | Offline retry, relay 5xx clarity, session expiry while in app, duplicate-tab session changes |
| Access/waitlist | Checking, anonymous, waitlisted, granted, join success/error/full | Grant while tab open, stale cache, deleted waitlist entry, network timeout UI |
| Feed | Loading, loaded, empty, end, new posts, pull refresh, error/retry | Offline queue reconciliation, deleted post during pagination, cursor duplication |
| Post/generation | Initial, composing, submitting, success, failure, visibility/remix context | Double submit, timeout after commit, duplicate idempotency behavior, edit/delete stale card |
| Comments | Loading thread, empty, submit, error, soft-deleted | Concurrent parent deletion, nested reply depth, duplicate send |
| Likes/saves/follows | Schema has saves; UI/implementation linkage unclear | No verified likes/follows subsystem; must not assume it exists |
| Profiles | Loading, loaded, empty feed, update | Handle collision, deleted account, stale profile cache |
| Notifications | Dot/unread, inbox, read/dismiss | Trigger failure, related content deleted, realtime disconnect |
| Admin | Booting, signed out, denied, bootstrap, no caps, dashboard, section hidden | Capability revoked mid-session, concurrent admin changes, destructive action failure |
| Settings/providers | Loading/local, form validation, probing, model selected, saved, provider error | Key unlock failure, corrupted local store, provider timeout, key rotation |
| Uploads | Picker, preview, send | File too large/type rejected/network failure/cancel/retry is not fully established |
| Search/media/read | Request, provider result, empty, fallback, error | Partial provider failure and attribution consistency; SSRF rejection messaging |
| Workspace sync | Local changes, save, loaded | Offline queue, conflict, tab race, partial JSON/payload rejection |
| Logout | Button/session clear/redirect | In-flight request cancellation and other-tab logout propagation |

The code contains many explicit states, but “state exists in markup” is not proof that each transition is wired. The rows marked unclear require browser instrumentation or authenticated integration tests.

---

## 11. Cross-Feature Dependency Map

```text
Anonymous
  -> static shell / demo chat / legal pages
  -> waitlist RPC or auth

Auth relay + Supabase session
  -> profile trigger/backfill
  -> workspace access RPC
       -> waitlisted gate OR active workspace

Community feed
  -> generations
       -> comments/replies
       -> saves
       -> remix/root lineage
       -> notifications
       -> profiles/profile feed
       -> reports
       -> admin reports/moderation

Workspace chat
  -> local provider/key storage
  -> local chats/prompts/usage/memory
  -> optional relay search/read/images/videos/files
  -> workspace_state sync

Admin capability model
  -> waitlist/grants
  -> approved roster
  -> admin roster/capabilities
  -> report view/resolve
  -> grant email notification

Relay
  -> Supabase service role for account/admin bridge
  -> mailer/OTP
  -> external search/media/provider/gateway

Lightning gateway
  -> local llama-server
  -> relay or direct browser
```

Deletion and permission-loss handling is strongest for DB-owned generation/comment policies and weakest for external media URLs, browser-local state, and serialized workspace references. Notifications are database-triggered for comment/lineage paths, but grant email is an explicit admin action. A failure after an external provider response but before local persistence can leave UI and usage counters inconsistent; this requires scenario tests.

---

## 12. Admin System Inventory

Admin identity is not a browser flag. The database has `admins`, capability tables/mappings, bootstrap state, `is_admin`, `require_admin`, `has_cap`, `require_cap`, `can_do`, and admin RPCs. The relay independently verifies a Supabase session and calls capability checks before admin actions.

Admin routes/actions found:

- Read accounts/roster, waitlist, reports, status.
- Grant workspace access, resend grant notification.
- Bootstrap one-time owner claim.
- Add/remove admins.
- Grant/revoke capabilities.
- Read and resolve reports through final DB functions.
- Wake/status of the model chain.

The UI explicitly renders owner protection, queue rights, capability editor, denied/no-capability states, and sign-out. Destructive operations are capability-bound; confirmation details are present for some UI actions but complete confirmation/audit-log behavior is not verified. No dedicated immutable admin audit-log table was found in the migration inventory. This is a notable accountability gap if destructive admin changes need forensic history.

The `/admin` route is discoverable by design. Source comments state the page is public and every operation re-checks capabilities. Unauthenticated live inspection showed sign-in, not privileged data. Direct invocation of every admin endpoint with invalid, waitlisted, revoked, and cross-user sessions remains **UNKNOWN** without credentials.

---

## 13. Security Inventory

### Positive controls verified

- Supabase RLS is enabled across core tables.
- Ownership policies exist for profiles, generations, comments, saves, notifications, workspace state, reports/admin tables.
- Controlled RPCs validate author/session ownership rather than trusting only hidden buttons.
- Auth codes are hashed/peppered, expiring, one-time, and tested against replay/wrong-code behavior.
- Password handling is delegated through the Supabase bridge; source tests assert the relay does not store the password.
- Rate counters and write rate limits exist in migrations; auth-failure throttling exists in Lightning.
- Relay remote fetch/read/file logic checks public hosts/resolved IPs, disallows private/loopback/link-local targets, limits size/time, and does not follow redirects in the documented fetch path.
- CSP, `nosniff`, referrer policy, permissions policy, and form-action are configured in `render.yaml`.
- Provider keys are intended to be encrypted in browser storage and excluded from normal export.
- Security and adversarial test suites are substantial.

### Findings / risks

1. **Secret handling risk (HIGH if exposed):** the user supplied a GitHub personal access token in the conversation. It was used without being written to the repository or reported in output, but it should be revoked/rotated because it has been disclosed to an external service context. This is operational, not a repository secret finding.
2. **CSP permits broad network destinations:** `connect-src` includes `https: http: localhost 127.0.0.1 ws: wss:`. This is functional for arbitrary BYOK endpoints but expands exfiltration/network surface if any XSS or malicious content reaches a request path.
3. **Arbitrary provider endpoints are a deliberate SSRF-like browser capability:** users choose them, but imported/provider configuration and rendered content must not turn this into attacker-controlled background requests.
4. **Admin authorization has two layers:** relay capability checks and Supabase RPC capability checks. Any drift is a privilege-escalation risk; both must be tested together.
5. **Service-role key is powerful:** relay misconfiguration, origin bypass, or endpoint auth failure would expose account/admin operations. Environment presence and production origin enforcement are unknown.
6. **CORS/environment discrepancy:** Lightning example permits `ALLOWED_ORIGINS=*`; Render relay is locked to the Render site. Actual deployed values are unknown.
7. **XSS surface:** chat markdown, citations, remote media, profile/comment text, page-reader content, and imported JSON are all untrusted input surfaces. Sanitization helpers/tests exist, but a full rendered-sink audit is not complete.
8. **IDOR boundary requires final schema:** the final migration order appears to harden most write RPCs, but live RLS and every admin route were not exercised.
9. **Rate limiting is not uniformly proven on every relay retrieval endpoint:** route-specific tests exist, but deployment-level abuse limits and shared-IP behavior are unknown.
10. **No verified durable audit log:** admin changes may be difficult to reconstruct.
11. **Client-side key protection is not equivalent to a server vault:** local encrypted keys can be attacked by code running in the origin or a compromised device/browser profile.
12. **Cache/service-worker drift:** non-hashed assets plus a service worker can produce stale UI/API contract combinations despite no-cache headers; production behavior needs cache-version testing.

No evidence was found of a committed real secret in the inspected source. Environment values are templates/placeholders, but deployed secrets are **UNKNOWN**.

---

## 14. Edge Case Inventory

Priority scenarios before future changes:

- Double-click/rapid send, comment, save, grant, approve, report, and mark-read.
- Refresh/back/tab close during OTP, generation, upload, admin grant, or workspace save.
- Two tabs editing workspace state or profile simultaneously.
- Expired Supabase session while feed/admin page is open.
- Revoked capability while admin dashboard remains open.
- User/account/content deletion while card/detail/profile is visible.
- Duplicate request after network timeout where the server committed but response was lost.
- Empty DB/feed, huge feed, huge comment thread, long text, Unicode/emoji/RTL/control characters.
- Malformed JSON, missing IDs, foreign parent IDs, mismatched generation/comment IDs.
- Offline startup, offline submit, reconnect with stale cursors/outbox.
- Provider CORS rejection, bad key, wrong model, streaming truncation, provider 429/5xx, relay timeout.
- Relay SSRF attempts through DNS rebinding, redirects, encoded IPs, unusual ports, large compressed responses.
- Invalid/malicious upload type, oversized file, broken image/video, SVG active content.
- Mobile keyboard/viewport, slow device, reduced motion, service-worker stale cache.
- Admin bootstrap race, last-owner removal attempt, simultaneous capability edits.
- Grant email failure after database grant success; resend/idempotency behavior.

The repository has dedicated adversarial, stress, auth, file, image, media, and request-matrix tests. Those are valuable evidence of intended defenses, but passing a unit/test fixture does not prove the deployed service and migration state match the checkout.

---

## 15. Production vs Codebase Differences

### Verified

- `https://impose-web.onrender.com/` is reachable and returns the Impose shell.
- The deployed response exposes the expected demo/community/workspace/admin surfaces.
- The unauthenticated admin experience presents sign-in and does not reveal admin records.
- The public response displayed “We could not load the feed” plus a retry control during inspection, indicating the live feed request did not successfully populate at that time.

### Not verifiable without authenticated/infrastructure access

- Exact deployed commit/assets compared with `566d463`.
- Whether all 20 migrations are applied, and which final function bodies are live.
- Supabase URL/project and RLS policies in production.
- Relay health, origin allowlist, control key, service key presence, mail delivery, and backend revision.
- Lightning gateway/model availability and provider search keys.
- Authenticated waitlist, active workspace, posting, comments, notifications, profile, report, and admin actions.
- Production-only CORS/CSP, cache/service-worker interactions, and mobile behavior.

The live feed failure is the most concrete code-vs-production operational discrepancy observed: source contains a rich feed/RPC system, but public production did not return feed data during the audit. Root cause is **UNKNOWN** and may be environment, database, migration, network, or expected empty/error handling.

---

## 16. Logic/UX Inconsistencies

- One shell presents Community and Workspace as adjacent modes, but their persistence, authorization, and backend dependencies differ materially.
- “Demo replies” are available while the community composer advertises `@bot`; a user can reasonably confuse local demo chat with a published community generation.
- Feed error and empty/end messaging can coexist in the live document; they should be audited as mutually exclusive state transitions.
- Admin route is intentionally public but contains detailed capability/bootstrapping language. This is not a security bypass by itself, but it reveals internal operational concepts.
- Provider keys are described as safe/encrypted while arbitrary direct calls necessarily expose them to the selected provider and to page runtime memory. Copy should distinguish those boundaries.
- “Upload”/attachment UI exists, but a durable upload lifecycle was not found; users may expect files to survive beyond the message/browser state.
- A large standalone build duplicates runtime logic and can diverge from the modular site if not rebuilt.
- Migration and function names evolve (`update_my_profile` vs `customize_profile`, repeated `create_generation`/`create_comment` definitions). This increases the chance that docs/UI/tests describe a non-final contract.

---

## 17. Dead / Duplicate / Partial Systems

### Duplicate or drift-prone

- `impose-standalone.html` duplicates the modular application.
- `README.md`, `backend/README.md`, `RENDER_SETUP.md`, product/audit docs, and live code overlap and may describe different stages.
- Supabase migrations repeatedly replace the same function names; only ordered final state is authoritative.
- Agent/audit feature harnesses duplicate some media/search/rendering logic and are not necessarily production paths.
- Legacy/static pages and route rewrites coexist with the single-document app.

### Partial/unclear

- Community feed production connectivity.
- Authenticated live flows.
- Upload durability/storage.
- Likes/follows: requested concepts do not appear as verified entities; `saves` exists, but likes/follows should not be assumed.
- Messaging/subscriptions/premium: no verified implementation found.
- Background jobs/notifications beyond DB triggers and realtime: no queue/worker verified.
- Admin audit trail.
- Conflict resolution for workspace sync.

### Likely unused/dead candidates requiring proof

Do not delete yet, but audit references before changing: standalone build, some agent/audit harness paths, legacy docs, provider/media adapters not enabled by current env, and any older migration definitions that are superseded rather than independently deployed.

---

## 18. Change Impact Map

| Subsystem changed | Direct dependencies | Indirect/user flows | Data/API/security impact |
|---|---|---|---|
| Auth/OTP/session | auth UI, access.js, Supabase Auth, relay OTP/store/mailer | Signup, reset, waitlist, admin, every private read/write | Auth codes/tickets/session validation, account enumeration, redirects. |
| Waitlist/grants | access.js, workspace gate, admin grant, email | New/waitlisted/active journeys | `waitlist`, `workspace_grants`, `my_workspace_access`, grant RPC, capability boundary. |
| Generation schema/RPC | community.js/feed/detail/remix/notifications | Posts, feed, profiles, reports, admin | RLS, IDOR, spam/rate/idempotency, counts/lineage. |
| Comments | detail UI, notifications, reports | Replies, profile activity, moderation | Parent checks, soft deletes, triggers, rate limit. |
| Profiles | avatars/community UI/admin roster | Identity, profile/feed, notifications | Public PII exposure, handle uniqueness, sanitization. |
| Notifications | bell/dots, DB triggers/realtime | Comments/remix/grants | Recipient ownership, stale references, realtime. |
| Admin capabilities | admin UI, relay admin routes, Supabase functions | Waitlist, grants, roster, reports | Privilege escalation/lockout/auditability. |
| Local chat state | app.js/sidebar/settings/export/sync | Core chat, retention, import/export | Browser data loss, schema migration, XSS/import risks. |
| Provider/relay protocol | provider wizard, chat streaming/search/media | All AI/tool flows | Secret handling, CORS, SSRF, rate/cost abuse. |
| Workspace sync | workspace-sync.js, workspace_state RPC | Cross-device/account UX | Payload validation, conflicts, stale-tab overwrite. |
| Render/static build | all browser routes/assets/service worker | Every production page | Stale assets, rewrite/CSP/cache, codebase parity. |
| Supabase migrations | every DB feature | Every authenticated/community/admin flow | Ordering, function replacement, RLS and grants; highest blast radius. |

Safe adjustment sequence is to prefer isolated local-only UI changes first, then add tests around the exact RPC/relay contract, and only then change shared migrations/auth/capabilities.

---

## 19. Unknowns

1. Exact production commit and deployed backend revisions.
2. Actual Supabase project, applied migration level, RLS policies, triggers, indexes, and data.
3. Authenticated production behavior for every user role.
4. Whether feed failure was transient, configuration, schema, or code.
5. Production environment variables, secrets, CORS allowlists, mail configuration, and provider keys.
6. Full route-to-handler mappings in every browser event path without executing a browser.
7. Durable file upload/storage behavior.
8. Exact mobile/accessibility behavior and screen-reader semantics.
9. Realtime channel configuration and disconnect/reconnect behavior.
10. Whether any external deployment or operational process exists outside the repository.
11. Whether “premium”, billing, messaging, likes, follows, or subscriptions exist outside this checkout. No evidence was found in the inspected source.
12. Whether all security tests run against the same final migration state deployed in production.

---

## 20. Adjustment Readiness

### Safe to modify with normal regression tests

- Purely local visual/layout copy changes that do not alter IDs, data attributes, or event contracts.
- Legal/static pages.
- Isolated demo reply copy and local-only chat presentation.
- Documentation, audit tooling, and test fixtures, provided production files are not regenerated accidentally.

### Requires investigation first

- Feed loading failure and any community feature change.
- Auth, OTP, password reset, session restore, or redirects.
- Waitlist/grant eligibility and workspace gate.
- Admin UI, capabilities, bootstrap, grants, reports, or account operations.
- Supabase migrations/RLS/RPCs, especially repeated canonical functions.
- Relay auth, service-role use, CORS, remote fetch/read/media/file routes.
- File uploads, workspace sync conflict behavior, notification triggers/realtime.
- Standalone build and service-worker cache behavior.

### Dependencies that must be respected

1. Treat the final ordered migration state as the database contract; do not edit an earlier migration in place.
2. Trace each change end-to-end: UI handler → request/RPC → session/capability/RLS → validation/rate/idempotency → DB mutation → trigger/notification → response → UI state.
3. Test both browser-hidden and direct-request paths for every permission change.
4. Keep relay and Supabase admin authorization aligned; never rely on a frontend capability flag.
5. Test duplicate/timeout/stale-tab/offline behavior before changing write flows.
6. Rebuild and verify `impose-standalone.html` whenever shared runtime files change, or explicitly document that it is not production parity.
7. Verify Render rewrites, CSP, service worker, and asset cache after route or auth changes.
8. Re-run Supabase schema tests, backend tests, adversarial tests, and an authenticated production smoke suite before deployment.

### Readiness conclusion

The platform is **adjustment-ready for isolated local UI/product copy work**, but **not yet adjustment-ready for shared auth, access control, community data, admin, migration, or relay changes** until the live feed failure, production schema/configuration, authenticated role flows, and final RPC contracts are verified. The architecture is sufficiently mapped to begin a controlled investigation pass, but it is not safe to claim that every production flow is verified from the current unauthenticated surface.

---

## Audit boundary statement

This report intentionally does not modify, refactor, redesign, delete, or repair application behavior. Findings distinguish source evidence from inference and identify where live credentials or deployment access are required. Future implementation should start by converting the Unknowns into explicit verification tasks, not by assuming the documented happy path is the production truth.
