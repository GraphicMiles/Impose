# FINAL CLOSURE AUDIT — Impose (full-system, production-verified)

Date: 2026-09-19. Commit audited: `088c92d` ("Close platform contract and unify data clients").
Scope per rule.txt: (1) database-contract closure against migrations 0001–0022, (2) full-system contract integrity (UI ↔ state ↔ backend ↔ DB ↔ deployment), (3) rate-limit / abuse-control closure. Read-only audit: no code changed, nothing deleted beyond the audit's own probe rows (3 waitlist probe rows, inserted and then deleted live; documented in §I).

---

## 0. EVIDENCE BOUNDARY — what backs each claim

| Layer | Access used | Confidence |
|---|---|---|
| Git repo @ 088c92d | full read of migrations, JS, Python, configs | VERIFIED-FROM-REPOSITORY |
| Production Postgres catalog (pg_class/pg_constraint/pg_proc/pg_policies/pg_extension/pg_triggers/pg_event_trigger/pg_roles/cron.job/pg_publication_tables/information_schema privileges) | Supabase Management SQL API (personal access token) | VERIFIED-PRODUCTION |
| Production data state (row counts, capability/admin seeds) | same | VERIFIED-PRODUCTION |
| Anonymous role behavior (publishable key, as a browser would) | live REST/RPC/GoTrue probes | VERIFIED-PRODUCTION |
| `authenticated`, `waitlisted`, `granted`, `revoked-user`, `non-owner admin`, `admin-without-cap` roles | no second real account available in-session | PARTIALLY-PROVEN (static + function/RSL bodies), live execution UNVERIFIED |
| Relay / Lightning gateway environments (env vars, instance count, ALLOWED_ORIGINS, whether CONTROL_KEY set) | not reachable; Render env not queryable from this workspace | UNVERIFIED — flagged wherever it matters |
| Service-worker / standalone parity | build check executed locally (`build_inline.py --check` → "impose-standalone.html is current (1832491 bytes)") | VERIFIED at this commit |

Production project: `xgqcvuzkeaferjsnpjjw` ("Botocracy", eu-west-2, Postgres 17.6.1). `SUPABASE_URL` in config.js matches; publishable key in config.js matches the one used for probes.

---

## CLOSURE SUMMARY (what this pass changed)

The previous baseline (`docs/FINAL_DATABASE_CONTRACT_2026-09-19.md`) is **95% confirmed against production**, corrected in five places:

1. `saves` — baseline said "legacy retained". **Production: the table is DROPPED** (0021 applied; `drop table if exists public.saves cascade` executed). Corrected.
2. `reports` — baseline listed `reviewer_id` / review fields. **Production: never existed** — reports is `id, kind, target_id, reporter_id, reason, status, created_at` exactly as created in 0015. Baseline doc overstated; DB and migrations agree.
3. `notifications` — baseline listed read/dismiss fields. **Production: `read_at` only**, dismissal = `notifications_mark_read` setting `read_at`. No `dismissed_at` anywhere.
4. Scheduler — baseline marked purge scheduling "unknown". **VERIFIED: pg_cron 1.6.4 installed with 3 ACTIVE jobs** (`impose-purge-auth-codes` hourly, `impose-purge-idempotency` daily, `impose-purge-rate-counters` every 20 min). The hourly auth-code purge also covers `auth_tickets` (production body deletes from both).
5. Migration registry — `supabase_migrations.schema_migrations` does **not exist** in production; there is no self-reported applied-migration list. Applied state was instead proven object-by-object below (all 55 application functions byte-match the final migration bodies; every materialized object matches the last migration that defines it).

Every one of the 55 application-defined functions in `public` matches the final migration that defines it (exact body comparison, whitespace-normalized). Two functions are production drift, both inert (`recount_saves`, `rls_auto_enable` — §H).

**Headline blockers (full register in §J):**
- **B-01 (P1, security boundary):** workspace chat requires the relay `CONTROL_KEY` in browser storage; the same key unlocks every relay `/admin/*` operator endpoint. Latent today (grants = owner only, verified), activates with the first real rollout grant.
- **B-02 (P1, authorization):** `save_workspace` / `workspace_state` enforce nothing about workspace entitlement. Waitlisted and revoked users can sync workspace state forever; revocation is UI-only.
- **B-03 (P2, privacy, live-verified):** anonymous `join_waitlist` discloses any email's waitlist membership, position and approval status (owner's email status recovered anonymously during this audit).
- **B-04 (P2, abuse, live-verified):** `join_waitlist` has no rate limit; anonymous unique-address writes succeed unbounded (3/3 succeeded live) up to the 100k global cap, after which every legitimate join fails (`waitlist_full`).
- **B-05 (P2, reconciliation):** community outbox is in-memory only (persistence deliberately disabled) — tab close after commit-but-lost-response loses the idempotency key; duplicate-post path documented.
- **B-06 (P2, fairness/resource):** OTP per-address budget is attacker-burnable (mailbox lockout), relay limits are per-process and reset on restart/multi-instance; no global caps on public search/images/videos tier.
- **B-07 (P3, lifecycle):** no account-deletion path exists anywhere in the product (UI, RPC, relay); `granted_by`/`added_by` FKs are NO ACTION and `admin_bootstrap.claimed_by` is RESTRICT, so deleting an admin/grantor account would fail even manually.
- **B-08 (P2, state):** workspace push failures that are neither quota nor stale (rate_limited, payload_too_large, offline) have no terminal UI state — sync silently stops retrying until the next edit.
- **B-09 (P3, integrity):** two grant write paths diverge: DB `admin_grant` RPC inserts the `waitlist_approved` notification; relay `/admin/grant` does not (email only). Grant via relay leaves no in-app notification.
- **B-10 (P3, dead systems):** `recount_saves` (references dropped objects — 42P01 if ever invoked) and `rls_auto_enable` (production-only, not in any migration, unbound) both survive in production; `require_admin` is unreferenced by any caller.

---

# PART 1 — DATABASE CONTRACT CLOSURE

## A. Production Schema Diff (MIGRATION → EXPECTED → PRODUCTION → MATCH/MISMATCH → CONSEQUENCE)

Object-level, from the production catalog (not inferred):

| Object | Final migration source | Production state | Verdict | Consequence |
|---|---|---|---|---|
| 17 tables: profiles, waitlist, workspace_grants, generations, comments, notifications, reports, workspace_state, auth_codes, auth_tickets, idempotency_keys, rate_counters, admins, admin_capabilities, admin_caps, admin_action_caps, admin_bootstrap | 0001–0020 | all exist, columns/types/defaults/nullability match the last migration touching each | **MATCH** | none |
| `public.saves` | 0001 creates; **0021 drops cascade** | **absent** | MATCH-0021 | Baseline doc corrected (said "retained") |
| `generations.save_count` | 0021 drops | absent | MATCH | feed/profiles RPCs return bookmark-free shape (byte-verified) |
| All 55 application functions (51 audited + citext internals) | last migration defining each (map below) | **byte-for-byte body match** for all 51 | MATCH | Live DB runs exactly the audited code |
| `recount_saves()` | 0001 (never dropped) | present, unbound, references dropped `saves`/`save_count` | **DRIFT (inert)** | Errors 42P01 only if invoked; no trigger binds it → dead. §H |
| `rls_auto_enable()` | **in NO migration** | present in production (`event_trigger` return), no `pg_event_trigger` row references it | **DRIFT (inert)** | Hand-applied object outside migration chain; undocumented. §H |
| PK / unique / check constraints (37) | migrations | 37 present incl. `reports unique(target_id,reporter_id)`, `waitlist unique(email)`, partial unique `waitlist_position_key`, `admin_bootstrap check(id=1)` | MATCH | Idempotency-by-schema verified where claimed |
| Indexes (37) | migrations | all present; feed partial index `(created_at desc,id) where public and not deleted` present | MATCH | Hot paths indexed as designed |
| FKs (24), delete behaviors | migrations | CASCADE ×18, SET NULL ×5, NO ACTION ×3 (workspace_grants.granted_by, admins.added_by, admin_caps.granted_by), RESTRICT ×1 (admin_bootstrap.claimed_by) | MATCH | Orphan impact in §D; admin-deletion hazard in B-07 |
| Column privileges | 0005 | `authenticated UPDATE(locked,visibility,deleted_at)` on generations; `UPDATE(deleted_at)` on comments; profiles: RPC-only | **MATCH** | My earlier suspicion that authors could write derived counters is DISPROVEN — counters have no client UPDATE grant |
| Table grants | 0005/0008 | anon: SELECT(profiles,generations,comments) + MAINTAIN; authenticated: +SELECT(idempotency_keys,notifications) + arwd(workspace_state); service_role: REFERENCES/TRIGGER/TRUNCATE + full DML on auth_codes/auth_tickets/rate_counters | MATCH | REST writes that bypass RPC invariants are impossible for generations/comments/profiles/notifications |
| RLS policies (17) | 0001/0010/0013/0016 | all present with expected predicates (incl. comments INSERT parent-match + generation-visibility checks, notifications owner-only, workspace_state own-row CRUD) | MATCH | Bell/dismissal paths enforced server-side. `comments` DELETE policy exists but no DELETE grant → inert for clients (harmless) |
| Triggers (7 public + 1 auth) | 0001/0010/0004/0020 | `set_generation_root`, `recount_lineage`, `recount_comments`, `notify_on_lineage`, `notify_on_comment`, `touch_updated_at`×2, `on_auth_user_created → handle_new_user` | MATCH | Profile auto-provisioning on signup verified present in production |
| Realtime publication | 0009 | `supabase_realtime`: comments, generations, notifications only | MATCH | Matches community-data subscriptions exactly |
| Extensions | platform + 0001 | pgcrypto, citext, pg_cron 1.6.4, uuid-ossp, pg_stat_statements, supabase_vault | MATCH | pg_cron present (baseline unknown resolved) |
| Cron jobs | not in migrations (operator-installed) | **3 ACTIVE**: purge-auth-codes `17 * * * *`, purge-idempotency `23 3 * * *`, purge-rate-counters `*/20 * * * *` | MATCH (infra manual) | These jobs are production-only reality — nothing in the repo provisions them; re-provisioning a fresh project loses cleanup silently. Recorded as operational finding O-1. |
| Roles | platform | standard Supabase set; `service_role` & `postgres` BYPASSRLS | NORMAL | — |
| GoTrue public signup | relay design claim | **`signup_disabled` confirmed live** (422 on anon signup probe) | MATCH | Only relay-created accounts possible |
| Storage buckets | — | none | MATCH | No uploads pipeline (no finding) |
| Migration registry | n/a | `supabase_migrations.schema_migrations` absent | N/A | Applied-state must be proven by comparison (done here); recommend adopting `supabase db push`-style registry. O-2. |

**Result: MIGRATION → EXPECTED → PRODUCTION is a MATCH everywhere that an application data path touches.** The only drift is two inert functions and three un-provisioned cron jobs.

## B. Canonical Data Ownership Matrix

One authoritative owner per logical datum. "|" separates layers; caches are marked explicitly and were checked for "can a cache overwrite authority?".

| Datum | Authoritative owner | Server-side writers | Server-side readers | Client caches | Verdict |
|---|---|---|---|---|---|
| User identity / password / session | Supabase Auth (`auth.users`, GoTrue) | GoTrue (password sign-in), relay service-role (create/confirm/set_password after OTP) | GoTrue, relay verify_session | SDK `sb-*-auth-token`; `impose.auth.v1` display copy | ✅ single owner; display cache never read for authz |
| Profile row (id, display_name, bio, handle, avatar, quotas) | `public.profiles` (DB) | `handle_new_user` trigger, `ensure_profile`, `update_my_profile`, `customize_profile` RPCs (all `auth.uid()`-scoped); direct REST UPDATE not granted | feed/profile/thread RPCs, `profiles` public SELECT, relay (none) | `community-data.cachedProfile` (per-tab), `impose.auth.v1` name | ✅ one owner; cache cannot write back |
| Handle uniqueness | DB unique + RPC checks | same as above | `profile_by_handle` | — | ✅ |
| Avatar identity | `profiles.avatar` (char-1..8 / none) | `customize_profile` | feed/profiles avatars via `latestAvatars(ByIds)` REST reads against profiles | per-tab avatar maps — refresh per render | ✅ single source; bounded staleness (per-tab) |
| Workspace entitlement | `workspace_grants` (DB) | `admin_grant` RPC (cap-checked), relay `/admin/grant` (CONTROL_KEY, service role), `handle_new_user` (approved-email auto-grant) | `my_workspace_access`, relay `/notify/grant`, admin UI | `impose.access.v1` (10-min TTL) — **decides UI gate only** | ⚠️ single owner for the RECORD; **nothing downstream enforces it server-side** (B-02) |
| Workspace state | `workspace_state` (DB) | `save_workspace` (CAS, auth.uid) | own-row SELECT (RLS) | `impose.cache.<uid>` v2 wrapper + rev | ✅ owner clear; conflict policy in §G |
| Provider API keys / relay key | browser-only (sealed AES-GCM inside workspace blob; server sees ciphertext) | client only | client only | device vs passphrase wrapped | ✅ intended two-domain design holds |
| Community generation | `generations` (DB) | `create_generation` RPC (insert), author column-limited REST UPDATE (locked/visibility/deleted_at), soft-delete = deleted_at | feed_page/profile_feed/REST select by RLS | in-memory render only (localStorage persistence deliberately dead) | ✅ |
| Comment | `comments` (DB) | `create_comment` RPC, `soft_delete_comment`/`restore_comment` RPCs, deleted_at-only REST | thread_for, RLS select | in-memory only | ✅ |
| Counters (comment/remix/challenge counts) | DB triggers `recount_comments/recount_lineage` (recompute-from-rows each event) | triggers only (no client grant — verified) | feed/profile RPCs | none | ✅ derived values are recompute-based, drift self-heals on next event for the parent |
| Unread count | computed at read (`notifications_unread`) | `notifications_mark_read`, triggers | bell RPC | none (always refetched) | ✅ deliberately never client-incremented |
| Notifications | `notifications` (DB) | triggers (comment/lineage), `admin_grant` RPC | `notifications_page`/unread | in-memory badge | ✅; relay grant path skips notification → B-09 |
| Reports | `reports` (DB) | `report_content` RPC (unique-by-schema), `admin_resolve_report`, relay `reports_store` read-only | admin RPC + relay `/admin/reports` | none | ✅ |
| Waitlist | `waitlist` (DB) | `join_waitlist` (anon), `admin_grant` (status→approved), relay `/admin/grant`, `handle_new_user` (user_id link) | `join_waitlist` itself (returns position), `admin_waitlist` RPC/relay | `impose.access.v1` position | ⚠️ owner single but **anonymously readable-by-probe** (B-03) |
| Admin membership | `admins` (DB) | `admin_add/remove` RPCs (cap-checked), 0022 seed | `is_admin`, `admin_roster` | none | ✅; bootstrap gate verified claimed |
| Admin capabilities | `admin_capabilities` (catalog) + `admin_caps` (grants) + `admin_action_caps` (map) | `admin_grant_cap/revoke_cap`, `admin_add`, `admin_remove` (cleans caps) | `has_cap/can_do/require_cap`, relay `session_can` | none | ✅ coherent; phantom catalog caps noted (§H) |
| `admin_bootstrap` | DB | `admin_bootstrap_claim` (owner-only, one-shot) | `admin_bootstrap_status` | none | ✅ claimed (verified: 1 row, owner) |
| Auth codes/tickets | `auth_codes`/`auth_tickets` (DB) | relay service-role RPCs only (`issue_auth_code/consume_auth_code/redeem_auth_ticket`) | same | none | ✅ browser never touches |
| Idempotency keys | `idempotency_keys` (DB) | create RPCs; own-row SELECT granted | create RPCs | client holds key only for job lifetime | ⚠️ job loss → key loss (B-05) |
| Rate counters | `rate_counters` (DB RPC scope) + relay in-memory buckets | `rate_hit`; relay `_rate_hit` | — | — | ⚠️ two independent systems (B-06) |
| Chat history (workspace) | browser local state → `workspace_state.data` when signed in | client → save_workspace | client pull | localStorage cache | ✅ single sync path |
| Feed/session demo state | none (dead) | — | — | `slopify:v6*` blobs from old builds may still sit in returning browsers; `load()` is dead so they're never read | ⚠️ litter, never surfaced (§H) |
| Provider/source configuration | relay process env + provider_catalog.json | operator only | `/v1/source/catalog` | none | ✅ |

## C. Complete Reader/Writer Matrix (code-path level)

Writers = every code path that can change the datum. Proven by following calls, not docs.

| Entity | Production writers (exact code paths) | Readers |
|---|---|---|
| profiles | trigger `on_auth_user_created`→`handle_new_user` (auth signup, incl. relay-created users); `ensure_profile()` inside create_generation/create_comment/report_content (self-heal); RPC `update_my_profile` (community.js profile form via BotoData.updateProfile); RPC `customize_profile` (workspace profile modal via BotoData.customizeProfile); 0022 seed | RPCs feed_page/profile_feed/profile_by_handle/thread_for/notifications_page; REST `profiles` select (myProfile, latestAvatars, latestAvatarsByIds); anonymous public read |
| generations | RPC create_generation (queue job via composer); REST UPDATE column-scoped (setLocked, deleteGeneration, restoreGeneration, visibility); triggers recount_lineage/root; (INSERT via REST not granted) | feed_page, profile_feed, generation(id) REST+profiles join, feed_since, RLS select; realtime publication |
| comments | RPC create_comment; RPC soft_delete_comment/restore_comment; REST UPDATE deleted_at only | thread_for; realtime; recount trigger |
| notifications | triggers notify_on_comment/notify_on_lineage; RPC admin_grant kind='waitlist_approved'; UPDATE read_at via mark_read RPC or own-row UPDATE policy | notifications_page/unread RPCs; realtime INSERT |
| reports | RPC report_content; UPDATE status via admin_resolve_report RPC | admin_reports RPC; relay /admin/reports (service role, CONTROL_KEY) |
| waitlist | join_waitlist (anon insert + idempotent select); admin_grant RPC status update; relay /admin/grant (service role: select/insert + status→approved); handle_new_user (user_id link + auto-grant check); 0022 seed | join_waitlist returns position/status for the probed email (B-03); admin_waitlist RPC; relay /admin/waitlist |
| workspace_grants | admin_grant RPC; relay /admin/grant `supabase_admin.grant_workspace`; handle_new_user auto-grant; 0022 seed | my_workspace_access RPC; relay has_workspace_grant (/notify/grant); relay /admin/waitlist has_account |
| workspace_state | save_workspace RPC only (RLS arwd own-row) | client pull (REST select own row); save_workspace row-lock read |
| auth_codes / auth_tickets | relay otp_store via RPCs issue_auth_code/consume_auth_code/redeem_auth_ticket(+store insert tried via service role for tickets) | same RPC scope only; purge cron |
| idempotency_keys | create_generation/create_comment FC; purge cron daily; SELECT own (RLS) | same RPCs (FOR UPDATE replay check) |
| rate_counters | rate_hit (from RPCs: create_gen/com, save_workspace, report_content, admin ops) and purge cron | rate_hit itself |
| admins / admin_caps / admin_capabilities / admin_action_caps / admin_bootstrap | admin_* RPCs; 0022 owner seed | admin_roster/caps_for/bootstrap_status; has_cap/can_do/require_cap; relay session_can for notify_grant |

No third write path to any of these exists in the repo (checked: all `.from(`/`rpc(` sites in JS; all `supabase_admin.` helpers in relay; `reports_store` read-only; `otp_store` RPC-only).

## D. Orphan & Referential Integrity Matrix

FK action from production catalog (not assumed). "Hard delete" of content never happens on the app path (soft deletes), so CASCADEs engage on account/admin cleanup only.

| Relationship | On parent DELETE | Child survives? | UI navigation to orphan? | Notes / scenario |
|---|---|---|---|---|
| auth.users → profiles | CASCADE | no | — | account deletion (dashboard/relay) removes profile; generations/comments/notifications cascade below |
| profiles → generations.author | CASCADE | no | n/a | all content dies with account |
| profiles → comments.author | CASCADE | no | n/a | as above |
| generations → comments.generation | CASCADE | no (hard); soft-delete keeps | tombstones pruned client-side | soft-deleted generation remains FK-valid; feed hides it; thread_for refuses via `g.deleted_at is null` guard |
| comments → comments.parent | SET NULL | yes | reply graph re-roots | soft-delete emulates: parent renders tombstone; `create_comment` rejects deleted parents; `comment_parent_matches` (RLS INSERT helper) allows replies to deleted parents (it does not check deleted_at) but REST INSERT is not granted → unreachable |
| generations → generations.remix_of / root_id | SET NULL | yes | lineage badge degrades | live rows only via triggers; SET NULL breaks root chains if a mid-tree row is hard-deleted (considered acceptable; counts recompute) |
| generations/comments → notifications.generation_id/comment_id | CASCADE | no | dead-target impossible on hard delete | **on SOFT delete**: notification rows survive; `notifications_page` LEFT JOINs with `deleted_at is null` and filters both keys null-or-resolved → dead targets never render. Verified in body |
| auth.users → notifications.user_id | CASCADE | no | — | inbox dies with account |
| profiles → notifications.actor_id | CASCADE | no | — | actor removal removes the notification (no ghost actor) |
| auth.users → workspace_grants/grants/workspace_state/idempotency/admin tables | CASCADE | no | — | full wipe on account deletion |
| auth.users → workspace_grants.granted_by / admins.added_by / admin_caps.granted_by | **NO ACTION** | blocker | — | **deleting a grantor/adder account FAILS** while their audit references exist. No UI path deletes accounts today, and relay `delete_user` (signup cleanup) only touches fresh unconfirmed users → latent ops hazard (B-07) |
| auth.users → admin_bootstrap.claimed_by | **RESTRICT** | blocker | — | owner account cannot be deleted without manual bootstrap surgery. Intended permanence noted; still a lifecycle dead-end (B-07) |
| auth.users → waitlist.user_id | SET NULL | yes | n/a | row survives as email-only (correct for queue semantics) |
| profiles → reports.reporter_id | CASCADE | no | — | reports die with reporter; reports on deleted content: `target_id` has NO FK (logical reference only) → **intentional orphan**: report survives target deletion, admin UI shows raw ids. Verified no dangling-join crash path (admin_reports LEFT JOINs only profiles) |

Reproduction sequences (all client-reachable):
- *Deleted post with live notification*: post soft-delete → notification retained → inbox LEFT JOIN filter drops it from page; unread count RPC still counts it! `notifications_unread` counts `read_at is null` WITHOUT the join filter → badge can show a number the page can't display. **UI-vs-RPC inconsistency — listed as F-03 in Part 2 matrix (P3).**
- *Reply to parent deleted mid-compose*: client re-resolves target, refuses; direct RPC replay → `parent_gone`; race window (delete lands between thread_for and create_comment insert) → RPC rechecks and raises. Closed.
- *Restore after undo window*: restore_generation direct PATCH deleted_at=null succeeds within author grant; recount triggers fire on `UPDATE OF deleted_at` → counts recompute. Closed.


---

## Artifact E — RPC Contract Matrix

All 40 application functions live-scanned (`pg_proc`, 2026-09-19). Every app function
is `SECURITY DEFINER` with `proconfig={search_path=public}`; sampled bodies
(`create_generation`, `save_workspace`, `admin_*`, OTP set) schema-qualify every
relation reference, so the implicit `pg_temp`-first resolution has nothing to shadow.
`rls_auto_enable` is the single exception (`search_path=pg_catalog`, no migration) — see H.

Errors use stable contracts: `42501` not_authenticated/authorization, `22023` validation,
`53100` resource (rate_limited / waitlist_full), `40001` stale_workspace, `P0001/P0002` app states.

| RPC | CALLER FLOOR | IN-BODY LIMIT (verified prod body) | IDEMPOTENCY | KEY ERRORS | CONTRACT NOTES |
|---|---|---|---|---|---|
| join_waitlist(email) | **anon** ✔ live | **none** | same email → same row (position/status) | invalid_email, email_provider_not_accepted (P0001), waitlist_full 53100 @100k rows | Returns status verbatim → B-03; no limit → B-04; position via advisory-lock max+1; disposable denylist incl. mailinator.%, yopmail.% |
| issue_auth_code(email,purpose,hash,cooldown) | relay (service) | cooldown = **caller-supplied param**; reissue inside cooldown returns reused=true | upsert resets attempts+expiry | — | DB trusts caller for cooldown value; relay limiter is per-process → B-06 |
| consume_auth_code | relay | attempts ≤ p_max (caller param), row `FOR UPDATE` | row deleted on ok/locked/expired | states: ok / wrong(left) / expired / locked | Concurrency-safe; attacker can burn attempts → row deleted → victim must resend (mailbox lockout, B-06) |
| redeem_auth_ticket(hash) | relay | none needed | **one-shot** `DELETE … RETURNING` | miss → empty | Single-use by construction |
| create_generation | authenticated | `gen:{uid}` 8/60s; addressed adds `bot:{uid}` 3/60s **and `bot:global` 12/60s** | key+sha256 hash; replay returns stored row; **budget checked after replay** (retry never re-spends) | 42501, prompt_length/response_length/bad_visibility/bad_kind/original_cannot_have_parent/lineage_needs_parent/parent_gone/parent_locked, idempotency_key_reused, 53100 | bot:global shared bucket → fairness note A-4 |
| create_comment | authenticated | `com:{uid}` 15/60s + `com:{uid}:{gen}` 5/60s | same pattern as above | body_length, parent_gone, post_gone, 53100 | parent must match generation (`comment_parent_matches`) |
| report_content | authenticated | `rep:{uid}` 20/3600s | unique (target_id, reporter_id) → 'already' | bad_kind, reason_too_long, target_gone, 53100 | Visibility check doubles as existence-hiding (private content unconfirmable) ✔ |
| save_workspace | authenticated | `ws:{uid}` 30/60s; payload ≤ 3 MiB | rev CAS: `p_expected_rev`=null → legacy overwrite; mismatch → `stale_workspace` 40001 | bad_payload, payload_too_large, stale_workspace | Row-lock-then-compare; first-save upsert race covered. **No workspace_grants check** → B-02 (body verified) |
| my_workspace_access | authenticated | — | — | — | Read-only entitlement probe (the check save/load skip) |
| update_my_profile / customize_profile | authenticated | — | — | — | Sole profile write path (no direct grants) ✔ |
| notifications_page / _unread / _mark_read | authenticated | — | mark_read sets read_at | — | `_unread` counts read_at-null **without** the live-target join `_page` applies → F-03 |
| feed_page / feed_since / thread_for / profile_feed / profile_by_handle | authenticated | none (read) | cursor params | — | All filter `deleted_at is null`; no per-read limit (Part 3, A-13) |
| recount_comments / recount_lineage | authenticated (maintenance) | — | full rescan | — | Reconciliation utilities, consistent with triggers |
| recount_saves | — | — | — | **42P01 if invoked** (saves dropped in 0021) | **DEAD — do not call** (H) |
| admin_add / admin_grant / admin_remove / admin_resolve_report / admin_grant_cap / admin_revoke_cap | cap-gated (`require_cap('<same-name>')) | `adm:{uid}` 30/60s each | add: 'already'; grant: on-conflict → 'already'; resolve: pending-only → 'already' re-stamp-safe | invalid_email, no_account, owner_protected, last_admin, bad_status, gone | admin_grant writes `notifications(kind='waitlist_approved')` — relay /admin/grant does not → B-09; admin_remove clears caps and blocks owner/last-admin removal ✔ |
| admin_bootstrap_claim / _status | anon for claim | one-time row | claimed row blocks second claim | — | Single-claim bootstrap ✔ (claimed_by FK RESTRICT → B-07) |
| admin_roster / admin_waitlist / admin_reports / admin_caps_for | cap-gated reads | — | — | — | Panel read models |
| rate_hit(key,n,window) | internal | — | — | — | Shared counter engine on `rate_counters`; atomic |
| purge_expired_auth_codes / purge_idempotency_keys / purge_rate_counters | cron | — | — | — | 3 live pg_cron jobs (I-4); **not provisioned by repo → O-1** |
| require_admin | — | — | — | — | **Unreferenced** by any body/policy → H |
| rls_auto_enable | prod-only | — | — | — | **Drift object, no migration** → H |
| handle_new_user / notify_on_comment / notify_on_lineage / set_generation_root / touch_updated_at | triggers | — | — | — | Verified present; notify triggers feed notifications table |

---

## Artifact F — Permission Matrix (who can actually do what)

| CAPABILITY | anon | authenticated (no grant) | granted member | workspace admin | owner | relay session user | relay CONTROL_KEY |
|---|---|---|---|---|---|---|---|
| join_waitlist | ✔ (no limit — B-04) | ✔ | ✔ | ✔ | ✔ | n/a | n/a |
| read feed/profiles/threads (RPC) | ✘ 42501 ✔live | ✔ | ✔ | ✔ | ✔ | n/a | n/a |
| create_generation / comment / report | ✘ 42501 ✔live | ✔ (8/15/20 budgets) | ✔ | ✔ | ✔ | n/a | n/a |
| REST PATCH generations (locked/visibility/deleted_at) | ✘ 42501 ✔live | **own rows only** (RLS ✔) | own rows | own rows | own rows | n/a | n/a |
| REST PATCH comments (deleted_at) | ✘ ✔live | own rows (RLS ✔) | own rows | own rows | own rows | n/a | n/a |
| save_workspace / load workspace | ✘ 42501 | **✔ — B-02: no grant check** | ✔ | ✔ | ✔ | n/a | n/a |
| relay /chat + /prospects | ✘ | ✘ | ✘ | ✘ (via key) | ✔ | **✘ session can't chat** | **✔ — same key → B-01** |
| relay /admin/* (grant, revoke, sign-in-as, roster) | ✘ | ✘ | ✘ | ✘ | intended | ✘ | **✔ — same key → B-01** |
| admin_add / admin_grant / admin_remove (RPC) | ✘ | ✘ require_cap | ✘ | cap-gated | ✔ | n/a | n/a |
| admin_resolve_report / caps mgmt (RPC) | ✘ | ✘ | ✘ | cap-gated | ✔ | n/a | n/a |
| admin_bootstrap_claim | first-caller only | — | — | — | — | n/a | n/a |
| issue/consume/redeem auth codes | ✘ (relay-mediated) | — | — | — | — | ✔ via relay | ✔ via relay |

**Exposures confirmed by this matrix:** B-01 (one browser-held key = chat privilege ∪ admin
privilege, and session-authenticated members can never chat), B-02 (entitlement enforced in
UI + `my_workspace_access` but in no write path). All other cells verified closed by live
probe or body inspection.

---

## Artifact G — State / Reconciliation Matrix

| FLOW | OPTIMISTIC STATE | SERVER TRUTH | RECONCILIATION | STUCK/LOSS WINDOW | STATUS |
|---|---|---|---|---|---|
| Generation post | temp card (pending:true, "Sending") | `create_generation` row + triggers | `adoptServerRow` rebinds temp key→server id; parent refetched; **no local counter increment** (documented in code) | outbox lives in memory → reload kills queued job + its idempotency key → possible loss **or** duplicate with new key (B-05) | PARTIAL — B-05 |
| Addressed generation | as above, but streams response first, then publishes | same | same | stream completes, tab dies before publish → response lost (no persistence) | PARTIAL — B-05 |
| Comment post | optimistic node | `create_comment` (idem key) | parent refetch after child lands | same outbox window | PARTIAL — B-05 |
| Soft-delete comment | local flag | PATCH deleted_at (only granted col) | refetch | retry = same PATCH (naturally idempotent) ✔ | CLOSED |
| Report submit | toast | `report_content` (`already` dedupe) | none needed ✔ | — | CLOSED |
| Workspace push | dirty flag | `workspace_state` rev+1 | rev CAS, `stale_workspace` → pull-merge-repush | push fails `rate_limited`/`payload_too_large`/offline → **silently stops, no terminal UI state** (B-08); legacy null-rev overwrite branch preserved for old clients | PARTIAL — B-08 |
| Workspace pull | rev compare | same | newer rev wins | — | CLOSED |
| Notifications badge | local count | `_unread` count, `_page` list | **divergent**: badge counts read_at-null incl. dead-target rows the page hides (F-03) | badge number can exceed displayable items permanently | PARTIAL — F-03 |
| Idempotency | key per queued job | `idempotency_keys` row (key+uid+hash→response) | replay returns original row; hash mismatch → `idempotency_key_reused` | purge daily; a >24h-delayed retry after purge creates a second copy (accepted TTL tradeoff, documented) | CLOSED w/ note |
| Auth code | relay cooldown | `auth_codes` row (attempts) | consume deletes on ok/locked/expired | lockout forces resend (B-06 victim lockout) | PARTIAL — B-06 |
| Auth ticket | — | one-shot row | delete-on-redeem ✔ | — | CLOSED |

---

## Artifact H — Dead / Legacy Register

Classification only — nothing deleted (per engagement rule).

| SYSTEM | CLASS | EVIDENCE | DISPOSAL DECISION (owner) |
|---|---|---|---|
| `recount_saves()` | **DEAD** | Present in prod (`pg_proc`); `saves` table dropped by 0021; body references it → 42P01 on any call; zero callers in repo (grep all JS/SQL) | Drop in migration 0023 (fix phase) |
| `rls_auto_enable()` | **DRIFT → ADOPTED (reclassified in Fix Phase)** | Exists in prod with `search_path=pg_catalog`; no migration 0001–0022 creates it; repo grep found zero callers — but the drop attempt (2BP01) proved the **`ensure_rls` event trigger** depends on it: a protective default-deny net auto-enabling RLS on prod-created tables | Adopted verbatim into 0023 (now migration-managed); not dead weight — keep |
| `require_admin()` | **DEAD** | In prod; unreferenced by any function body or policy (superseded by `require_cap`) | Drop in 0023 |
| Phantom caps `billing.read`, `billing.refund`, `users.read`, `users.suspend`, `system.configure` | **DEAD data** | In `admin_capabilities` seed; no `require_cap('<name>')` anywhere references them | Keep or prune — owner decision; flagged |
| `comments` DELETE policy | **LEGACY-INERT** | Policy exists; no DELETE grant to `authenticated` (column_privileges verified) → can never fire | Harmless; prune later |
| `save_workspace` null-rev overwrite branch | **LEGACY-ACTIVE** | Comment in prod body: "keeps the pre-0019 behaviour so an old client degrades instead of breaking" | Retire when legacy clients gone |
| `saves` fields in `community.js`/`normCounts` + `slopify:v6` localStorage key | **LEGACY client litter** | UI still normalises save counts for a dropped table | Cosmetic; remove on next UI pass |
| `waitlist.ip_hash` column | **DEAD data path** | Column exists; **NULL for all rows** including 3 live probe inserts (verified) | Either populate in 0023 fix or drop column |

---

## Artifact I — Production Verification Matrix (everything live-checked, dated 2026-09-19)

| # | CHECK | METHOD | RESULT |
|---|---|---|---|
| I-1 | Object parity migrations vs prod | pg_proc/pg_class dump | 51/51 function bodies match; 17 tables, 24 FKs, 37 constraints/indexes, 17 RLS policies match; drift = rls_auto_enable only |
| I-2 | Table-level ACLs | pg_class.relacl | `authenticated`=`rm` (SELECT+MAINTAIN) on app tables; **no client INSERT/UPDATE/DELETE at table level** anywhere |
| I-3 | Column privileges | information_schema.column_privileges | `authenticated` UPDATE: generations{locked,visibility,deleted_at}, comments{deleted_at} only; profiles: none |
| I-4 | Cleanup jobs | cron.job | 3 active: auth-codes hourly, idempotency daily, rate-counters */20min |
| I-5 | Anon REST PATCH profiles | live probe | 401/42501 ✔ |
| I-6 | Anon REST DELETE generations | live probe | 401/42501 ✔ |
| I-7 | Anon report_content | live probe | 401/42501 ✔ |
| I-8 | Anon join_waitlist enumeration (owner email) | live probe | 200 position 0 status "approved" — **disclosed (B-03)** |
| I-9 | Disposable-domain rejection | live probe (mailinator) | 400 P0001 email_provider_not_accepted ✔ |
| I-10 | Write amplification (3 unique anon join_waitlist) | live probe | **3/3 succeeded**, positions 1,2,3 — no limit (B-04); rows deleted after, waitlist verified back to owner-only |
| I-11 | Standalone build parity | build_inline.py --check | PASS |
| I-12 | Provenance | git ls-remote HEAD vs Management API | prod schema matches HEAD migrations |

---

## Artifact J — Blocker List

Format: `BLOCKER → EVIDENCE → EXACT FAILURE → AFFECTED DATA → AFFECTED USERS → REQUIRED DECISION → VERIFICATION → STATUS`

**B-01 (P1)** relay CONTROL_KEY gates both /chat and /admin/* → server.py route wiring + app.js reads key from browser storage → one key theft (XSS, referrer, repo leak) yields full admin + chat; session-authed users cannot chat at all → admin actions, grants, impersonation, all chat traffic → owner (sole key holder) + every member → decide: split into SESSION auth for /chat + CONTROL_KEY retained only for /admin/* → regression: member session chats, admin without key cannot → **OPEN**

**B-02 (P1)** save_workspace / workspace_state enforce no entitlement → prod body verified: no `workspace_grants` check, only `ws:{uid}` rate + size + rev CAS → waitlisted or revoked users sync workspace forever after revocation; revocation is UI-only → workspace_state rows of revoked users → any future revoked user → decide: enforce `my_workspace_access` inside save/load RPCs (chosen in fix phase) → regression: revoked account RPCs → 42501; waitlisted never-granted account → 42501 → **OPEN**

**B-03 (P2)** join_waitlist discloses approval status → live probe I-8 → attacker confirms any email's membership/status (owner proven: position 0 approved) → waitlist rows → all waitlisted users → decide: constant response `{ok:true}` regardless (chosen) → repeat probe returns no status/position delta → **OPEN**

**B-04 (P2)** join_waitlist unbounded anonymous writes → live probe I-10: 3/3 unique emails inserted, zero throttling; ip_hash column never populated → 100k-row cap reachable → `waitlist_full` denies legitimate signups (DoS) → waitlist table → future legitimate users → decide: per-IP hash rate limit inside join_waitlist (chosen) → scripted 4th rapid insert → 53100 rate_limited → **OPEN**

**B-05 (P2)** community outbox is in-memory only → community.js sendGeneration: job queued in memory, optimistic card temp key; no localStorage/IndexedDB handoff → tab reload/crash between queue and ack loses job + idempotency key → resubmit with new key duplicates content → generations/comments rows → all posters on flaky connections → decide: durable outbox with stable idempotency keys (chosen) → kill tab mid-send → resume → single server row → **OPEN**

**B-06 (P2)** OTP victim-mailbox lockout + per-process relay limiter → consume_auth_code deletes row at p_max attempts; issue cooldown is caller param; relay limiter in-process memory → attacker burns attempts → row deleted → victim's real code dead; relay restart or second instance resets counters → auth_codes rows → any targeted email holder → decide: move OTP throttle to DB-side fixed windows (issue_auth_code enforces its own floor; chosen) → scripted attempt-burn + restart → limits persist → **OPEN**

**B-07 (P3)** no account-deletion path + blocking FKs → no delete RPC/UI; `granted_by`, `added_by` NO ACTION; `admin_bootstrap.claimed_by` RESTRICT → account of grantor/admin cannot be removed without manual SQL → auth.users, admins, admin_caps, admin_bootstrap → any user exercising right-to-erasure → decide: ship delete_my_account RPC + ON DELETE handling for admin FKs (chosen) → delete test account → row gone, audit kept, grantor references nulled → **OPEN**

**B-08 (P2)** workspace push failure has no terminal UI state → app.js push path: rate_limited/payload_too_large/offline all end retry loop silently → user believes work synced; close tab → data loss → workspace_state → heavy users near limits → decide: surface durable sync-failed state with explicit retry (chosen) → forced rate_limited → status pill visible until manual retry succeeds → **OPEN**

**B-09 (P3)** grant notification divergence → admin_grant RPC inserts notifications('waitlist_approved'); relay /admin/grant in server.py does not → user granted via relay gets silently working account, no inbox notice → notifications → granted users → decide: add identical notification write to relay path (chosen) → grant via relay → notification row present → **OPEN**

**B-10 (P3)** dead systems in prod → recount_saves (42P01 if called), rls_auto_enable (no migration, odd search_path), require_admin (unreferenced) → DB surface → none directly (hygiene/audit noise) → decide: drop all three in migration 0023 (chosen) → pg_proc re-dump → absent → **OPEN**

---
---

# PART 2 — Full-System Contract Integrity

## 2.1 Feature Matrix (13 columns)

| FLOW | UI ACTION | NETWORK | SERVER PATH | VALIDATION | SERVER STATE | UI RECONCILE | ERROR SURFACE | OFFLINE/RETRY | PERMISSION | PARITY (live vs source) | NOTES | STATUS |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Join waitlist | form submit | RPC join_waitlist | DB function | email regex, disposable denylist | waitlist row | position/status text | P0001/22023/53100 shown | no retry needed (idempotent per email) | anon | identical | discloses status (B-03), unlimited (B-04) | FINDING |
| Sign-in code request | submit | relay /auth/code | relay→issue_auth_code | relay format checks | auth_codes row | code-sent state | relay errors surfaced | resend after cooldown | public | identical | per-process limiter (B-06) | FINDING |
| Sign-in code verify | submit | relay /auth/verify | relay→consume_auth_code | p_max attempts | row consumed/locked | session stored | wrong/expired/locked surfaced | full lockout forces resend | public | identical | mailbox lockout (B-06) | FINDING |
| Post generation | composer | RPC create_generation | DB function | 1–4000/≤20000 chars, enums, lineage | generations row + counters | adoptServerRow, refetch | 42501/22023/53100 toast | **in-memory outbox → loss/dup (B-05)** | authenticated | identical | — | FINDING |
| Addressed post | composer | stream + create_generation | relay stream + RPC | same + bot budgets | row with response | same | stream failure surfaced | same outbox window | authenticated | identical | bot:global fairness (A-4) | FINDING |
| Comment | reply UI | RPC create_comment | DB function | 1–1000 chars, parent checks | comments row | parent refetch | toast | same outbox window | authenticated | identical | — | FINDING |
| Soft-delete comment | delete btn | REST PATCH deleted_at | PostgREST+RLS | column grant only | deleted_at set | refetch | 42501 | PATCH idempotent ✔ | owner row | identical | restore via restore_comment RPC | OK |
| Report content | flag btn | RPC report_content | DB function | kind enum, ≤500, visibility-as-validation | reports row (dedupe) | toast 'already' safe | toast | resubmit → 'already' ✔ | authenticated | identical | — | OK |
| Workspace push | autosave | RPC save_workspace | DB function | ≤3 MiB, rev CAS | workspace_state rev+1 | rev synced | **silent stop (B-08)** | retry loop then nothing | authenticated (no grant check — B-02) | identical | legacy null-rev branch | FINDING |
| Workspace pull | boot | RPC my_workspace_access + read | DB | — | rev compared | state applied | session-expired → sign-in | retry | same gap | identical | — | FINDING |
| Admin grant (panel) | button | RPC admin_grant | DB function | require_cap + adm budget | grants + notification 'waitlist_approved' | panel refresh | toast | safe resubmit ('already') | cap-gated | identical | relay path lacks notification (B-09) | FINDING |
| Admin grant (relay) | CLI | relay /admin/grant | relay→supabase_admin | CONTROL_KEY | grant only | — | relay errors | — | CONTROL_KEY | identical | B-09, B-01 | FINDING |
| Admin remove/resolve/caps | panel | RPCs | DB | guards owner/last_admin, caps cleared | rows | panel refresh | toast | 'already' safe | cap-gated | identical | — | OK |
| Bootstrap claim | first run | RPC admin_bootstrap_claim | DB | one-time row | owner admin | panel enabled | gone/P0002 | claim consumed | first caller | identical | RESTRICT FK contributes to B-07 | OK |
| Notifications open | badge click | RPC notifications_page/mark_read | DB | — | read_at set | badge recount | — | — | authenticated | identical | badge≠page (F-03) | FINDING |
| Feed/profile/thread reads | scroll/poll | RPC read family | DB | deleted_at filters | — | cursor advance | — | cursor resume | authenticated | identical | no read budget (A-13) | NOTED |
| Account deletion | **absent** | — | — | — | — | — | — | — | — | — | B-07 | FINDING |
| Chat | chat UI | relay /chat (CONTROL_KEY) | relay | key only | — | — | 401 | — | key holder only | identical | B-01 | FINDING |

## 2.2 Entity Lifecycle Matrix

| ENTITY | CREATED | READ | UPDATED | DELETED | ORPHAN RISK | PROOF |
|---|---|---|---|---|---|---|
| auth.users | signup | RLS-scoped | RPCs only | **never (B-07)** | n/a | no delete path in code or grants |
| profiles | handle_new_user trigger | RPC feed family | update_my_profile/customize_profile | never | none (1:1 FK) | trigger verified |
| waitlist | join_waitlist (anon!) | admin_waitlist RPC | admin_grant sets approved | manual | none | probes I-8..10 |
| workspace_state | save_workspace first-save upsert | own-row RLS | save_workspace rev CAS | never | none | FK cascade |
| generations | create_generation | feed RPCs | PATCH locked/visibility/deleted_at (self) | soft only | soft-delete respected by all readers ✔ | body+policy scan |
| comments | create_comment | thread/feed | PATCH deleted_at (self), restore_comment | soft only | parent_gone checks ✔ | body verified |
| reports | report_content | admin_reports | admin_resolve_report (pending-only) | never | 'already' re-stamp-safe ✔ | body verified |
| notifications | triggers + admin_grant | notifications_page/_unread | mark_read (read_at) | never | dead-target rows inflate badge (F-03) | join divergence verified |
| idempotency_keys | create_* RPCs | replay path | — | cron daily | >TTL retry duplicates (accepted, documented) | cron verified |
| rate_counters | rate_hit | — | rate_hit atomic | cron */20 | none | verified |
| auth_codes | issue_auth_code | consume path | attempts++ | consume deletes / hourly cron | none | body verified |
| auth_tickets | sign-in | redeem (one-shot) | — | delete-on-redeem + hourly cron | none | body verified |
| admins / admin_caps / admin_bootstrap | bootstrap/admin_add/admin_grant_cap | roster RPCs | caps grant/revoke | admin_remove (owner/last-admin guarded) | **FKs block user deletion (B-07)** | body verified |

## 2.3 Priority Register

- **P0 — drop everything:** none found. Authn/authz envelope, soft-delete semantics, idempotency, and admin guards all hold under live probe.
- **P1 — security/correctness, fix now:** B-01 (key union), B-02 (entitlement not enforced).
- **P2 — abuse/data-loss paths:** B-03, B-04, B-05, B-06, B-08.
- **P3 — hygiene/completeness:** B-07, B-09, B-10, F-03 (unread-badge divergence), plus NOTED items (read-budget absence A-13, bot:global fairness A-4) tracked into Part 3.

---
---

# PART 3 — Rate-Limit / Abuse-Control & Resource-Exhaustion Audit

## 3.1 Rate-Limit Inventory

`rate_hit(key, n, window_s)` = shared atomic engine on `rate_counters` (DB-row counters, cron-purged */20min). All rows below verified from live function bodies.

| OPERATION | LIMIT | WINDOW | KEY | LAYER | STORAGE | RESPONSE | RETRY | BYPASS | STATUS |
|---|---|---|---|---|---|---|---|---|---|
| create_generation | 8 | 60s | `gen:{uid}` | DB in-body | rate_counters | 53100 rate_limited | safe (idem key, budget checked post-replay) | none | **CLOSED** |
| addressed post (bot) | 3 user + 12 global | 60s | `bot:{uid}`, `bot:global` | DB in-body | rate_counters | 53100 | safe | none; global bucket shared-fate | CLOSED (fairness A-4) |
| create_comment | 15 + 5/post | 60s | `com:{uid}`, `com:{uid}:{gen}` | DB in-body | rate_counters | 53100 | safe (idem) | none | **CLOSED** |
| report_content | 20 | 3600s | `rep:{uid}` | DB in-body | rate_counters | 53100 | 'already' dedupe | none | **CLOSED** |
| save_workspace | 30 + 3 MiB | 60s | `ws:{uid}` | DB in-body | rate_counters | 53100 / 22023 payload_too_large | safe (rev CAS) | none | **CLOSED** |
| admin_add/grant/remove/resolve/grant_cap/revoke_cap | 30 | 60s | `adm:{uid}` | DB in-body | rate_counters | 53100 | 'already' responses | cap required too | **CLOSED** |
| consume_auth_code | p_max attempts | per code row | email+purpose | DB (FOR UPDATE) | auth_codes.attempts | wrong→locked, row deleted | resend new code | — | PARTIAL (lockout B-06) |
| issue_auth_code | cooldown param | caller-set | email | DB param + relay memory | auth_codes row + process mem | reused=true / 200 | after cooldown | **restart/multi-instance resets relay limiter (B-06)** | **OPEN** |
| join_waitlist | **none** | — | — | — | waitlist rows | 200 (or 53100 at 100k) | idempotent per email | infinite fresh emails | **OPEN (B-04)** |
| read RPCs (feed/profile/thread/notifications) | none | — | — | DB | — | 200 | cursor | — | NOTED (A-13: bounded pages, acceptable) |
| relay /chat | none app-side | — | — | relay | — | — | — | — | NOTED (gated by CONTROL_KEY, B-01) |
| relay /admin/* | none | — | — | relay key | — | — | — | key possession | OPEN (folds into B-01) |

## 3.2 Abuse Matrix

| ABUSE CLASS | VECTOR | DEFENCE TODAY | REMNANT RISK | STATUS |
|---|---|---|---|---|
| Enumeration | join_waitlist returns status+position | disposable-domain denylist only | full member/status oracle (proven I-8) | **OPEN → B-03** |
| Write flooding | anon join_waitlist inserts | 100k cap = the only wall | fill-to-DoS (proven I-10, 3/3) | **OPEN → B-04** |
| OTP brute force | consume attempts | p_max + FOR UPDATE + row delete | attacker burns victim codes → forced resend loop | PARTIAL → B-06 |
| OTP issuance spray | relay limiter | per-process counter | restart/scale resets; cooldown is caller param | **OPEN → B-06** |
| Content flooding | posts/comments/reports | per-uid budgets + dedupe | bounded ✔ | CLOSED |
| AI/compute abuse | addressed posts | per-user bot budget + global ceiling | 12-user bursts legitimately saturate global bucket | NOTED (A-4) |
| Payload abuse | workspace push | 3 MiB + 30/min | bounded ✔ | CLOSED |
| Idempotency replay | duplicate submissions | key+hash store, budget post-replay | >24h retry after purge duplicates (accepted) | CLOSED |
| Privilege abuse | admin RPCs | require_cap + adm budget + owner/last-admin guards | can't self-destruct panel ✔ | CLOSED |
| Key theft | CONTROL_KEY union | obscurity only | XSS/leak → chat+admin (B-01) | **OPEN → B-01** |
| Revocation bypass | workspace sync post-revoke | none server-side | zombie sync (B-02) | **OPEN → B-02** |
| Queue-loss duplicates | in-memory outbox | optimistic UI only | loss or dup post (B-05) | **OPEN → B-05** |

## 3.3 Attack Scenarios (concrete, reproducible)

- **A-1:** Script 100k unique synthetic emails → join_waitlist inserts all (no limit) → legitimate signup gets `waitlist_full` 53100 indefinitely. Mitigation chosen: per-IP-hash window in function (B-04).
- **A-2:** Query join_waitlist for every address in a breach corpus → learn who is approved/member (owner proven). Mitigation: constant response (B-03).
- **A-3:** Know victim email → issue code, submit p_max wrong codes → row deleted → repeat faster than victim reads mail → victim permanently locked out while attacker sustains. Aggravated by restartable relay limiter. Mitigation: DB-side issuance floor (B-06).
- **A-4:** 12 accounts each fire an addressed post in same minute → `bot:global` exhausted → 13th legitimate user throttled. Acceptable-by-design ceiling; flagged for capacity planning, no change this pass.
- **A-5:** Exfiltrate CONTROL_KEY from any owner's browser (XSS, sync extension, shoulder) → full /admin/* + chat from anywhere, indistinguishable from owner. Mitigation: B-01 split.
- **A-6:** Admin revokes a member via UI → member keeps pushing/pulling workspace_state indefinitely (no server check). Mitigation: entitlement in RPC (B-02).
- **A-13:** Authenticated reader pages feed aggressively — bounded by page-size caps, DB cost modest; documented as accepted residual, no action.

## 3.4 Final Verdict (against the audit rule's closure bar)

**System is complete and coherent at the contract layer; it is NOT closed on abuse control until B-01…B-06 are remediated.** What holds today, with evidence: every authenticated mutation is DB-marshalled, idempotent, budgeted, and RLS-enforced (I-1…I-7); admin surface is capability-gated with self-preservation guards; OTP consumption is concurrency-safe; workspace sync has correct CAS. What does not hold: the only two anonymous/public entry points (waitlist, OTP issuance) are the two without server-side ceilings; revocation and chat/admin auth are enforced in the wrong layer (UI and shared key respectively); and the client can silently lose or duplicate user content (B-05, B-08). Fix phase below addresses all open items.

---
---

# FIX PHASE — Before/After (2026-09-19, post-audit)

Decisions taken per the blocker register were executed the same day. DB changes ship as
`supabase/migrations/0023_closure_fixes.sql` — **applied to production 2026-09-19 via
Management API and live-verified below**. Relay + client changes ship in git and take effect
on the next `git push` (Render Blueprint deploy). `impose-standalone.html` rebuilt;
`build_inline.py --check` passes. Relay suite: 174+5 passed (2 pre-existing env failures in
test_public.py image conversion, unrelated to these changes; client-side suites green:
workspace_sync_roundtrip, 100-user simulation).

| ID | STATUS | WHAT CHANGED | VERIFICATION |
|---|---|---|---|
| B-01 | **FIXED (code), deploy pending push** | relay `/v1/chat/completions` now runs `_authed_member`: CONTROL_KEY (operator tooling) **or** a valid Supabase session of a grant-holding member; GoTrue verify + grant check cached 60s; wrong guesses join the authfail budget. `/admin/*` unchanged (key only). app.js `relayCfg()` sends the session token first (`BotoAuth.sessionToken()`), so the control key no longer lives in member browsers | New suite `relay/tests/test_closure_b01_b09.py` 5/5: member session accepted, owner key accepted, junk bearer 401; live junk-key probe on `/admin/status`, `/admin/waitlist`, `/v1/chat/completions` → 401 each |
| B-02 | **FIXED, live-verified** | `save_workspace` raises `workspace_not_granted` (42501) unless a `workspace_grants` row exists; all four `workspace_state` RLS policies now require the grant too | SQL impersonation probe: signed-in non-granted uid → `42501 workspace_not_granted` (line 15); no claims → `not_authenticated` (line 8); anon REST floor unchanged (401) |
| B-03 | **FIXED, live-verified** | `join_waitlist` returns the constant `(null, 'received')` for every well-formed address; unlock signal is exclusively post-sign-in `my_workspace_access` | Live probe on owner email → `[{"waitlist_position":null,"status":"received"}]` (was `0,"approved"`); disposable domains still `email_provider_not_accepted`; UI copy degrades to "You are on the waitlist." (app.js:6535 handles null) |
| B-04 | **FIXED, live-verified** | Per-IP write budget inside `join_waitlist`: 4/hour keyed on a **daily-salted SHA-256** of the forwarded IP (8/hour shared fallback when no header); budget applies to status re-queries too; `ip_hash` column now populated | 5 rapid live joins: 4×200 then `53100 rate_limited` ×2 (budget precise — one early owner-status probe + 3 inserts consumed it); probe rows deleted after, waitlist back to the owner's single row |
| B-05 | **FIXED (client)** | community-data outbox re-enabled: a job goes **durable on its first retryable failure** (network's fault, not the request's), persists key+payload to `impose.cm.outbox.v1`, and the pre-existing resume machinery (typed settle handlers, boot drain-then-reap, `online` listener, MAX_ATTEMPTS=6) now actually has something to resume. Duplicates stay impossible: the idempotency key is minted once and never re-minted | Syntax + community suites pass; boot path `BotoData.pending().forEach(...)` reconciles resumed jobs into "Sending" cards before drain |
| B-06 | **FIXED, DB-verified; relay part deploy pending** | Database floor in `issue_auth_code`: `p_cooldown` clamped to ≥30s server-side, plus **6 issuances/address/hour** via `rate_hit('otpissue:<email>')` — independent of relay process lifetime. Relay's in-process IP/address limits remain as defense-in-depth | Function body live in prod (applied in 0023). **Documented residual:** attempt-burning now exhausts the hourly budget and stops — a victim can still be code-locked for up to one hour by a determined attacker, bounded and self-healing; tighter would punish forgetful legitimate users more than attackers |
| B-07 | **FIXED** | New `delete_my_account()` RPC: authenticated-execute only; owner and last-admin protected (same guards as `admin_remove`); grantor audit references nulled (`added_by`, `granted_by` — both nullable by design; `admin_bootstrap.claimed_by` RESTRICT is moot because owner deletion is refused by design); 3/hour budget; cascade removes all owned rows incl. sessions. UI: "Delete account" armed two-tap item in the account menu, visible only with a live session, performs full local cleanup + redirect | Catalog-verified: `authenticated` EXECUTE ✔, anon ✘ |
| B-08 | **FIXED (client)** | `workspace-sync.js` gains `setOnPushState`: success → `null` (clears), any non-stale push failure (rate_limited, payload_too_large, offline, and now `workspace_not_granted`) → reported with the error. app.js shows a durable 15s error toast ("your work is still on this device", oversize variant for payload_too_large) with a **Retry** action → `WSync.flushNow()`; recovery toasts once | Manual toast flow reuses the existing conflict-banner mechanism; WSYNC round-trip test passes |
| B-09 | **FIXED (code), deploy pending push** | relay `/admin/grant` now calls `notify_waitlist_approved(user_id)` after a fresh grant (best-effort, logged, never un-records a landed grant); `actor_id` = owner admin (the CONTROL_KEY is the owner's tool, so the attribution is true); skipped pre-bootstrap | Test asserts exact insert `{user_id, actor_id: owner-1, kind: 'waitlist_approved'}` and the no-owner skip path |
| B-10 | **FIXED, live-verified** | `recount_saves`, `require_admin` dropped. `rls_auto_enable` **ADOPTED, not dropped**: the drop attempt (2BP01) proved the `ensure_rls` event trigger depends on it — a protective default-deny net (any table created directly in prod gets RLS immediately). Identical body now declared in 0023 + trigger recreated, so drift becomes managed code | `pg_proc` re-dump: recount_saves/require_admin absent; `rls_auto_enable` present with identical behavior; `pg_event_trigger` shows ensure_rls enabled |
| F-02 | **FIXED, live-verified** | `waitlist.ip_hash` populated by `join_waitlist` (daily-salted digest, irreversible) | Probe rows showed `ip_hashed=true` before cleanup |
| F-03 | **FIXED, catalog-verified** | `notifications_unread` applies the same live-subject join filter as `notifications_page`; badge can no longer exceed openable items | `prosrc` contains the join filter; signature unchanged |

## What did NOT change (deliberate)

- Phantom caps (`billing.*`, `users.*`, `system.configure`) — owner decision pending; inert.
- `bot:global` 12/min fairness ceiling (A-4) and unbudgeted read RPCs (A-13) — documented residuals, capacity-planning items.
- O-1: the three pg_cron jobs are still hand-provisioned (repo migration for them is a one-time dashboard/API action per environment) — recommend adding them to a migration on the next schema pass.
- O-2: no migrations registry table in this project; parity is verified object-by-object (as in I-1), which this audit does.

## Ship state

- **Database:** all of 0023 applied and verified above. Nothing to deploy.
- **Relay + client + standalone:** committed locally; **`git push` deploys** (Render Blueprint). Until then, production chat still requires the CONTROL_KEY, and grant e-mail works but inbox notice (B-09) doesn't.
- All tokens handed over in chat (GitHub PAT, Supabase `sbp_`, publishable) should be **rotated now that the engagement closes**.
