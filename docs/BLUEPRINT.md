# BLUEPRINT.md — the full Impose blueprint: every surface, every flow, every rule

Living map of the whole system as it exists in production on 2026-09-19.
One repo, three deploy surfaces:

| Surface | Where | What runs |
|---|---|---|
| Static app | Render static site `impose-web.onrender.com` (serves `GraphicMiles/Impose`, branch main) | `index.html` + `*.js` + `impose-standalone.html` |
| Database | Supabase free tier, project `xgqcvuzkeaferjsnpjjw` (eu-west-2) | Postgres+RLS+RPC — full contract in **DATABASE.md** |
| AI/OTP relay | Render web service `impose-relay.onrender.com` | `backend/relay/server.py` + helpers, ZERO persistence |

Secrets: client ships only the publishable Supabase key + relay URL. The
relay holds: CONTROL_KEY (owner ops), Supabase service key,
SENDLIB_* (mail), model gateway keys. Everything else derives from those.

---

## 1. File inventory (what each file IS)

### Client app (repo root)
- `index.html` — the shell: all views (chat, community, map, profile, inbox),
  account menu popover (Export chats, **Export account data** `acctExportData`,
  Delete account `acctDelete`, theme…). Icons via lucide, embedded SVGs.
- `app.js` — THE app shell controller: session boot (`initSession`), local
  state, chat views, palettes, menus, toasts, export/deletion handlers,
  error surfacing incl. `recent_auth_required` / `rate_limited` mapping.
- `community.js` — community domain: post/comment send pipeline, idempotent
  retry queue (`outbox`, in-memory by design — transient by contract), bot
  replies (optimistic + undo), feed/thread rendering, boot hydration from
  server reprojections + pending resumes.
- `community-data.js` — `window.BotoData`: the ONLY transport layer for
  Supabase in the client (`BotoData.db()` REST/RPC, auth via auth-client)
  + `shape(error)` → typed UI errors with {message,retryable,code}
  incl. `thread_too_deep`, `content_blocked`, `recent_auth_required`.
- `workspace-sync.js` — the synchronizer: cache `impose.cache.{uid}` (v2
  wrapper, sealed-at-rest), device key `impose.wsk.{uid}`, push/pull with
  rev CAS; conflict handler set by app.js (default = adopt server rev then
  force-push local = last-write-wins). Internal `report` channel feeds UI.
- `auth-client.js` — Supabase auth client wrapper (login/logout/session).
- `access.js` — waitlist sheet + access gating: join_waitlist calls, grant
  cache GRANT_KEY 10-min TTL (fail-closed on TTL, stays IN on transient
  failure), canUseWorkspace(), my_workspace_access readback.
- `config.js` — SUPABASE_URL, SUPABASE_ANON_KEY (publishable), RELAY_URL.
- `tests/*` — node suites: `workspace_sync_roundtrip.js`,
  `simulate_100_users.js` (full community simulation).
- `impose-standalone.html` — BUILT artifact (build_inline.py); must stay in
  sync — CI runs `build_inline.py --check`.
- misc: `styles.css`, `admin.js/admin.html` (admin panel UI), prose pages.

### Relay (backend/relay/) — stateless by contract
- `server.py` — FastAPI app. Two auth classes:
  `CONTROL_KEY` bearer → `/admin/*` (+/chat); app-session bearer → `/chat`,
  `/session/can`, `/session/my_grant` (chat = session OR owner key since B-01).
- `supabase_admin.py` — service-key helpers: find_user_by_email,
  create_pending_user/confirm after OTP, grant/has_workspace_grant,
  approve_waitlist, notify_waitlist_approved, **audit_event** (REST insert
  into audit_events), **revoke_user_sessions** (GoTrue admin logout, global),
  list_admin_owners, list_emailed.
- `mailer.py` — Sendlib HTTP mail (SENDLIB_API_KEY/FROM/URL; default host
  sendlib.samueltuoyo.com).
- `otp_store.py` — in-memory OTP codes + attempts + per-process rate bucket
  (`_RATE_BUCKETS`). B-06: durable floors now ALSO in DB (auth_codes rows
  with attempts+lockout).
- `tests/` — pytest incl. `test_closure_b01_b09.py` (chat auth split,
  OTP limits, grant notification + audit, revoke_sessions endpoint).
- `requirements.txt` (+server deps), no state files.

### Database (supabase/migrations/)
0001..0024 applied. The live body of every function = last-defining
migration (verified byte-identical). 0024 = audit/step-up/depth/blocklist/
handle_history/export/purge/timeouts + the same-apply overload hotfix.
**See DATABASE.md for the exact contract.**

### Workflows (.github/workflows/)
- `ci.yml` — relay pytest + node suites + standalone `--check` (every push).
- `db-backup.yml` — nightly `pg_dump`(37 3 * * *) → uploaded artifact,
  30-day retention. Needs repo secret `SUPABASE_DB_URL`.

---

## 2. Feature map by flow (UI → client → transport → DB)

### Sign-up / sign-in (OTP)
1. `index.html` email form → `auth-client.js` → relay `/otp/request`
   (per-process rate; **min request interval + hourly per-address/ip floors
   also enforced in DB issue_auth_code**).
2. Relay emails code (Sendlib), stores HashIp+attempts in memory AND a
   `auth_codes` row (cooldown, attempts, expiry) via RPC.
3. `/otp/verify` → consume_auth_code (row FOR UPDATE, attempts++, lockout
   deletes row) → mints `auth_ticket` → redeem → Supabase session.
4. `handle_new_user` trigger clones profile, links waitlist.user_id,
   auto-grants workspace if the email was pre-approved.

### Join waitlist
`access.js` → `join_waitlist(email)` from anon key. Constant-shape response
(no status disclosure), disposable-domain denylist, advisory-lock position,
100k cap. Positions are for display; approval is operator-driven.

### Workspace save/load (the encrypted blob)
- `workspace-sync.js` push: `save_workspace(p_data, p_expected_rev)`
  — needs session AND a `workspace_grants` row, ws:30/60s, 3 MiB cap,
  rev CAS (`stale_workspace` 40001 → conflict handler; default last-write-wins).
- pull: direct SELECT of own `workspace_state` row under RLS.
- sealed at rest with device key `impose.wsk.{uid}` (AES-GCM, localStorage —
  caveat: same-origin XSS reads both; documented trade-off).

### Community: post
`community.js` optimistic temp → outbox queue → `create_generation`
(idempotent uuid key; gen:8/60s; bot:3/60s+global:12/60s if addressed;
blocklist AFTER replay lookup so retroactive terms never break retries;
lineage checks: parent visible/live/unlocked) → adopt server row.
Undo for bot replies reverts comment counts.

### Community: comment
`create_comment` — com:15/60s + 5/60s per post; **depth ≤ 2**
(`thread_too_deep`); blocklist; parent must be live; notify_on_comment
trigger fills inbox.

### Moderation
`report_content` (dedup; rep:20/3600s). Admin panel → `admin_resolve_report`
(statusOnly; concurrent-safe 'already'); audits `report.resolve`.

### Admin panel (admin.html/admin.js → RPCs)
roster/waitlist/reports reads; writes `admin_add`, `admin_grant`
(inbox notification + audit `workspace.grant`), `admin_remove`,
`admin_grant_cap`, `admin_revoke_cap` — all `require_cap`, adm:30/60s,
audited. **Step-up (recent_auth_required 900s) on admin_remove,
admin_revoke_cap, delete_my_account** — the client says "sign in again".

### Owner relay ops (CONTROL_KEY)
- `POST /admin/grant {email}` — waitlist approve + grants + welcome mail +
  inbox notification + `audit_events('workspace.grant', via: relay)` (B-09 parity).
- `POST /admin/revoke_sessions {email}` — kills ALL sessions of an account
  (compromise lever); 3/10min budget; audits `account.revoke_sessions`.
- `POST /admin/notify waitlist_approved`, `/admin/status` etc.

### Account deletion
app.js double-confirm → `delete_my_account()` (step-up, owner/last-admin
guards, nulls grantor refs, audits `account.delete`, FK cascade clears
profile/posts/comments/grants/caps; audit row survives via SET NULL).

### Data export
- "Export chats" → local JSON of workspace.
- **"Export account data"** → `export_my_data()` (3/hr): profile, up to
  5000 posts/5000 comments, 1000 reports, 1000 notifications, workspace
  blob, waitlist rows — one JSON download.

---

## 3. Limits & abuse defenses (the whole net)

- DB rate ladder: gen 8/min; bot 3/min + 12/min global; com 15/min (+5/post);
  rep 20/h; ws 30/min; adm 30/min; exp 3/h; del 3/h; handle 3/21d.
- Relay memory limits (per-process): OTP 12/ip/h + 6/addr/h + resend cooldown;
  OTP verify 40/ip/h; admin mail 3/10min. Multi-instance resets — DB floors
  are the durable backstop.
- Statement/lock budgets 8s/4s on API roles; keyset pagination everywhere;
  no OFFSET; feed limit ≤ 50.
- Blocklist terms (owner-managed SQL table) checked inside create RPCs.
- CAP-style guards: owner_protected, last_admin, last_capability
  (rollback-by-reinsert-then-raise), bootstrap one-time claim.

## 4. Failure modes that are BY DESIGN (don't "fix")

- Waitlist returns constant shape (prevents probing approval).
- handle quota errors only mention the quota.
- `workspace_not_granted`, `parent_gone`, `thread_too_deep`,
  `content_blocked`, `recent_auth_required`, `rate_limited`,
  `stale_workspace`, `bootstrap_used` are stable UI error codes —
  shape() maps them; changing identifiers breaks the client.
- In-memory outbox: a hard refresh before drain loses an optimistic send —
  accepted (queue is transient by contract; keys make replays safe).
- Pull-then-push boot race: first-ever device with no cache pushes
  p_expected_rev=null (documented blind-overwrite for the legacy path);
  conflict handler handles subsequent devices.

## 5. Operations

- Deploy client: push to main — Render (Impose-web static site) auto-deploys
  `index.html` + `*.js`. Standalone: CI `--check` gate.
- Deploy relay: Render web service impose-relay (environment vars in Render
  dashboard; see relay files for names: CONTROL_KEY, SUPABASE_*,
  SENDLIB_* and the model gateway keys).
- Cron: NO Render cron jobs anywhere — periodic work lives IN the database
  (5 pg_cron jobs: OTP/ticket purge hourly, idempotency purge daily, rate
  counters every 20min, soft-delete retention weekly). Because every cron
  job is created idempotently inside the migrations (0017/0019/0024 pattern:
  guard pg_cron availability → schedule inside a do-block with an exception
  handler), the "re-apply migrations 0001–0024" restore step recreates all
  five automatically. The pg_dump artifact does NOT carry cron jobs — the
  migrations are the source of truth for them.
- DB changes: migrations in order; follow the runbook in DATABASE.md §5 —
  identity-arg rule, drop-policy idempotence, overload check after.
- Backup: nightly artifact (needs `SUPABASE_DB_URL` secret); restore = fresh
  project + pg_restore + re-apply migrations 0001–0024 (all re-runnable).
- Zero-repo-docs policy: this file + DATABASE.md are the ONLY docs. Update
  both in the same commit that changes the system.
