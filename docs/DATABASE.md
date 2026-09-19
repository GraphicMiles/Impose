# DATABASE.md — Impose production database, exact reference

Single source of truth for the database. Generated from the live catalog
(Supabase project `xgqcvuzkeaferjsnpjjw`, eu-west-2, free tier) on
2026-09-19 after migration 0001–0024. Migrations live in
`supabase/migrations/`; the live objects ARE the migrations applied in
order — verified byte-identical bodies against the last-defining file.

Roles: API requests run as `anon` (publishable key) or `authenticated`
(user JWT). The relay holds the service key (bypasses RLS). `"authenticated"`
and `anon` carry `statement_timeout=8s`, `lock_timeout=4s`.

Golden rules proved the hard way (in prod):
- Function identity arguments are part of the API. `CREATE OR REPLACE` with
  different arg types creates a NEW OVERLOAD: PostgREST named-argument calls
  become ambiguous and the live endpoint breaks. Never change p_key uuid /
  p_email citext etc. — write the same identity args or drop the old one.
- `idempotency_keys.key` is **uuid**; text keys error `uuid = text`.
- New tables get RLS enabled and NO policies = default deny; add read
  policies deliberately. `ensure_rls` event trigger auto-enables RLS on
  manually created tables (prod hardening, adopted into migrations).


# Tables (20)

### `profiles`
one row per auth.users row; handle + identity. Written only through RPCs. Writers: handle_new_user trigger (auth) clones user metadata in; customize_profile validates+writes.

Columns:  
`id uuid not null, handle text, display_name text not null, created_at timestamp with time zone not null, bio text, avatar text, username_changes_count integer not null, username_quota_exhausted_at timestamp with time zone`

Constraints: `profiles_id_fkey (None)`; `PK: id`; `UQ: handle`

RLS policies:
- `own profile update` [UPDATE] → using((auth.uid() = id))  check((auth.uid() = id))
- `profiles are public read` [SELECT] → using(true)  check(None)

API grants: anon:SELECT, authenticated:SELECT

### `waitlist`
public waitlist rows; email is the key. Writers: join_waitlist (anon-accessible) inserts; admin_grant flips to approved; user_id linked on signup by handle_new_user.

Columns:  
`id uuid not null, email USER-DEFINED not null, status text not null, position integer, created_at timestamp with time zone not null, ip_hash text, user_id uuid`

Constraints: `waitlist_user_id_fkey (None)`; `PK: id`; `UQ: email`

RLS: enabled, **no policies = default deny** for API roles.

API grants: none

### `workspace_grants`
who may use the workspace (the save/load synchronizer). Writers: admin_grant RPC or relay /admin/grant inserts. save_workspace requires a row here (0023).

Columns:  
`user_id uuid not null, granted_at timestamp with time zone not null, granted_by uuid, note text`

Constraints: `workspace_grants_granted_by_fkey (None)`; `workspace_grants_user_id_fkey (None)`; `PK: user_id`

RLS: enabled, **no policies = default deny** for API roles.

API grants: none

### `workspace_state`
THE whole workspace, one encrypted blob per user (rev-based CAS sync). Writers: save_workspace writes (grant-gated, 3 MiB cap, rev CAS); pull via direct SELECT under RLS (own row only).

Columns:  
`user_id uuid not null, data jsonb not null, rev bigint not null, updated_at timestamp with time zone not null`

Constraints: `workspace_state_user_id_fkey (None)`; `PK: user_id`

RLS policies:
- `workspace_state_delete_own` [DELETE] → using(((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM workspace_grants g
  WHERE (g.user_id = auth.uid())))))  check(None)
- `workspace_state_insert_own` [INSERT] → using(None)  check(((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM workspace_grants g
  WHERE (g.user_id = auth.uid())))))
- `workspace_state_select_own` [SELECT] → using(((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM workspace_grants g
  WHERE (g.user_id = auth.uid())))))  check(None)
- `workspace_state_update_own` [UPDATE] → using(((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM workspace_grants g
  WHERE (g.user_id = auth.uid())))))  check(((auth.uid() = user_id) AND (EXISTS ( SELECT 1
   FROM workspace_grants g
  WHERE (g.user_id = auth.uid())))))

API grants: authenticated:DELETE, authenticated:INSERT, authenticated:SELECT, authenticated:UPDATE

### `generations`
community posts (prompt/response pairs) incl. remix/challenge lineage. Writers: create_generation (idempotent uuid-key) is the ONLY insert path; soft-deleted via PATCH deleted_at (only PATCH-granted column). purge_soft_deleted removes permanently.

Columns:  
`id uuid not null, author_id uuid not null, prompt text not null, response text not null, model text, visibility text not null, kind text not null, remix_of uuid, root_id uuid, status text not null, addressed boolean not null, locked boolean not null, deleted_at timestamp with time zone, created_at timestamp with time zone not null, comment_count integer not null, remix_count integer not null, challenge_count integer not null, updated_at timestamp with time zone not null`

Constraints: `generations_author_id_fkey (id)`; `generations_remix_of_fkey (id)`; `generations_root_id_fkey (id)`; `PK: id`

RLS policies:
- `authors create their own generations` [INSERT] → using(None)  check(((auth.uid() = author_id) AND (visibility = ANY (ARRAY['public'::text, 'private'::text])) AND (((kind = 'original'::text) AND (remix_of IS NULL)) OR ((kind = ANY (ARRAY['remix'::text, 'challenge'::text])) AND (remix_of IS NOT NULL))) AND ((remix_of IS NULL) OR (EXISTS ( SELECT 1
   FROM generations p
  WHERE ((p.id = generations.remix_of) AND (p.locked = false) AND (p.deleted_at IS NULL) AND ((p.visibility = 'public'::text) OR (p.author_id = auth.uid()))))))))
- `authors delete their own generations` [DELETE] → using((auth.uid() = author_id))  check(None)
- `authors update their own generations` [UPDATE] → using((auth.uid() = author_id))  check((auth.uid() = author_id))
- `public generations are readable by everyone` [SELECT] → using(((visibility = 'public'::text) OR (author_id = auth.uid())))  check(None)

API grants: anon:SELECT, authenticated:SELECT

### `comments`
threaded comments, max depth 2 enforced server-side. Writers: create_comment (idempotent, depth cap, blocklist) inserts; soft-delete via soft_delete_comment; user-delete own + admin any.

Columns:  
`id uuid not null, generation_id uuid not null, author_id uuid not null, parent_id uuid, body text not null, deleted_at timestamp with time zone, created_at timestamp with time zone not null, updated_at timestamp with time zone not null`

Constraints: `comments_author_id_fkey (id)`; `comments_generation_id_fkey (id)`; `comments_parent_id_fkey (id)`; `PK: id`

RLS policies:
- `authors create their own comments` [INSERT] → using(None)  check(((auth.uid() = author_id) AND (EXISTS ( SELECT 1
   FROM generations g
  WHERE ((g.id = comments.generation_id) AND (g.deleted_at IS NULL) AND ((g.visibility = 'public'::text) OR (g.author_id = auth.uid()))))) AND comment_parent_matches(parent_id, generation_id)))
- `authors delete own comments` [DELETE] → using((auth.uid() = author_id))  check(None)
- `authors edit own comments` [UPDATE] → using((auth.uid() = author_id))  check((auth.uid() = author_id))
- `comments follow generation visibility` [SELECT] → using((EXISTS ( SELECT 1
   FROM generations g
  WHERE ((g.id = comments.generation_id) AND (g.deleted_at IS NULL) AND ((g.visibility = 'public'::text) OR (g.author_id = auth.uid()))))))  check(None)

API grants: anon:SELECT, authenticated:SELECT

### `reports`
moderation queue on posts/comments. Writers: report_content (dedup target+reporter, 20/hr) inserts; admin_resolve_report transitions status.

Columns:  
`id uuid not null, kind text not null, target_id uuid not null, reporter_id uuid not null, reason text, status text not null, created_at timestamp with time zone not null`

Constraints: `reports_reporter_id_fkey (id)`; `PK: id`; `UQ: reporter_id`; `UQ: target_id`

RLS: enabled, **no policies = default deny** for API roles.

API grants: none

### `notifications`
per-user inbox (comments/replies/remixes/waitlist_approved). Writers: triggers notify_on_comment/notify_on_lineage insert; RPCs feed page/unread/mark-read.

Columns:  
`id uuid not null, user_id uuid not null, actor_id uuid not null, kind text not null, generation_id uuid, comment_id uuid, read_at timestamp with time zone, created_at timestamp with time zone not null`

Constraints: `notifications_actor_id_fkey (id)`; `notifications_comment_id_fkey (id)`; `notifications_generation_id_fkey (id)`; `notifications_user_id_fkey (None)`; `PK: id`

RLS policies:
- `own notifications are dismissable` [UPDATE] → using((auth.uid() = user_id))  check((auth.uid() = user_id))
- `own notifications are readable` [SELECT] → using((auth.uid() = user_id))  check(None)

API grants: authenticated:SELECT

### `idempotency_keys`
uuid key -> response, makes client retries safe. Writers: create_* RPCs check-then-insert; purge cron drops >24h. KEY IS UUID: changing arg types = new overload (breaks PostgREST).

Columns:  
`key uuid not null, user_id uuid not null, request_hash text not null, response jsonb, created_at timestamp with time zone not null`

Constraints: `idempotency_keys_user_id_fkey (None)`; `PK: key`

RLS policies:
- `own idempotency keys are readable` [SELECT] → using((auth.uid() = user_id))  check(None)

API grants: authenticated:SELECT

### `rate_counters`
fixed-window counters backing rate_hit(). Writers: bump via rate_hit inside RPCs; purge cron sweeps expired rows.

Columns:  
`bucket text not null, window_at timestamp with time zone not null, hits integer not null`

Constraints: `PK: window_at`; `PK: bucket`

RLS: enabled, **no policies = default deny** for API roles.

API grants: none

### `auth_codes`
OTP rows (relay also keeps its own copy out-of-band). Writers: issue_auth_code/consume_auth_code definer RPCs with attempts+lockout; hourly purge via cron.

Columns:  
`email USER-DEFINED not null, purpose text not null, code_hash text not null, attempts integer not null, issued_at timestamp with time zone not null, expires_at timestamp with time zone not null, user_id uuid`

Constraints: `PK: email`; `PK: purpose`

RLS: enabled, **no policies = default deny** for API roles.

API grants: none

### `auth_tickets`
one-time sign-in tickets minted after OTP verify. Writers: redeem_auth_ticket consumes; purged hourly.

Columns:  
`token_hash text not null, email USER-DEFINED not null, user_id uuid, expires_at timestamp with time zone not null, created_at timestamp with time zone not null`

Constraints: `PK: token_hash`

RLS: enabled, **no policies = default deny** for API roles.

API grants: none

### `admins`
admin roster; owner row is seeded by 0022. Writers: admin_add/admin_remove mutate (owner-protected, last_admin guard).

Columns:  
`user_id uuid not null, email USER-DEFINED not null, owner boolean not null, added_by uuid, created_at timestamp with time zone not null`

Constraints: `admins_added_by_fkey (None)`; `admins_user_id_fkey (None)`; `PK: user_id`; `UQ: email`

RLS: enabled, **no policies = default deny** for API roles.

API grants: none

### `admin_caps`
capability grants per admin. Owner runs with zero rows = all caps. Writers: admin_grant_cap/admin_revoke_cap (last_capability guard re-inserts then raises).

Columns:  
`user_id uuid not null, cap text not null, granted_by uuid, granted_at timestamp with time zone not null`

Constraints: `admin_caps_cap_fkey (cap)`; `admin_caps_granted_by_fkey (None)`; `admin_caps_user_id_fkey (None)`; `PK: cap`; `PK: user_id`

RLS: enabled, **no policies = default deny** for API roles.

API grants: none

### `admin_capabilities`
the capability catalog (incl. legacy phantom caps nothing requires). Writers: seeded by migrations.

Columns:  
`cap text not null, label text not null, description text not null, sensitive boolean not null, sort smallint not null`

Constraints: `PK: cap`

RLS: enabled, **no policies = default deny** for API roles.

API grants: none

### `admin_action_caps`
cap -> action mapping consulted by require_cap. Writers: seeded by migrations.

Columns:  
`action text not null, cap text not null`

Constraints: `admin_action_caps_cap_fkey (cap)`; `PK: action`

RLS: enabled, **no policies = default deny** for API roles.

API grants: none

### `admin_bootstrap`
one-time bootstrap claim guard (claimed_by RESTRICTs owner deletion). Writers: admin_bootstrap_claim writes the single row.

Columns:  
`id smallint not null, claimed_by uuid not null, claimed_at timestamp with time zone not null, note text`

Constraints: `admin_bootstrap_claimed_by_fkey (None)`; `PK: id`

RLS: enabled, **no policies = default deny** for API roles.

API grants: none

### `audit_events`
007-arch trail of privileged actions; NO policies (default deny) — reads only via admin_audit_events. Writers: audit_log() inside RPCs + relay service-key inserts. actor_id SET NULL so deletion keeps history.

Columns:  
`id bigint not null, actor_id uuid, action text not null, target_type text, target_id uuid, metadata jsonb not null, created_at timestamp with time zone not null`

Constraints: `audit_events_actor_id_fkey (None)`; `PK: id`

RLS: enabled, **no policies = default deny** for API roles.

API grants: none

### `blocked_terms`
owner-managed denylist consulted by create_comment/create_generation. Writers: SQL-only (no client grants at all). Empty table = no-op.

Columns:  
`term text not null, created_at timestamp with time zone not null`

Constraints: `PK: term`

RLS: enabled, **no policies = default deny** for API roles.

API grants: none

### `handle_history`
every dropped handle archived (impersonation defense). Writers: record_handle_history trigger on profiles.handle.

Columns:  
`id bigint not null, user_id uuid not null, old_handle text not null, dropped_at timestamp with time zone not null`

Constraints: `handle_history_user_id_fkey (None)`; `PK: id`

RLS policies:
- `users read their own handle history` [SELECT] → using((auth.uid() = user_id))  check(None)

API grants: none


# Indexes per table

- `profiles`: `profiles_handle_key`, `profiles_pkey`
- `waitlist`: `waitlist_email_key`, `waitlist_pkey`, `waitlist_position_key`, `waitlist_status_created_idx`
- `workspace_grants`: `workspace_grants_granted_at_idx`, `workspace_grants_pkey`
- `workspace_state`: `workspace_state_pkey`
- `generations`: `generations_author_idx`, `generations_feed_idx`, `generations_pkey`, `generations_remix_idx`, `generations_root_idx`
- `comments`: `comments_parent_idx`, `comments_pkey`, `comments_thread_idx`
- `reports`: `reports_pending_idx`, `reports_pkey`, `reports_target_id_reporter_id_key`
- `notifications`: `notifications_inbox_idx`, `notifications_pkey`, `notifications_unread_idx`
- `idempotency_keys`: `idempotency_created_idx`, `idempotency_keys_pkey`
- `rate_counters`: `rate_counters_pkey`, `rate_counters_window_idx`
- `auth_codes`: `auth_codes_expiry_idx`, `auth_codes_pkey`
- `auth_tickets`: `auth_tickets_expiry_idx`, `auth_tickets_pkey`
- `admins`: `admins_email_key`, `admins_pkey`
- `admin_caps`: `admin_caps_pkey`
- `admin_capabilities`: `admin_capabilities_pkey`
- `admin_action_caps`: `admin_action_caps_pkey`
- `admin_bootstrap`: `admin_bootstrap_pkey`
- `audit_events`: `audit_events_pkey`
- `blocked_terms`: `blocked_terms_pkey`
- `handle_history`: `handle_history_pkey`

# Triggers

- `comments` ← comments_notify [AFTER INSERT → EXECUTE FUNCTION notify_on_comment()] ; comments_recount [AFTER INSERT → EXECUTE FUNCTION recount_comments()] ; comments_recount [AFTER DELETE → EXECUTE FUNCTION recount_comments()] ; comments_recount [AFTER UPDATE → EXECUTE FUNCTION recount_comments()] ; comments_touch [BEFORE UPDATE → EXECUTE FUNCTION touch_updated_at()]
- `generations` ← generations_notify [AFTER INSERT → EXECUTE FUNCTION notify_on_lineage()] ; generations_recount_lineage [AFTER DELETE → EXECUTE FUNCTION recount_lineage()] ; generations_recount_lineage [AFTER UPDATE → EXECUTE FUNCTION recount_lineage()] ; generations_recount_lineage [AFTER INSERT → EXECUTE FUNCTION recount_lineage()] ; generations_set_root [BEFORE INSERT → EXECUTE FUNCTION set_generation_root()] ; generations_touch [BEFORE UPDATE → EXECUTE FUNCTION touch_updated_at()]
- `profiles` ← trg_handle_history [AFTER UPDATE → EXECUTE FUNCTION record_handle_history()]

# Cron (pg_cron)

- `impose-purge-auth-codes` `17 * * * *` → `select public.purge_expired_auth_codes()`
- `impose-purge-idempotency` `23 3 * * *` → `select public.purge_idempotency_keys()`
- `impose-purge-rate-counters` `*/20 * * * *` → `select public.purge_rate_counters()`
- `impose-purge-soft-deleted` `41 4 * * 0` → `select public.purge_soft_deleted()`## Functions (107 in catalog — app-facing subset annotated; the rest are pgcrypto/internal & migration-era helpers)

All application RPCs are `security definer` with pinned `search_path` and are called only via PostgREST named arguments.

| Function | Class | Behavior / limits |
|---|---|---|
| `admin_add(p_email citext)` | ADMIN | exec anon=- auth=auth — require_cap('admin_add'); adm:30/60s; seeds waitlist.manage+moderation.manage; audits |
| `admin_audit_events(p_limit integer, p_before timestamp with time zone)` | ADMIN READ | exec anon=- auth=auth — is_admin() gate |
| `admin_bootstrap_claim(p_note text)` | BOOTSTRAP | exec anon=- auth=auth — one-time claim of admin_bootstrap row |
| `admin_caps_for(p_user_id uuid)` | ADMIN READ | exec anon=- auth=auth — caps of a user |
| `admin_grant(p_email citext)` | ADMIN | exec anon=- auth=auth — require_cap('admin_grant'); adm:30/60s; workspace_grants+waitlist approve+notification; audits only when new |
| `admin_grant_cap(p_user_id uuid, p_cap text)` | ADMIN | exec anon=- auth=auth — require_cap; adm:30/60s (0024); audits |
| `admin_remove(p_user_id uuid)` | ADMIN | exec anon=- auth=auth — require_cap('admin_remove') + STEP-UP(900s); owner_protected, last_admin; clears caps; audits |
| `admin_reports(p_status text, p_limit integer)` | ADMIN READ | exec anon=- auth=auth — pending queue |
| `admin_resolve_report(p_id uuid, p_status text)` | ADMIN | exec anon=- auth=auth — require_cap(...); adm:30/60s; status-only + 'already' idempotence; audits |
| `admin_revoke_cap(p_user_id uuid, p_cap text)` | ADMIN | exec anon=- auth=auth — require_cap + STEP-UP; adm:30/60s (0024); owner_protected, last_capability rollback; audits |
| `admin_roster()` | ADMIN READ | exec anon=- auth=auth — admins + caps |
| `admin_waitlist(p_status text, p_limit integer)` | ADMIN READ | exec anon=- auth=auth — waitlist listing |
| `audit_log(p_action text, p_target_type text, p_target_id uuid, p_metadata jsonb)` | INTERNAL | exec anon=- auth=- — inserts audit_events as auth.uid(); revoked from public |
| `can_do(p_action text)` | ENGINE | exec anon=- auth=auth — cap->action check helper |
| `comment_parent_matches(p_parent uuid, p_generation uuid)` | TRIGGER FN | exec anon=- auth=auth — referential guard: parent comment belongs to same generation |
| `consume_auth_code(p_email citext, p_purpose text, p_hash text, p_max integer)` | OTP | exec anon=- auth=- — attempts+lockout (row deleted at max), FOR UPDATE serialized |
| `create_comment(p_key uuid, p_gen uuid, p_body text, p_parent uuid)` | USER | exec anon=- auth=auth — idempotent, com:15/60s + com:user:gen5/60s; depth<=2 (thread_too_deep); blocklist; parent checks |
| `create_generation(p_key uuid, p_prompt text, p_response text, p_addressed boolean, p_status text, p_visibility text, p_kind text, p_remix_of uuid)` | USER | exec anon=- auth=auth — idempotent (p_key uuid), gen:8/60s; addressed adds bot:3/60s + bot:global12/60s; blocklist; lineage+lock checks |
| `customize_profile(p_display_name text, p_bio text, p_handle text, p_avatar text)` | USER | exec anon=- auth=auth — handle quota 3/21d; validation |
| `delete_my_account()` | USER | exec anon=- auth=auth — step-up require_recent_auth(900s); owner/last-admin guards; nulls grantor refs; audits account.delete; deletes auth.users |
| `ensure_profile()` | ENGINE | exec anon=- auth=auth — creates profile on first use |
| `export_my_data()` | USER | exec anon=- auth=auth — exp:3/3600s; bounded sections (5000/5000/1000/1000) |
| `feed_page(p_before_time timestamp with time zone, p_before_id uuid, p_limit integer)` | READ (anon) | exec anon=anon auth=auth — public+live only, keyset cursor, limit<=50 |
| `feed_since(p_after timestamp with time zone)` | READ | exec anon=anon auth=auth — incremental pull window |
| `handle_new_user()` | TRIGGER FN (auth) | exec anon=anon auth=auth — clones auth.users metadata into profiles; links waitlist user_id; auto-grants workspace if approved email |
| `has_cap(p_cap text)` | ENGINE | exec anon=- auth=auth — cap check helper |
| `is_admin()` | ENGINE | exec anon=- auth=auth — membership check |
| `issue_auth_code(p_email citext, p_purpose text, p_hash text, p_user_id uuid, p_ttl integer, p_cooldown integer)` | OTP (relay/service) | exec anon=- auth=- — cooldown param caller-supplied; resend resets; purged hourly |
| `join_waitlist(p_email text)` | USER (anon+auth) | exec anon=anon auth=auth — anon-read enumerable by design after 0023 constant-response; disposable-domain blocklist, advisory-lock position, 100k cap |
| `my_workspace_access()` | USER | exec anon=- auth=auth — read-only access summary |
| `notifications_page(p_limit integer)` | READ | exec anon=- auth=auth — keyset |
| `notify_on_comment()` | TRIGGER FN | exec anon=anon auth=auth — inbox on comments (guards missing actor profile) |
| `notify_on_lineage()` | TRIGGER FN | exec anon=anon auth=auth — inbox on remix/challenge |
| `profile_by_handle(p_handle text)` | READ | exec anon=anon auth=auth — public profile card |
| `profile_feed(p_handle text, p_before_time timestamp with time zone, p_before_id uuid, p_limit integer)` | READ | exec anon=anon auth=auth — posts by handle, keyset |
| `purge_expired_auth_codes()` | CRON | exec anon=- auth=- — also purges auth_tickets |
| `purge_idempotency_keys()` | CRON | exec anon=- auth=- — >24h |
| `purge_rate_counters()` | CRON | exec anon=- auth=- — expired windows |
| `purge_soft_deleted(p_days integer)` | CRON | exec anon=- auth=- — >90d soft-deleted generations/comments (0024) |
| `rate_hit(p_bucket text, p_limit integer, p_window_seconds integer)` | ENGINE | exec anon=- auth=- — fixed-window upsert into rate_counters; true=over limit (caller raises 53100) |
| `record_handle_history()` | TRIGGER FN | exec anon=anon auth=auth — archives old handle (0024) |
| `recount_comments()` | TRIGGER FN/maintenance | exec anon=anon auth=auth — comment_count rollup |
| `recount_lineage()` | TRIGGER FN/maintenance | exec anon=anon auth=auth — remix/challenge counts |
| `redeem_auth_ticket(p_hash text)` | OTP | exec anon=- auth=- — one-shot delete-returning |
| `report_content(p_kind text, p_target uuid, p_reason text)` | USER | exec anon=- auth=auth — dedup (target,reporter); rep:20/3600s; status-only |
| `require_cap(p_action text)` | ENGINE | exec anon=- auth=auth — is_admin + cap membership (owner => all) |
| `require_recent_auth(p_max_age_seconds integer)` | STEP-UP | exec anon=- auth=- — fail-closed on missing/aged iat (900s); recent_auth_required 42501 |
| `rls_auto_enable()` | ADOPTED (event-trigger fn) | exec anon=anon auth=auth — auto-enables RLS on manually created tables; canonical in 0023 |
| `sanitize_display_name(p_name text)` | ENGINE | exec anon=- auth=- — plpgsql display-name sanitizer |
| `save_workspace(p_data jsonb, p_expected_rev bigint)` | USER+GRANT | exec anon=- auth=auth — ws:30/60s, 3MiB, rev CAS (stale_workspace 40001); requires workspace_grants row (0023); null expected_rev = legacy blind overwrite |
| `set_generation_root()` | TRIGGER FN | exec anon=anon auth=auth — maintains root_id for lineage rollup |
| `text_is_spammy(p_text text)` | ENGINE | exec anon=- auth=- — profanity/denylist helper for profile fields |
| `thread_for(p_gen uuid)` | READ | exec anon=anon auth=auth — comment tree for a post |

## Rate limits (all in-DB via rate_hit, uuid-keyed to the caller)

| Bucket | Limit | Window | Raised by |
|---|---|---|---|
| gen:{uid} | 8 | 60s | create_generation |
| bot:{uid} / bot:global | 3 / 12 | 60s | addressed posts (compute ceiling) |
| com:{uid} / com:{uid}:{gen} | 15 / 5 | 60s | create_comment |
| rep:{uid} | 20 | 3600s | report_content |
| ws:{uid} | 30 | 60s | save_workspace |
| adm:{uid} | 30 | 60s | all admin writes |
| exp:{uid} | 3 | 3600s | export_my_data |
| del:{uid} | 3 | 3600s | delete_my_account |
| handle quota | 3 | 21d | customize_profile |

Relay-side (per-process memory, 0023 B-06 note): OTP request 12/IP/h + 6/address/h
+ resend cooldown; OTP verify 40/IP/h; admin mail paths 3/10min. DB floors
above are the durable backstop.

## Idempotency & retry contract
- create_generation/create_comment take client uuid keys; hash-mismatch on
  reuse => 22023 idempotency_key_reused; same-key+same-body replays return
  the ORIGINAL row even if rules tightened later (blocklist check is AFTER
  the replay lookup — proven on prod).
- save_workspace is CAS: expected_rev must match or 40001 stale_workspace;
  null expected_rev = legacy blind overwrite.
- admin_resolve_report returns 'already' on settled rows (safe re-run).

## Step-up auth ($0 MFA alternative)
require_recent_auth(900) reads request.jwt.claims.iat; missing/aged =>
42501 recent_auth_required. Applied to admin_remove, admin_revoke_cap,
delete_my_account. The OTP sign-in ceremony mints the fresh iat.

## Migration procedure (learned live)
1. SQL editor / Management API only (no supabase CLI in prod runner).
2. Keep identity args byte-identical (uuid / citext) or explicit `drop
   function ...` the replaced overload — one function per name.
3. Policies: `drop policy if exists` before create (no IF NOT EXISTS).
4. Re-apply must be clean (all 0001-0024 are re-runnable; verified twice).
5. After DDL touching API-visible functions: nothing to reload (PostgREST
   re-reads), but watch for overloads (step 2) before declaring done.
6. Nightly backup dumps: .github/workflows/db-backup.yml (publishes artifact,
   retention 30d). Runs as the DEDICATED ROLE `impose_backup` (created
   2026-09-19): login, BYPASSRLS + `pg_read_all_data` for pg_dump, NO write,
   no createdb/createrole. Its session-pooler DSN is stored write-only in
   the repo secret `SUPABASE_DB_URL`. Rotate: `alter role impose_backup
   with password '<new>';` then update the secret. Never store the
   `postgres` owner role in CI.
