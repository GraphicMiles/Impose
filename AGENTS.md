# AGENTS.md - field manual for agents working on Impose

You are inheriting a living product, not a codebase. This file is the
operating manual: how the pieces fit, which data drives which data, the
deploy/test machinery you must not break, every failure we have already
paid for, and the working agreements the owner enforces. Read it before
touching anything. The canonical references it leans on:

- `docs/BLUEPRINT.md` - every surface, flow, rule, provider, and limit.
- `docs/DATABASE.md` - every table, policy, trigger, cron job, and RPC,
  generated from the live catalog.

Doc policy (owner rule): these THREE are the only docs in the repo. Update
the relevant ones in the SAME commit that changes the system. Standing
reports/audits are not docs: they live in `/home/user/` outside the repo.

Trust hierarchy when something disagrees with reality: code > tests that
run > these docs > your priors. Comments in this codebase explain WHY a
line looks the way it does (the mechanism), never what the next line does.

---

## 1. What is running in production

One-page vanilla-JS/CSS app (no framework, no bundler). Three deploy
surfaces, all free tier by design:

| Surface | Deploy mechanism | Runs |
|---|---|---|
| `impose-web.onrender.com` (Render, blueprint-managed via `render.yaml`) | auto-deploy on push to `main` of `GraphicMiles/Impose` | `server.js` (Express): static files with `extensions:['html']`, explicit app routes, then catch-all → `404.html` with status 404 |
| Supabase project `xgqcvuzkeaferjsnpjjw` (eu-west-2) | migrations applied incrementally (see §5) | Postgres+RLS+RPC+pg_cron - the only authority |
| `impose-relay.onrender.com` (Render web service) | redeploy of `backend/` | `backend/relay/` FastAPI: OTP mail, AI gateway, CONTROL_KEY admin ops. ZERO persistence by contract |

Product = two modes in one shell: **Community** (public AI post feed with
threads, remix/challenge lineage, notifications, profiles) and **Workspace**
(private chat with an encrypted-at-rest synced blob). The URL alone decides
the chrome before first paint: `index.html`'s inline boot script sets
`body.community-mode` for every route except `/workspace` and `/admin`  - 
community.js re-derives the same fact later; the two must never disagree
(the historical paint-flash bug). Auth pages have the same contract via
`<html data-auth-view>`. Every inline script is CSP-sha256'd in
`render.yaml` (`_headers` exists for parity but Render ignores it - the
yaml is what ships); edit an inline script → recompute the hash
(`agent/tests/taste.js` recomputes and fails on drift; recipe in `_headers`).

## 2. How a request flows (and who is authoritative)

- Browser loads the shell; `lucide.min.js` icons, embedded-SVG avatars
  (`avatars.js`), `debug-bus.js` event tap, `config.js` (publishable keys only).
- `app.js` = app-shell controller: session boot, workspace state machine,
  menus, export/delete account, error surfacing.
- `community.js` = community domain: feeds, threads, detail, profile,
  outbox retry queue (in-memory by contract), optimistic writes,
  reconciler render engine. `renderDetail` reuses `buildCard` - the post
  header has ONE markup source and ONE CSS source.
- `community-data.js` (`window.BotoData`) = the ONLY Supabase transport in
  the client (REST/RPC, auth via `auth-client.js`) + `shape(error)` →
  stable typed UI error codes. Error codes are an API: the DB raises
  `workspace_not_granted`, `parent_gone`, `thread_too_deep`,
  `content_blocked`, `recent_auth_required`, `rate_limited`,
  `stale_workspace`, `bootstrap_used`, `idempotency_key_reused`,
  `prompt_length`, `invalid_term`, `name_too_short`,
  `name_needs_letter_or_digit` - a renamed error breaks the client.
- `workspace-sync.js` = the blob synchronizer: push via `save_workspace`
  (rev CAS), pull via direct SELECT under RLS, sealed at rest
  (AES-GCM, `impose.wsk.{uid}` device key, cache `impose.cache.{uid}` v2
  v0 wrapper; conflict handler = server-rev-then-force-push).
- `access.js` = waitlist + workspace-grant gate (10-min client cache,
  fail-closed on expiry, fail-open only on transient error).
- Relay = stateless: OTP issue/verify (relay memory + DB floors in
  `auth_codes`/RPCs), `/admin/*` CONTROL_KEY ops with service key
  (grant/revoke/revoke_sessions, audit parity with the RPCs), LLM gateway
  proxy + wake/idle of the self-hosted GPU box. Module layout owns state
  explicitly: `relay/settings.py` holds every mutable container and tests
  mutate it there; monkeypatch helpers on the module that CALLS them.
- Database = the authority. Triggers maintain derived data; RLS enforces
  visibility; RPCs are `security definer` with pinned `search_path`,
  called only via PostgREST named arguments; 5 pg_cron jobs do all periodic
  work (nothing on Render, nothing else anywhere). Free-tier realities:
  Render web services sleep after 15 min idle, Supabase pauses after ~7d
  inactivity - those are $0-posture behaviors, not incidents.

## 3. Which data affects which data (the causal graph)

Read this before changing any table, trigger, RPC, or client write path.

- **generations (posts)**
  - INSERT only through `create_generation` (idempotent uuid key). Client
    outbox retries with the SAME key - replays must return the original
    row; the blocklist check runs AFTER the replay lookup so a term
    blacklisted later can never brick a retry.
  - `remix_of` ⇒ `set_generation_root` fills `root_id` ⇒
    `recount_lineage` maintains `remix_count`/`challenge_count` on ancestors;
    lineage INSERT sets `notify_on_lineage` → parent author's inbox.
  - `visibility`/`deleted_at`/`locked` gate EVERYTHING downstream: the
    generations INSERT policy refuses remixes/remix parents that are
    locked/deleted/invisible; the comments SELECT policy follows generation
    visibility - hide or delete a post and its entire comment thread
    disappears with it (by design).
  - Soft delete = PATCH `deleted_at` by author (only PATCH-granted column);
    `purge_soft_deleted` cron (weekly) hard-deletes >90d. The client mirrors
    the 90-day rule (`MIRROR_RETENTION_DAYS`); soft-delete cascades to the
    row's comments.
  - `updated_at` via `touch_updated_at` on any UPDATE - edit_generation
    (prompt-only) bumps it; feed reprojections must respect it.
- **comments** - INSERT only via `create_comment` (depth ≤ 2 server-side,
  `thread_too_deep`; `comment_parent_matches` guards parent∈same post;
  per-user AND per-post rate buckets). INSERT → `notify_on_comment` (owner
  + parent author inbox, guards missing actor profile) and
  `recount_comments` → `generations.comment_count` (the counter the feed
  displays; drift = recounts). DELETE/UPDATE recount too.
- **profiles** - written by `handle_new_user` trigger (signup clone) and
  `customize_profile` only. `handle` changes: quota 3/21d
  (`username_changes_count`, `username_quota_exhausted_at`) and
  `record_handle_history` archives dropped handles (impersonation defense).
  Display names obey ONE contract enforced in SQL
  (`sanitize_display_name`, check bounds + `profiles_display_name_no_emoji`
  from 0027, NOT VALID by design) and mirrored in the client
  (`BotoUI.validProfileName`). **Change the rule in both places or users
  see "accepted by UI, refused by DB".**
- **workspace_grants** - existence of a row is the workspace capability.
  Checked three ways: `save_workspace` RPC (definer), `my_workspace_access`
  (readback), `workspace_state` RLS policies via **security-definer helper
  (the 0028 rule: a policy predicate must never read a table the caller
  has no grant on - predicates run at INVOKER privilege; use a helper)**.
  Revoke → `workspace_revoked` inbox notification → the very next
  `save_workspace` raises `workspace_not_granted`; the 10-min client cache
  converges harmlessly after.
- **notifications** - every privileged/peer action has a kind; kinds are
  enumerated in the `notifications_kind_check` constraint AND rendered by
  the client bell sheet. **A new kind must be added to the check
  constraint first** - an INSERT violating it half-fails a bigger RPC
  silently (0026). Retention: read rows >30d purged nightly, unread persist.
- **idempotency_keys** - uuid `key`, `request_hash`, `response`. Same key +
  same body → original response; same key + different body →
  22023 `idempotency_key_reused`. Purged >24h - a late cross-day retry can
  legitimately re-execute; client budgets tolerate it.
- **rate_counters** - fixed-window rows `(bucket, window_at)`;
  `rate_hit(bucket, limit, seconds)` returns true = OVER limit, caller
  raises 53100 `rate_limited`. Ladder documented in DATABASE.md (gen 8/m,
  bot 3/m+12 global, com 15/m+5/post, rep 20/h, ws 30/m, adm 30/m,
  exp 3/h, del 3/h, edit 15/m, handle 3/21d).
- **auth_codes / auth_tickets** - OTP rows, relay keeps a parallel memory
  copy (multi-instance resets are tolerated; DB is the durable floor with
  attempts/lockout FOR UPDATE). Ticket = one-shot redeem → GoTrue session.
- **waitlist** - `join_waitlist` constant-shape (no status disclosure);
  approval links `user_id` on signup and `handle_new_user` auto-grants
  workspace. `admin_grant` (or relay `/admin/grant`) is the ONLY grant path.
- **admins / admin_caps / admin_action_caps / admin_bootstrap**  - 
  `require_cap(action)` = is_admin + cap mapping; OWNER = zero cap rows =
  all caps. Guards: `owner_protected`, `last_admin`, `last_capability`
  (rollback-by-reinsert), one-time bootstrap claim (production: CLAIMED  - 
  `admin_bootstrap_status` is `pending:false, claimed:true`; tests must
  assert that, not pre-claim state). Step-up (`require_recent_auth(900)`,
  42501) on `admin_remove`, `admin_revoke_cap`, `delete_my_account`  - 
  the OTP ceremony mints the fresh `iat`.
- **audit_events** - `audit_log()` inside privileged RPCs + relay
  service-key inserts; actor SET NULL so account deletion keeps history;
  reads only via `admin_audit_events`.
- **Service worker (`sw.js`)** - `CORE` list = network-first
  (version-coupled app code), `PRECACHE`+SWR list = cache-first with
  background update. **community.js + community-data.js + community.css
  travel together**: serving an old CSS against new markup was a live
  incident class; only vendored/stable assets may ever be SWR.
  `CACHE = "impose-shell-vNN"` + `precache-fingerprint` comment must move
  together (see §4). `404.html` is NOT precached (it is only ever served
  online by the catch-all).

## 4. Deploy mechanics (exact contract)

**Client (push to main → Render auto-deploy):**
1. Any change under the precache lists (§3 SW): bump `CACHE` version AND
   recompute the fingerprint:
   `node -e` replicating taste.js (hash every "./x.js|css|html" ref in
   sw.js except .min, sha256, first 12 hex) - taste does it for you and
   prints the expected digest on failure if you skip this.
2. Any change to `index.html`, `styles.css`, `community.css`, the agent/
   files, `community.js`, `community-data.js`, `app.js`, vendored js:
   regenerate `impose-standalone.html` (`python3 build_inline.py`); CI's
   `--check` fails otherwise.
3. Push with the PAT remote:
   `https://x-access-token:PAT@github.com/GraphicMiles/Impose.git`
   (commit author `rfarouq69 <rfarouq69@gmail.com>`).
4. Verify live with curl after deploy - don't trust deploy logs: asset
   presence, `/sw.js` version field, deep-path 404 behavior.

**Database (`supabase/migrations/`, currently 0001-0028 applied):**
- Apply incrementally ONLY: `./supabase/apply.sh <first-unapplied-file>`
  applies that file and every later one, in order, via the session pooler
  (`aws-0-eu-west-2.pooler.supabase.com:5432`; free-tier direct connection
  is IPv6-only = unusable from GitHub Actions; Management API
  `GET /v1/projects/{ref}/config/database/pooler` yields the DSN template).
- FULL replay against production is DESTRUCTIVE (0001/0007/0022 contain
  `truncate`/seed semantics) - that incident already happened; the
  `supabase-migrate.yml` workflow carries an anchor argument that MUST be
  bumped to the next unapplied migration after each successful deploy.
- CI workflow `.github/workflows/supabase-migrate.yml`: `verify` job
  replays 0001→latest on a scratch PG and runs
  `supabase/tests/schema_test.sql` (must stay green); `apply` job runs the
  anchored incremental apply against prod (dry_run default true).
- Nightly backup: `db-backup.yml` → `pg_dump` artifact (30d retention) via
  the dedicated BYPASSRLS-read-only role `impose_backup` (DSN in repo
  secret `SUPABASE_DB_URL`; NEVER store the `postgres` role in CI).
  pg_dump does NOT carry cron jobs - migrations are the source of truth
  for all 5 (re-apply recreates them).
- Migration authoring rules (DATABASE.md golden rules): identity args are
  the API (byte-identical uuid/citext or drop the old overload - overloads
  make PostgREST ambiguous and BREAK the live endpoint); idempotency key
  is uuid; new tables default-deny (RLS on, no policies) and
  `rls_auto_enable` will quietly enable RLS on manually created tables;
  policies need `drop policy if exists` before create.

**Relay:** Render web service redeploy of `backend/`; env in the dashboard
(CONTROL_KEY, SUPABASE_URL/SERVICE_KEY, SENDLIB_*, model gateway keys,
ALLOWED_ORIGINS). `pytest` suite must pass.

## 5. Test contract

Run locally before every push (cheap): 

```
node tests/smoke_community_render.js     # reconciler/render engine (jsdom; install: npm install --no-save jsdom)
node agent/tests/taste.js                # design/invariant suite - see baseline below
node agent/tests/{run,features,lifecycle,orchestrator,audit-regressions}.js
node tests/workspace_sync_roundtrip.js   # blob sealing round trip
python3 build_inline.py --check          # standalone artifact current
PYTHONPATH=backend python3 -m pytest backend -q        # relay
```

`taste.js` baseline on `main` as of 2026-09-20: **11 known-failing tests**
(pre-existing owner debt, tracked, do not “fix” by editing the assertions
to match drift - fix the thing or leave the red):
`no em-dash or en-dash anywhere in authored source`;
`every authored public asset is copied by the Render build`;
`avatars.js is registered everywhere a root asset must be`;
`the /admin path rewrites to the app ahead of the 404 catch-all`;
`the grant email endpoint checks the same contract as the RPCs`;
`the delete plan is written down and traceable`;
`a live repaint does not discard what someone is typing`;
`a queued write is honest about not being sent`;
`a deep link works on a browser that has never seen the post`;
`the comment kebab menu cannot outlive what it points at`;
`the three comment actions stay three different actions`.
**Your change must not add failures** - diff `FAIL` lines before/after.

Higher-fidelity harnesses (use before shipping risky write paths):
`tests/simulate_29_accounts.js`, `tests/simulate_100_users.js`,
`tests/adversarial_100_user_stress.js` - full lifecycle sims that caught
the idempotency/constraint defects; `supabase/tests/schema_test.sql`
replays full history and asserts RLS/effects (`test_denied` distinguishes
silent-deny from silently-permit - a policy both-denying is a SECURITY
BUG, not a pass).

## 6. If you touch X, also check Y (coupling matrix)

| Change | Also required |
|---|---|
| inline script in `index.html`/`auth.html` | recompute CSP sha256 in `render.yaml` (taste gates) |
| any precached file | `CACHE` bump + fingerprint recompute in `sw.js` |
| index/styles/community.css/agent files/community*.js/app.js | rebuild `impose-standalone.html` |
| `404.html` | NO relative `href`/`src` ever (served at arbitrary depth; taste gates); fallback nav in `public.js` root-absolute |
| new RPC visible to PostgREST | keep identity-arg discipline + add it to `schema_test.sql` + DATABASE.md row + `shape()` mapping if it raises new codes |
| new rate limit / bucket | DB ladder row + relay counterpart audit |
| new `notifications` kind value | UPDATE `notifications_kind_check` FIRST, then client sheet copy (0026 incident) |
| display-name rule change | BOTH `sanitize_display_name` AND `BotoUI.validProfileName` |
| new admin action | `admin_action_caps` row + `require_cap` call + audit event + step-up decision + admin.js surface |
| policy reading another table | never: make it a `security definer` helper (0028 incident) |
| header/card markup | verify against the card-grammar contract (one-line identity: name truncates → handle truncates → flex:none islands for time/badges; action rows space-evenly) |
| notification bell / modebar controls | all cluster buttons are plain flex children of `.modebar-right`, equal square size (34px); absolute-in-absolute overlap was a live defect |
| post route shapes (`/g/:id`, `/u/:handle`, aliases) | `routeHash()` normalization + server.js clean routes + sitemap/RSS lists + 404 catch-all ordering |
| blocklist term timing | stays AFTER the replay lookup in create RPCs (retroactive terms must not brick pending retries) |
| `workspace_grants` semantics | sync RPC + policy helper + relay parity + 10-min client cache tolerance |
| error code text | grep the client `shape()` map first - stable API |
| SW lane membership | only vendored/stable assets may be stale-while-revalidate; coupled code travels network-first together |

## 7. Incident ledger (what failed, the mechanism, the tripwire)

Every fix in this repo should end with a tripwire. These are the ones we
already own - do not relearn them.

1. **Unstyled 404 at path depth (2026-09-20).** `404.html` used relative
   `./` references but server.js serves it AT the offending URL;
   `/index/home`, `/billing/index.html` rendered bare; `public.js`
   back-button fallback also re-404'd. Fix: root-absolute everything +
   drop duplicate script tags. Tripwire: taste asserts 404.html has zero
   relative refs and its destinations resolve via server.js.
2. **Notification bell overlapping the avatar (2026-09-20).**
   `.cm-scope .notif-btn` was `position:absolute` inside the (absolute)
   `.modebar-right`: stacked 4px over the avatar at a different size.
   Mechanism: absolute positioning resolves against the nearest positioned
   ancestor - inside a cluster, never absolute a member for placement.
   Fix: bell is a plain flex child, `position:relative` only to anchor the
   unread dot, 34px to match the avatar.
3. **“Posts not truncating” (2026-09-19/20).** Real root fix landed in
   `32390e7` (card grammar: single nowrap `gen-id`, name/handle
   min-width-0 ellipsis, flex:none badges). Residual reports traced to
   stale service-worker CSS (pre-v69 SWR lane), NOT code - verified the
   production bundle serves correct rules. Lesson: version-coupled assets
   must share a lane (see SW rules); don't ship CSS-only fixes without the
   version bump.
4. **Full-replay migration against production (2026-09-20).**
   supabase-migrate applies once replayed from 0001 and died on
   `relation "profiles" already exists` - 0001/0007/0022 are data-
   destructive on re-run. Fix: incremental anchor mode in `apply.sh`;
   workflow pins anchor `0027_…` then bumped after each successful apply.
   Also: `apply.sh` had an unreachable duplicate `fi` - bash -n fails on
   it although execution never reached it (bash parses incrementally);
   lint scripts wholesale, not just the path you expect to run.
5. **workspace_state silent denial for everyone (0023 → 0028).**
   Policies subqueried `workspace_grants` at invoker privilege where
   clients hold no grant → EVERY workspace pull denied. Mechanism: RLS
   policy predicates execute as the querying role. Fix: definer helper +
   `my_workspace_access` readback. An RLS test that silently denies exactly
   like the bad policy is NOT a pass - assert effects, not errors.
6. **Half-applied admin_revoke_grant (0026).** New notification kind
   `workspace_revoked` wasn't in `notifications_kind_check`; the revoke
   RPC errored at the notice insert after deleting the grant row. Rule:
   enum/check constraints are write-path dependencies. Caught by the
   29-account production simulation, not review.
7. **OAuth-free overload break (historical).** `CREATE OR REPLACE` with
   changed identity args created a second overload; PostgREST named-arg
   calls went ambiguous and the live endpoint broke. Rule: identity args
   immutable or explicit DROP of the old signature.
8. **`p.id = remix_of` name capture (historical, flagged by reviewer).**
   An unqualified identifier inside a SQL function resolved to the FUNCTION
   ARGUMENT, not the table column; every legitimate remix was refused.
   In bare SQL, `a = b` captures arguments first - qualify columns.
9. **Auth hidden-view flash.** Sign-up/OTP deep links painted the sign-in
   form first because every auth view except sign-in shipped hidden and
   auth.js painted after parse. Fix: `data-auth-view` boot attribute +
   CSS paint. Same class of fix as the community chrome boot script.
10. **Stale debug panel (2026-09-19).** Precached JS shipped behind an SW
    that never refreshed it. Fix: fingerprint comment tied to cache name;
    taste recomputes both.
11. **Modebar/community paint flash (2026-09-19).** Auth-shell painted
    workspace chrome on community routes then re-dressed. Fix: inline boot
    decides from the URL; `showMode()` derives the same fact.
12. **Card grammar regressions.** Left-edge action buttons (margin-left:auto
    patterns), icon+count imbalance, emoji display names breaking header
    line-height - fixed with space-evenly rows, fixed-action geometry,
    plain-text names (0027 + `validProfileName` mirror). The rule: no
    margin spacers, no absolute positioning inside flex rows, icons are
    never alignment siblings of unstyled text.
13. **Workspace sync zero-key accounts (2026-09-{19,20}).** Accounts with no
    grants saw their blob silently unsynced; plus dead cloud images and a
    cloud-source icon fallback parade. Fixed in `a4c3526` + `32390e7`
    (fallback source resolver, seal contract v2). Assert no plaintext key
    reaches storage in `tests/workspace_sync_roundtrip.js`.
14. **CI harness replay drift (2026-09-20).** schema_test.sql had drifted
    from post-0022 production truth (bootstrap already claimed, dup grants).
    Fix in `52a0cd9`: assert post-claim truth, re-claim becomes a negative
    test. Keep the harness replaying REAL history - it exists to catch
    sequelae of production state, not a clean-room world.
16. **Dead CSS from a scope mismatch (2026-09-20).** The notification bell
    rendered as an unstyled native button - its rule was `.cm-scope`
    prefixed, but index.html mounts the modebar OUTSIDE `#cmMain`.
    Dead selectors fail silently: no warning, the skin just never lands.
    The same class killed the unread dot, the whole `#cmNotifSheet` skin,
    and the mobile tab-shrink. Detector method: walk each element the CSS
    targets to its nearest `.cm-scope` ancestor (jsdom), or load the markup
    in headless Chrome and read `getBoundingClientRect`/`getComputedStyle`
    (the probe lives in the incident notes under /home/user). Fixed by
    scoping selectors to where elements actually live, plus a taste
    tripwire asserting the prefix can never return.
17. **Top-aligned siblings of different heights read as broken
    (2026-09-20).** An absolutely-parked side cluster can only top-align
    against a taller centered capsule; the modebar is a symmetric grid
    (`minmax(0,1fr) auto minmax(0,1fr)` - side tracks MUST be minmax-0 or
    the wider cluster inflates its track and the capsule stops being
    dead-centre), and the cluster `align-self: center`s on the shared row
    line. Verified at 340-412px in a real browser: bell/dot/avatar/capsule
    share one center line; capsule centered at every width.
18. **Render edge serving soft-404s (observed 2026-09-20, NOT fixed).**
    Deep extensionless fake paths return the styled 404 body with HTTP 200
    through Render's Cloudflare edge (`s-maxage=300`), while the node
    server natively returns 404 and extension-bearing paths get a true 404
    (`noindex` covers SEO). Mechanism is in Render's edge rules, not our
    code - if behavior matters someday, investigate dashboard rewrite/CSP
    settings rather than changing server.js blindly.

## 8. Failure modes that are BY DESIGN (never "fix" these)

- Waitlist constant-shape responses (anti-probe); handle-quota errors
  mention only the quota.
- In-memory outbox: a hard refresh before drain loses an optimistic write  - 
  accepted; idempotency keys make replays safe.
- First-device blind workspace overwrite (null expected_rev) for the legacy
  path; later devices CAS.
- Free-tier sleeps: Render web service after 15 min idle; Supabase project
  pause after ~7d inactivity.
- `profiles_display_name_no_emoji` is NOT VALID on purpose - existing rows
  reclassified instead of being force-migrated.
- Bootstrap forever `claimed` in production - never reset it to satisfy a
  test; tests assert the claimed world.
- Delete-for-me/sender semantics and undo votes are silent on the
  requester's own server-view (sender soft-deleted ⇒ their own RPC-pull
  projections diverge until hard refresh) - that's the anti-double-vision
  contract.

## 9. Working agreements (owner rules, enforced in review)

- Exactly three repo docs (`AGENTS.md`, `docs/BLUEPRINT.md`,
  `docs/DATABASE.md`); docs change in the same commit as the system.
  Reports/audits/sim results → `/home/user/`, never the repo.
- No masking defects: never loosen a test to match drift; a fix carries a
  tripwire (assertions/gates); bisect to a mechanism before fixing  - 
  unprovable claims stay UNVERIFIED in the report, named as such.
- Comments say WHY (the mechanism and the failure it prevents), are
  ASCII-only, no em/en dashes anywhere in authored source (taste tests it;
  the suite itself is the bar for copy quality).
- One transport (`BotoData.db`), one card builder, one name-validator per
  language; reuse over clone - "no spaghetti, no rigid single-purpose
  functions".
- Client validation mirrors server rules; server remains the authority.
- Minimal diffs on harnesses; sims (29/100-user) before shipping risky
  write-path changes; skip nothing because "it looks safe" (the bypass
  that skipped replay checks floated one incident already).
- Commit as `rfarouq69 <rfarouq69@gmail.com>`; push via the PAT remote;
  verify production with curl after every deploy; state in the report what
  you could NOT verify.
- Secrets: the repo never contains any; PAT + Supabase tokens live in user
  hand-off/CI secrets only (rotation advice outstanding for the old ones).
