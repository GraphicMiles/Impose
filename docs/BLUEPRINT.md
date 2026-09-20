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

## 1a. Provider inventory (every external service we depend on)

| Provider | Role in the platform | Where wired | Failure impact |
|---|---|---|---|
| **Render** (free hobby) | hosts both services: `impose-web` static site + `impose-relay` web service. NOTE: free web services SLEEP after 15 min idle → first request after sleep has a cold-start latency (by design, $0 posture) | Render dashboards; `config.js` RELAY_URL | app unreachable until instance wakes/redeployed |
| **Supabase** (free, eu-west-2) | Postgres database + GoTrue auth + PostgREST REST/RPC + **pg_cron scheduler** (the one and only cron in the platform) | `config.js` URL+publishable key; relay SUPABASE_* env | login/community/workspace all dead; free projects PAUSE after ~7d inactivity (resume in dashboard) |
| **Sendlib** (sendlib.samueltuoyo.com) | transactional email API: sends OTP codes and waitlist-approval mail | relay env `SENDLIB_API_KEY`/`SENDLIB_FROM`(+URL override) | OTP sign-in emails stop (users can't log in) |
| **Lightning.ai** (SDK `lightning-sdk`) | wake/idle control of the self-hosted GPU Studio ("the box") so it only burns GPU when someone chats | relay requirements.txt; relay start logic | box won't auto-wake; chat says model unavailable |
| **Self-hosted GPU Studio** ("the box") | serves the AI model behind an OpenAI-style `/v1` gateway | relay env `LLM_GATEWAY_URL`/`LLM_GATEWAY_KEY` | agents/bot replies unavailable; rest of app fine |
| **Cloudflare Web Analytics** | cookieless page-view beacon on the site (token `ea82ca…`) | `index.html` head script | none (analytics only — remove cheaply anytime) |
| **GitHub** | source repo + CI + nightly backup artifacts (`SUPABASE_DB_URL` secret) | `origin`; `.github/workflows/` | loses CI + backups, not the running product |
| Google s2 favicons + Twitch embeds | micro-niceties: favicon fetcher and video embeds when a user pastes a Twitch link | client code | cosmetic |
| **BYOK providers (optional, per user)** — OpenAI, Anthropic, Gemini, Groq, OpenRouter, DeepSeek, Mistral, Together, xAI, local LM Studio/llama.cpp, custom OpenAI-compatible endpoint | the browser can talk directly to any listed provider when a USER pastes their own key (demo mode otherwise). The platform itself has ZERO dependency on any of these | Settings in the client; keys live inside the user's encrypted workspace blob | per-user only |

**Who handles cron, definitively:** Supabase's pg_cron extension, inside the
database (5 jobs: rate-counter sweep 20min, OTP/ticket purge hourly,
idempotency daily, soft-delete retention weekly, plus none elsewhere).
Render runs NO cron; GitHub Actions runs scheduled workflows (nightly backup
only). On any restore, re-applying migrations recreates every cron job.

---

## 1. File inventory (what each file IS)

### Client app (repo root)
- `index.html` — the shell: all views (chat, community, map, profile, inbox),
  account menu popover (Export chats, **Export account data** `acctExportData`,
  Delete account `acctDelete`, theme…). Icons via lucide, embedded SVGs.
  **First-paint contract:** one inline boot script at the top of `<body>`
  decides everything the URL and viewport already decide — the product mode
  (`body.community-mode` for every route except `/workspace` and `/admin`)
  and the sidebar drawer (`nav-open` above 768px). The app must never paint
  the wrong chrome and re-dress itself; community.js `showMode()` then
  re-derives the same fact from the same rule. Every inline script is
  CSP-hashed in `render.yaml`/`_headers`; edit one and recompute the
  sha256 (taste.js recomputes and fails on drift, recipe in `_headers`).
- `auth.html` + `auth.css` — same contract for the auth views: only the
  sign-in view ships visible, so a boot script names the route on
  `<html data-auth-view>`, CSS (`html[data-auth-view=…]` rules) paints that
  view immediately, and `auth.js` removes the attribute once it owns
  routing. A deep link (`/sign-up`, `/otp`, …) never flashes the sign-in
  form first.
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
Modularised layout (was one ~2400-line server.py):

- `server.py` (~200 lines) — the shell: FastAPI app, lifespan hook,
  correlation middleware, /health, router mounts, back-compat aliases so
  earlier test/tooling imports keep resolving.
- `settings.py` — env/.env loading, config constants, and the SINGLE OWNER
  of every mutable runtime container (`_RATE_BUCKETS`, `_CACHE`,
  `_MEMBER_CACHE`, `_gateway_state`, wake/lifecycle flags). Code everywhere
  reads these attribute-wise (`_settings.X`) at call time; any test that
  replaces state wholesale replaces it on `relay.settings`.
- `shared.py` — cross-cutting request machinery: client-ip, rate/cache
  helpers, CONTROL_KEY/member/owner/tier auth, wake scaffolding,
  image verify/convert signature, SSRF-safe fetch, email validators,
  html readers. Helpers resolve names through their own module globals —
  monkeypatch a helper on the module that CALLS it.
- `routers/auth.py` — `/v1/auth/otp/request|verify`, `/v1/auth/password/reset`.
- `routers/media.py` — models, chat/completions, search, source/catalog,
  images, videos, files, file, fetch, read, signed image-convert.
- `routers/admin.py` — `/admin/*` + `/notify/grant` (accounts, reports,
  waitlist, grant, revoke_grant, revoke_sessions, status, wake-llm).
- `supabase_admin.py` — service-key helpers: find_user_by_email,
  create_pending_user/confirm after OTP, grant/has_workspace_grant,
  **revoke_workspace_grant** (delete row; /admin/revoke_grant parity with
  the admin_revoke_grant RPC), approve_waitlist, notify_waitlist_approved,
  notify_access_revoked, **audit_event** (REST insert into audit_events),
  **revoke_user_sessions** (GoTrue admin logout, global),
  list_admin_owners, list_emailed.
- `mailer.py` — Sendlib HTTP mail (SENDLIB_API_KEY/FROM/URL; default host
  sendlib.samueltuoyo.com).
- `otp_store.py` — in-memory OTP codes + attempts + per-process rate bucket
  (`_RATE_BUCKETS`). B-06: durable floors now ALSO in DB (auth_codes rows
  with attempts+lockout).
- `tests/` — pytest incl. `test_closure_b01_b09.py` (chat auth split,
  OTP limits, grant notification + audit, revoke_sessions/grant endpoints).
- `requirements.txt` (+server deps), no state files.

### Database (supabase/migrations/)
0001..0026 applied. The live body of every function = last-defining
migration (verified byte-identical). 0024 = audit/step-up/depth/blocklist/
handle_history/export/purge/timeouts + the same-apply overload hotfix.
0025 = lifecycle closures: grant revoke RPC, blocked-term admin RPCs,
edit_generation (prompt-only), purge_old_notifications + nightly cron.
0026 = notifications_kind_check gains 'workspace_revoked' (defect caught by
the 29-account prod simulation: admin_revoke_grant half-applied when the
notice insert violated the constraint).
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

### Community: render + state authority

Server rows are canonical; the client's `state.generations/comments` is a
server-fed display cache never written to disk. Every render path follows
"never discard valid information to wait for fresher information":

- Feed: `renderKnownFeed` reconciles by generation.id — unchanged rows keep
  their DOM node (zero repaint), drifted rows patch in place via
  replaceCard slot painters (header/counts/prompt/response/chips/lock),
  only genuinely new ids build a node. The card entrance animation
  (ctx-in) is admission-only, gated on the absence of [data-entered].
- Card grammar (post and comment headers share it): one identity line
  that never wraps — the display name truncates first, the handle second,
  time + badges sit on flex:none islands. Action rows (`.gen-actions`,
  `.comment-ops`) distribute with space-evenly; no spacer or margin pulls
  controls to an edge. Display names follow one contract everywhere
  (BotoUI.validProfileName, mirrored by migration 0027): 2-40 chars, at
  least one ASCII letter/digit, no emoji.
- Optimistic rows carry the caller's real profile (myProfileNow cache),
  never a blank "You" placeholder; adoptServerRow renames the DOM node's
  data-id across the local->server id swap so optimistic card and canonical
  row are one view entity.
- Feed reload (pull-to-refresh, pill) is atomic: the previous page stays
  mounted until page one lands; on failure nothing is discarded.
- Avatar authority: community-data keeps a TTL (60s) + in-flight-deduped
  avatarCache keyed by auth user id; the caller's own profile joins it.
  Poll ticks and avatar refreshes repaint only rows whose identity moved.
- Profile page + notification sheet render cached content instantly on
  revisit and merge fresher data over it (soft reload).
- Feed loading has exactly two phases: "initial" (nothing trusted — the
   4-card skeleton owns the feed space alone, minimum 400ms dwell, retired
   once) and "ready" (page one verified — loaders are incremental: compact
   "Loading more…" pill for pagination, retained content + pull indicator
   for refresh; ghost cards never appear beneath real content).
- Comment threads mirror the same contract per generation: unproven
  threads show a 3-row comment skeleton (avatar-sm + two lines geometry),
  never a false "No replies yet"; settled failures render an error box
  with Retry; proven threads refresh in place.
- Pending/failed rows state themselves: queued comments render "Sending";
  permanently-failed comments render the reason + Retry (re-queued with
  the same idempotency key) + Dismiss; failed plain posts get a Retry in
  the card chip (same key, never a duplicate write).
- Settlement toasts ("Posted.", "Comment added.") fire for in-session,
  visible writes only; jobs that outlived the tab reconcile silently.
- Threads: hydrateThread merges server rows and repaints only when the
  visible-thread signature changed; comments themselves are relativized
  rows without entrance animation, so thread repaints are continuous.

jsdom smoke: tests/smoke_community_render.js (14 assertions over the
reconciler: no remount on no-op renders, avatar SWR, atomic refresh,
optimistic identity, double-fire guards, lock patch-in-place).

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

### Grant revocation (single write surface)
Admin panel Approved-row "Revoke access" (two-tap confirm) →
`admin_revoke_grant` RPC (waitlist.manage cap; idempotent
`{"status":"revoked"|"no_grant"}`) deletes the workspace_grants row, drops
a `workspace_revoked` inbox notice and audits `workspace.revoke`. The very
next `save_workspace` refuses (`workspace_not_granted`); the client's
10-minute access cache converges harmlessly. Relay CAUTION counterpart:
`/admin/revoke_grant` (CONTROL_KEY) — same guarantee, parallel audit.
Account-level session invalidation is a separate control:
`/admin/revoke_sessions` / `delete_my_account`.

### Blocked terms management (admin)
Panel card (moderation.manage) lists `admin_blocked_terms` and calls
`admin_block_term` / `admin_unblock_term` (2–100 chars, normalised lower,
ON CONFLICT no-op, audited). create_generation / create_comment /
edit_generation all consult the same denylist.

### Post editing (author)
Own-post kebab menu → "Edit prompt" opens an inline editor on the card
(textarea, 4000-char cap, blocklist, `edit:` 15/60s budget) →
`edit_generation` RPC returns the full row; the card repaints from the
returned row. The RESPONSE text is immutable by design (community record).

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
- `edit:{uid}` 15/60s in-DB (edit_generation); relay IP bucket
  `grantrevoke` 6/600s for /admin/revoke_grant flips.

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
  - Any shipped change to a precached file: bump `CACHE` in `sw.js` AND the
    `precache-fingerprint` comment (taste.js recomputes both; CI gates it).
  - Version-coupled files stay in the network-first `CORE` lane
    (`community.js` + `community-data.js` + `community.css` travel together);
    only vendored/stable assets may be stale-while-revalidate.
  - Render serves `index.html` for `/`, `/workspace`, `/g/:id`, `/u/:handle`,
    `/u/:handle/post/:id` (alias; routeHash normalizes it to the canonical
    `/g/<id>` detail), `/admin` (server.js); everything unmatched gets the
    styled `404.html`.
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
