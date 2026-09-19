# IMPOSE — Pre-Adjustment Verification & Contradiction Audit

**Date:** 2026-09-19  
**Source:** checkout `566d463`, `main`; live origin `https://impose-web.onrender.com/`  
**Scope:** verification only. No application code, migrations, configuration, or generated build was changed.

## A. Verification Summary

The previous inventory was directionally useful, but one important production conclusion was overstated:

- **The claim “the live production feed failed” is not verified.** The page-fetch tool returned hidden/static text from the HTML, including the feed error element. The feed error element is initially present in `index.html` and hidden by `hidden`; the fetch result does not execute browser JavaScript or prove that the element became visible. The correct classification is **UNKNOWN — browser/network/production credentials required**, not confirmed production failure.
- **The feed code itself has a coherent final client contract:** `feed_page(p_before_time, p_before_id, p_limit)` and `feed_since(p_after)`. It uses keyset pagination and explicitly separates error, empty, loading, and end states. The earlier claim that `ERROR + EMPTY + END` visibly coexist is contradicted by `syncFeedState()` and `syncFeedTail()`.
- **The final migration state is materially more hardened than an inventory based on early migrations suggests.** Final generation/comment functions use authentication, profile creation, validation, idempotency, rate limiting, and ownership/parent checks. `save_workspace` is compare-and-set capable, although the client deliberately retains a compatibility fallback to the old one-argument call.
- **Waitlist access has two related authorities:** `my_workspace_access()` is the user-facing access query, while `workspace_grants` and the final `handle_new_user()`/admin grant functions are the mutation authority. `access.js` caches the query result for a short period and therefore can be stale, but it cannot create server-side access.
- **The frontend is not uniformly current by design:** `community-data.js` contains an explicit `update_my_profile` path as well as the newer `customize_profile` path; `workspace-sync.js` intentionally falls back to the old `save_workspace(jsonb)` shape if the newer signature is absent. These are compatibility paths, not automatically bugs.
- **The standalone build is a generated artifact and is currently served by the root file list, but it is not the normal `/` route.** `build_inline.py` inlines the current modules and has a `--check` stale-build guard. It can drift if not rebuilt; no CI step proving it is rebuilt was found.
- **A concrete security issue remains operational rather than application-code based:** the GitHub token supplied in the conversation should be revoked/rotated. No real token was found in the repository or report.

Overall: the smallest safe adjustment surface is local UI/copy and isolated demo behavior. Auth, final RPCs, RLS, access, admin capabilities, relay auth, and service-worker precache remain high-blast-radius systems.

## B. Contradictions Found

| Previous claim | Verification result | Classification |
|---|---|---|
| Live feed visibly failed in production | Fetch result included hidden error markup; no executed browser evidence | **False as stated / UNKNOWN in reality** |
| Feed error, empty, and end can coexist | `syncFeedState()` mutually controls error/empty; `syncFeedTail()` controls end; end requires `feedDone && shown > PAGE_SIZE` | **False/outdated** |
| Workspace sync is last-write-wins | Final `save_workspace(p_data, p_expected_rev default null)` uses row lock and `stale_workspace`; null is backward-compatible overwrite | **Partially true only for old-client fallback** |
| Final admin bootstrap grants every capability | Final function returns the catalog but requires the existing owner row; capability initialization/assignment must be read from the full 0018/0020 state | **Overstated; final behavior is conditional** |
| Community feed failure proves production/config defect | No executed request/response trace was available | **Unknown** |
| Standalone is merely legacy/unused | `render.yaml` copies `impose-standalone.html`; it is reachable as a static file, but not the primary route | **Active artifact / secondary surface** |
| Service worker can serve old core files indefinitely | `CACHE` version, `skipWaiting`, `clients.claim`, network-first core, and old-cache deletion are implemented | **Mitigated in current code, residual deployment/version risk** |
| Provider endpoint issue is SSRF | Direct BYOK calls are browser-origin, user-selected provider calls; relay has separate public-IP guards | **Not an SSRF finding by itself** |
| Browser anon key is an exposed secret | `config.js` contains a Supabase publishable/anon key intended for browser use; RLS is the security boundary | **False positive as secret exposure; RLS still needs production verification** |

## C. Final Database Contract

The migration folder is an ordered history. “Final” below means the last definition in the supplied migration sequence, not the first definition.

### `my_workspace_access()`

- **First/final definition:** `0001_mvp.sql`; no later replacement found.
- **Parameters/return:** no parameters; table result containing the caller’s access/email/waitlist information, including `can_use_workspace`, `email`, and `waitlist_position` as consumed by `access.js`.
- **Authorization:** session-derived (`auth.uid()`/current auth context); public execution must not expose other users’ state.
- **Validation/rate/idempotency:** read only; no write-rate or idempotency concern.
- **Tables:** profiles/waitlist/workspace grant state as defined in 0001; exact final return body should be confirmed by extracting the complete 0001 function in a live schema.
- **Frontend caller:** `access.js` REST RPC `/rest/v1/rpc/my_workspace_access`.
- **FINAL DATABASE BEHAVIOR:** returns the current server-side workspace decision for the current session. It does not grant access and cannot be replaced by the local cache. **Partially verified** because deployed SQL was unavailable.

### `join_waitlist(p_email text)`

- **Definitions:** `0001`, hardened replacement `0013`, canonical replacement `0019`; final is `0019`.
- **Return:** `table(waitlist_position integer, status text)`.
- **Authorization:** executable by `anon, authenticated`; security definer; intended public waitlist join.
- **Validation:** lowercases/trims; email format and length; local-part shape; spammy local-part rejection; disposable/test domain rejection; max 100,000 rows.
- **Concurrency/idempotency:** selects existing email; inserts only if absent; advisory transaction lock serializes position allocation; conflict-safe insert. Repeated same email returns existing row/status.
- **Tables:** `waitlist`; `text_is_spammy`; advisory lock.
- **Frontend:** `access.js` expects `waitlist_position` or fallback `position`, and handles `waitlist_full`.
- **FINAL DATABASE BEHAVIOR:** normalized, idempotent waitlist join returning current position/status. `approved` maps to position `0`. It does not itself create a workspace grant.
- **Mismatch:** frontend accepts a fallback field `position` that final SQL does not return; harmless compatibility, not a current contract failure.

### `create_generation(...)`

- **Definitions:** 0004, 0006, 0007, 0011, 0012, 0013, final 0014.
- **Final parameters:** `p_key uuid, p_prompt text, p_response text default '', p_addressed boolean default false, p_status text default 'complete', p_visibility text default 'public', p_kind text default 'original', p_remix_of uuid default null`.
- **Return:** `public.generations`.
- **Authorization:** authenticated only; `auth.uid()`; security definer; profile ensured.
- **Validation:** prompt 1–4000; response ≤20,000; visibility public/private; kind original/remix/challenge; lineage parent requirements; parent must exist, be visible/owned, and not locked against the caller.
- **Idempotency:** `idempotency_keys` keyed by `p_key`; request hash mismatch raises `idempotency_key_reused`; same key/same hash returns stored generation.
- **Rate limiting:** after replay check, per-user generation 8/60s; addressed bot per-user 3/60s and global 12/60s.
- **Tables/triggers:** `generations`, `idempotency_keys`; generation root/count triggers from earlier migration remain unless later replaced.
- **Frontend:** `community-data.js` passes all eight named parameters and accepts row or one-element array.
- **FINAL DATABASE BEHAVIOR:** authenticated, bounded, lineage-checked, rate-limited, idempotent insert returning the canonical generation row. It does not trust a client author ID.
- **Potential mismatch:** frontend can pass `p_status` and `p_addressed`; final SQL validates length/kind/visibility but does not visibly constrain every status value in the excerpt. Status-domain enforcement requires live schema confirmation.

### `create_comment(...)`

- **Definitions:** 0004, 0006, 0007, 0011, 0013, final 0014.
- **Final parameters/return:** `p_key uuid, p_gen uuid, p_body text, p_parent uuid default null`, returns `public.comments`.
- **Authorization:** authenticated; `auth.uid()` and ensured profile.
- **Validation:** body 1–1000; parent must belong to same generation and be live; generation must be live and public or caller-owned.
- **Idempotency/rate:** idempotency key/hash; final function includes per-user/thread rate checks after replay check (complete lower section should be used for exact windows).
- **Tables/triggers:** comments, idempotency keys, comment counts and notification triggers.
- **Frontend:** named args exactly match.
- **FINAL DATABASE BEHAVIOR:** authenticated, parent-safe, idempotent comment insert with server ownership and rate validation.

### `thread_for(p_gen uuid)`

- **Definitions:** 0004 then final replacement 0014.
- **Parameters/return:** one generation UUID; returns rows from live comments joined to the requested generation’s visibility; order is `created_at, id`.
- **Authorization:** RLS/visibility follows the generation; public generation or caller-owned private generation.
- **Frontend:** exact name/parameter match.
- **FINAL DATABASE BEHAVIOR:** returns only live comments belonging to the requested visible generation; parent rows cannot cross threads. Exact composite return columns require live schema introspection.

### `feed_page(...)` and `feed_since(...)`

- **Definitions:** only 0004 found; no later replacement.
- **`feed_page` final parameters:** `p_before_time timestamptz default null, p_before_id uuid default null, p_limit integer default ...` (exact default/return column list should be checked in the full function; frontend supplies named args).
- **Behavior:** public generations, keyset order by time/id, bounded page; cursor avoids offset drift.
- **`feed_since(p_after timestamptz)`:** returns a count of newer feed rows; frontend maps scalar/array result to a number.
- **Frontend:** exact RPC names and named fields match source contract.
- **FINAL DATABASE BEHAVIOR:** read-only public feed/counter. Realtime is an enhancement, not required for initial feed page.

### Profile functions

- `profile_by_handle(p_handle text)`: final definition in 0010; read profile by normalized handle; frontend expects one row or array and fields `id, handle, display_name, bio, created_at, post_count, is_me`.
- `profile_feed(...)`: defined in 0010 and called with handle/time/id/limit; final replacement was not found after 0010. Frontend contract is keyset profile feed.
- `update_my_profile(p_display_name, p_bio)`: 0010/0013 path; authenticated own-profile update with sanitization in later replacement.
- `customize_profile(p_display_name, p_bio, p_handle default null, p_avatar default null)`: final 0020; authenticated, bio/display-name validation, handle/avatar customization and quota fields. `community-data.js` still exposes both operations. This is intentional compatibility/feature layering but creates two profile-write contracts.
- **FINAL DATABASE BEHAVIOR:** `customize_profile` is the newer canonical customization path; `update_my_profile` remains available and is still called by an older UI path. This is a real frontend/backend duplication, not necessarily a broken call.

### Notifications

- `notifications_page(p_limit default 20)`, `notifications_unread()`, `notifications_mark_read()` defined in 0010 and not redefined later.
- Tables/triggers: `notifications`; comment and lineage trigger functions insert notifications; 0020 adds `waitlist_approved` kind and `admin_grant` inserts that kind.
- Frontend names/fields match expected `id, kind, actor_name/actor_handle, generation_id, comment_id, excerpt, read_at, created_at`.
- **FINAL DATABASE BEHAVIOR:** recipient-scoped read/list/mark-read operations; notification existence depends on the source trigger/admin path. No durable notification for every possible mutation is implied.

### Reports

- `report_content(p_kind, p_target, p_reason)` defined in 0015; frontend exact named args.
- Report is user submission, target validation and duplicate behavior are schema-controlled; frontend translates `target_gone`.
- `admin_resolve_report(...)` appears in 0019; exact UI caller and parameter set require authenticated admin testing.
- **FINAL DATABASE BEHAVIOR:** report creation is server-controlled; duplicate/idempotency claim in prior inventory is only confirmed if the unique constraint/function body is applied in production.

### `save_workspace(p_data jsonb, p_expected_rev bigint default null)`

- **Definitions:** 0016 one-argument version; 0019 drops old overload and defines final two-argument version.
- **Authorization:** authenticated only; `auth.uid()`; security definer.
- **Validation:** non-null JSON; ≤3 MiB; `rate_hit('ws:'||uid, 30, 60)`.
- **Concurrency:** row lock; expected revision mismatch raises `stale_workspace`; first-save race handled by insert/upsert logic.
- **Return:** JSON containing new revision (client reads `res.data.rev`).
- **Frontend:** sends new shape; if error looks like missing function/schema cache, retries old one-argument shape.
- **FINAL DATABASE BEHAVIOR:** compare-and-set when revision is supplied; unconditional overwrite when null. The compatibility fallback deliberately permits old-client last-write-wins behavior against an unupgraded database.

### Admin/capability functions

- `admin_bootstrap_claim(p_note default null)`: 0018 then final 0020. Final requires authenticated user to be the existing owner row, inserts one-time bootstrap record, raises `bootstrap_used` on replay, returns `status=claimed` and capability catalog. It does not let an arbitrary first user claim ownership.
- `admin_grant(p_email)`: 0017 → 0018 → final 0020. Final `require_cap('admin_grant')`, rate limits admin bucket, validates email, requires existing account, inserts grant idempotently, inserts `waitlist_approved` notification when new, marks waitlist approved, returns `granted` or `already` plus user ID. It does not approve pre-signup accounts despite older documentation language.
- `admin_add(p_email)`, `admin_remove(p_user_id)`, `admin_grant_cap(p_user_id,p_cap)`, `admin_revoke_cap(...)`: final 0018 definitions; capability/owner protections are in SQL functions. Exact action-cap names require the capability catalog/live introspection.
- `admin_waitlist`, `admin_roster`, `admin_reports`, `admin_caps_for`, `can_do`, `require_cap`, `has_cap`: final capability/read paths are 0018; relay also checks them through service-role bridge.
- **FINAL DATABASE BEHAVIOR:** admin operations are capability-bound server functions. The frontend’s hidden sections are not the authority.

## D. Frontend ↔ Backend Contract Mismatches

| Caller | Expected | Actual/final | Match | Severity |
|---|---|---|---|---|
| `access.js` → `join_waitlist` | `waitlist_position` or fallback `position`, status | Final returns `waitlist_position,status` | Compatible | Low |
| `community-data.js` → `feed_page` | named cursor + limit; array rows | Final 0004 keyset function; parameters align | Verified match, exact defaults need schema | Medium until live schema verified |
| `community-data.js` → `feed_since` | scalar/array numeric count | Final returns count-like result | Likely match | Low |
| `community-data.js` → `create_generation` | eight named args; row/array row | Final signature/return align | Match | None |
| `community-data.js` → `create_comment` | four named args; row/array row | Final signature/return align | Match | None |
| `community-data.js` → `thread_for` | `p_gen`; comment rows | Final replacement preserves name/arg | Match | Low |
| `community-data.js` → profile | `update_my_profile` and `customize_profile` both exist | Both exist; newer path has extra fields/quota | Duplicate contracts | Medium |
| `community-data.js` → notifications | fields mapped from actor/excerpt/read timestamps | Trigger/RPC return shape appears intended | Partial until live introspection | Medium |
| `workspace-sync.js` → `save_workspace` | new expected revision response `.rev` | Final returns JSON rev | Match on upgraded DB | Medium due compatibility fallback |
| `workspace-sync.js` old fallback | one-arg RPC | Final migration explicitly drops old overload | Fallback only works against old DB | Medium, can hide incomplete deployment |
| Admin UI → relay/DB | capability-specific actions | Source has relay `session_can` and SQL `require_cap` | Intended match | High until live authenticated test |
| Community feed UI | error only when `feedFailed && shown===0`; end only when done and > page size | Source implements this | Match | Previous contradiction false |

No confirmed wrong function name or wrong parameter order was found in the inspected callers. The main real mismatches are compatibility/duplicate paths and contracts that cannot be verified against the deployed schema.

## E. Production Findings

### Feed finding

**Classification: UNKNOWN, not confirmed failure.**

Trace from source:

`community.js init()` → `renderFeed()` → `reloadFeed()` → `loadMoreFeed()` → `liveOnline()` checks `BotoData.configured()` → `BotoData.feedPage()` → `db().rpc('feed_page', {p_before_time, p_before_id, p_limit})` → `run()` normalizes Supabase errors → on failure sets `feedFailed=true`; on success absorbs rows, sets cursor/done and renders.

The live fetch tool returned server HTML/text but did not execute this chain. Therefore it cannot distinguish:

- `BotoData.configured()` false,
- Supabase RPC/network error,
- RLS/schema failure,
- a successful empty result,
- or a hidden error node that never became visible.

Public config is present in `config.js`: Supabase URL and publishable key, and `ACCESS_MODE: 'enforce'`. This makes “missing frontend Supabase config” less likely, but not disproven for deployed assets. Realtime is not required for initial feed load. Required next test: browser devtools/network or Playwright against the live origin, capturing `/rest/v1/rpc/feed_page` status/body and console errors.

## F. Waitlist / Workspace State Machine

```text
ANONYMOUS
  -> local anonymous state
  -> join_waitlist(email) OR sign up/sign in
AUTHENTICATED
  -> my_workspace_access()
  -> no waitlist entry: waitlist/join prompt
  -> pending waitlist: waitlisted state
  -> workspace_grants row: granted state
  -> workspace UI enabled
```

- **Authoritative answer:** server-side `my_workspace_access()` for the current session, backed by `workspace_grants`/waitlist state.
- **Mutation authority:** final `join_waitlist`, final `admin_grant`, signup trigger for already-approved email, and grant table.
- **Frontend cache:** `access.js` caches status/email/position with a time window and refreshes on init; cache can disagree temporarily.
- **Grant while page open:** no evidence of a database push changing the access cache immediately; refresh/recheck is required unless another caller invokes `BotoAccess.refresh()`.
- **Revocation/deletion:** backend should deny on next authoritative check; open UI may remain enabled until refresh/session transition. This is a stale-window risk, not a bypass of server RPC authorization.
- **Session expiry/change/multiple tabs:** auth watcher exists; exact access invalidation across every tab is not verified.
- **Already joined:** final RPC returns existing row; idempotent.
- **Already granted:** final RPC returns `approved` status if waitlist row is approved; grant-table truth is consumed by access function.
- **Network/RPC failure:** frontend must remain in/checking/error path; exact user-visible retry behavior requires browser test.

The frontend cannot create a server grant. It can temporarily make a different UI decision from the backend because its cache is stale, but protected backend operations remain authoritative.

## G. Admin Authorization Chain

`/admin` Render rewrite → same `index.html` in admin mode → admin initialization reads Supabase session → server/DB capability checks → UI renders only permitted sections → each relay/DB operation rechecks session/capability.

| Operation | Server/DB protection | UI/failure |
|---|---|---|
| Bootstrap claim | authenticated existing owner; one-time unique bootstrap | bootstrap panel; error on replay/not owner |
| Read waitlist/roster/reports | relay session + `session_can`; SQL `require_cap`/admin functions | section hidden/denied |
| Grant workspace | `require_cap('admin_grant')`, email/account validation, rate limit | grant result/error; DB grant is authority |
| Add admin | final SQL capability/owner policy; relay check | admin roster/add UI |
| Remove admin | final SQL owner protection/capability policy | destructive roster action; exact confirmation not fully verified |
| Grant/revoke capability | `admin_grant_cap`/`admin_revoke_cap`; capability checks | capability editor |
| Resolve report | final `admin_resolve_report`; exact UI wiring/permission needs live test | report UI read-only language is potentially stale if action exists elsewhere |
| Model wake/status | relay control/admin auth, separate from Supabase capability model | status/wake UI |

**UI yes/backend no:** expected for revoked capabilities or stale UI; should show an actionable error. **UI no/backend yes:** direct RPC may succeed if SQL capability permits even when a stale client hid the section; this is not a privilege escalation if the operation itself is allowed to that account. Immediate revocation effect is server-side on the next request, not guaranteed in an already-rendered client.

## H. Data Lifecycle Problems

- Generations/comments use soft deletion and count/lineage triggers; comments validate live parent/generation on creation.
- A deleted generation disappears from feed but can remain as a detail/tombstone target; related comments, saves, notifications, reports, and remix references require explicit cascade/visibility behavior. Complete final FK/cascade behavior was not proven from a live DB.
- `idempotency_keys` can point to a deleted generation/comment; replay then selects a missing row. This is an edge case requiring behavior verification.
- Notifications contain related IDs and can outlive deleted targets. The frontend maps nullable/missing related objects but cleanup is not proven.
- Reports can outlive content; this is normally desirable for moderation history, but target-gone resolution must be tested.
- Profiles are created by signup/ensure-profile; deleted auth accounts and profile rows/orphan generation authors need live FK behavior verification.
- Saves are own-user relations; deletion of a generation may leave or cascade saves depending on final FK, not safely inferable from function names.
- Workspace serialized JSON can contain references to deleted/changed local records; server validates payload size, not semantic object references.

## I. State Machine Problems

- The previous `ERROR + EMPTY + END` finding is **not supported by current source**. Error is visible only when failed and no shown cards; empty only when not failed, not loading, done, and zero cards; end only when done and more than one page shown.
- `loadMoreFeed()` has no explicit `.catch()` around `BotoData.feedPage(...).then(...)`. If `feedPage` itself rejects rather than returns `{ok:false}`, `feedLoading` can remain true and the UI can get stuck. `run()` likely normalizes Supabase errors, but rejection behavior should be tested. **Concrete code-path risk, not confirmed production failure.**
- A short page marks `feedDone`; with zero rows, empty is correct. With exactly one page, the “all caught up” end text is intentionally suppressed (`shown > PAGE_SIZE`), which is a UX choice rather than an impossible state.
- Feed local pending streaming posts are rendered above server feed and are intentionally not part of server cursor ordering; this can temporarily differ from canonical order.
- Auth/access transitions are distributed across Supabase auth watcher, access cache, and mode gating; expiration/revocation transitions need live browser verification.
- Workspace sync has explicit stale conflict handling only when the caller has a revision; old-client fallback bypasses it.

## J. Security Boundary Problems

### Confirmed/partially confirmed boundaries

- Generation/comment functions derive user identity from `auth.uid()` and do not accept author/user IDs. **Confirmed in final source.**
- Admin grant/bootstrap/capability functions use server-derived identity and capability checks. **Confirmed in final source; deployed state unknown.**
- Workspace save derives `auth.uid()` and checks revision under row lock. **Confirmed in final source.**
- Waitlist join is intentionally executable by anon/authenticated but only writes normalized email/waitlist state. **Confirmed.**
- Relay service-role bridge exists and is powerful; endpoint-level production enforcement cannot be confirmed. **Partially confirmed.**
- Browser Supabase publishable key is not a secret; RLS is the actual boundary. **Previous secret-exposure concern false positive.**

No concrete IDOR, client-controlled ownership, client-controlled role, mass-assignment, or waitlist-grant bypass was proven from this pass. Direct attack testing against deployed RLS/admin endpoints remains required before calling those boundaries confirmed in production.

## K. Cache / Service Worker / Build Drift

### Service worker

`sw.js` uses:

- versioned cache `impose-shell-v68`,
- install precache with `cache: reload`,
- `skipWaiting`, `clients.claim`, deletion of older caches,
- network-first navigation and core assets,
- stale-while-revalidate for non-core assets,
- 503 rather than returning HTML for missing core JS/CSS.

This substantially mitigates the earlier “new HTML + old core forever” concern. Residual risks:

- a deployment that changes a precached source without changing `CACHE` can preserve stale files; comments require a fingerprint/version bump;
- a browser can retain an old worker until the update lifecycle completes;
- `community-data.js` is precached but not listed in `CORE`, so it uses stale-while-revalidate rather than network-first; a new `index.html/community.js` can briefly pair with old `community-data.js`;
- direct `impose-standalone.html` usage does not have the same modular asset lifecycle.

### Standalone build

`build_inline.py` reads index markup and inlines CSS, Supabase SDK, config, auth/access/workspace/app/community modules and agent scripts. It writes `impose-standalone.html`; `--check` compares generated output and fails if stale. `render.yaml` copies the standalone file to production. No automatic build/rebuild step or CI invocation of `build_inline.py --check` was found in the inspected workflows. Classification: **ACTIVE BUILD ARTIFACT / SECONDARY SURFACE**, not merely unused and not the primary `/` route.

A current source file can therefore be deployed in modular form while the standalone artifact remains stale. This is a real drift risk, especially for anyone opening the standalone file or its static URL.

## L. Confirmed Blockers

Only these are blockers before changing shared systems:

1. **Unknown deployed database contract:** production migration level/RPC definitions/RLS are not introspected. Any auth, waitlist, community, or admin adjustment is blocked until a schema dump or authenticated live RPC smoke test is available.
2. **Unknown live feed request outcome:** browser-level network evidence is required before changing feed code or diagnosing production.
3. **Unknown authenticated admin/access behavior:** capability and grant changes require test accounts/credentials or a staging environment.
4. **Credential hygiene:** revoke/rotate the GitHub token supplied to the assistant before any further repository operations.

The prior report’s “live feed definitely broken” is not a blocker by itself because it was not verified.

## M. High-Risk Areas

- Ordered Supabase migrations and replacement RPCs.
- RLS/security-definer functions and capability catalog.
- Auth/OTP/password reset/session refresh.
- Waitlist/grant/access cache and signup trigger.
- Admin relay ↔ Supabase dual authorization.
- Workspace compare-and-set and old-client fallback.
- Service worker cache/version and standalone regeneration.
- Generation/comment deletion, notification triggers, lineage/counts.
- `community-data.js` compatibility paths (`update_my_profile`, old `save_workspace`).
- Relay service-role, CORS, remote fetch/read and external provider routes.

## N. Safe Adjustment Surface

| Component | Dependencies | Safe changes | Unsafe changes | Tests required |
|---|---|---|---|---|
| Legal/static pages | Render rewrites only | Copy/accessibility metadata | Route names/CSP/build list | Static route smoke test |
| Demo reply presentation | `app.js` local state | Copy, formatting, local empty state | Provider/auth/community calls | Existing JS regression + manual chat |
| Local chat visual components | DOM IDs/events/CSS | CSS/copy/layout preserving IDs | Rename IDs/storage keys | Browser smoke, responsive check |
| Settings copy/toggles | local storage schema | Labels/help text | Provider encryption/storage semantics | Settings regression |
| Feed state copy only | `community.js` state IDs | Wording without transitions | RPC names/cursor/state flags | Feed state tests + browser network |
| Agent/audit docs/tests | test harness | Add assertions/documentation | Changing production runtime assumptions | Test suite |

Not safe without dedicated verification: any SQL migration/RPC, RLS, auth, waitlist, admin, relay auth, workspace sync contract, service worker cache list/version, or standalone build source inclusion.

## O. Unknowns

1. Actual production migration/schema/RLS state.
2. Executed browser trace and HTTP response for live `feed_page`.
3. Authenticated access/admin/community flows in production or staging.
4. Exact final return columns/defaults for every RPC without live Postgres introspection.
5. FK cascades and trigger behavior for deleted generation/profile/auth rows.
6. Whether all callers of admin report resolution are present and current.
7. Production environment values, relay revision, CORS, service key configuration, mail, and rate-limit behavior.
8. Cross-tab auth/access invalidation and service-worker update timing on real browsers.
9. Whether standalone static URL is used by actual users.

## P. Recommended Verification Order

1. **Rotate/revoke the exposed GitHub token.**
2. Obtain a safe staging/production read-only schema dump or run ordered migrations in a disposable Supabase project; introspect final function signatures, return types, policies, triggers, indexes, and FKs.
3. Run a browser-level live feed trace as anonymous user; capture config, console, RPC request/status/body, and render state.
4. Create test identities for anonymous, waitlisted, active, admin-owner, limited-admin, revoked-admin; execute access and admin matrix directly against staging.
5. Run end-to-end generation/comment/report/notification/profile tests using repeated requests, timeout simulation, two tabs, deletion, and revoked permissions.
6. Verify signup trigger and waitlist approval/grant timing, including pre-approved email and grant while tab remains open.
7. Verify workspace compare-and-set with two devices and old-client one-argument fallback against both upgraded and intentionally old schemas.
8. Run final migration/schema tests and backend tests against the same database state; do not rely only on historical unit fixtures.
9. Run service-worker upgrade tests: old worker → new worker, changed core files, changed `community-data.js`, offline navigation, standalone URL.
10. Only then approve adjustments to shared auth/access/community/admin infrastructure. Begin product changes on the safe local surface first.

**Baseline conclusion:** the inventory is now corrected where source evidence disproved it, especially the live feed and feed-state claims. The remaining uncertainties are deployment/schema/authentication uncertainties, not reasons to invent code defects. No implementation should begin on shared systems until steps 1–7 are complete.
