# Impose — Senior Product & Production Audit

**Date:** 2026-09-18 · **Commit audited:** `7557b57` (main, CI green, deployed) · **Scope:** entire repo (web PWA, Python relay, Supabase schema/migrations, standalone build, docs) + live production probes (Render services, Supabase Management API, HTTP surface).
**Method:** read-only. Nothing in this document was changed. Every claim is tagged:
`[Confirmed]` = verified in code/schema/live system this session · `[Inferred]` = reasoned from confirmed evidence, not directly observed · `[Recommended]` = proposed change, no fact claim · `[Experimental]` = unvalidated idea.

---

## 1. Executive Summary

Impose is a bring-your-own-key AI chat workspace (single-page vanilla JS PWA, 9k lines) with a public community feed backed by Postgres (RLS + security-definer RPCs), a thin Python relay (provider proxy, SSRF-safe fetcher, OTP auth mailer, operator admin APIs), an agent runner, and a DB-rooted capability console.

**The data layer is genuinely strong** — writes flow exclusively through definer RPCs with `auth.uid()` pinning, idempotency-key replay protection with request-hash binding, per-verb rate ceilings, keyset pagination, trigger-maintained counters, soft-delete-only content, and a realtime channel that degrades to polling. This is not demo-grade.

**The product layer is where the risk lives.** The findings that matter:

1. **[Confirmed] The waitlist queue position has never existed.** `waitlist.position` is `NULL` for every row (live-verified: the only real row has `position = None`) because no migration ever assigns it. The admin console renders `#null · joined …` (app.js:8325), and `access.js` silently falls back to generic copy, so users never see a number. The feature was *designed in, shipped half-built, and nobody noticed* — the exact failure mode this audit exists for.
2. **[Confirmed] The per-account workspace has no write arbitration.** `save_workspace` is unconditional last-write-wins over the *entire* payload (0016:75-83); `rev` is only consulted at boot (workspace-sync.js:289-318). Two open tabs, or a phone and a laptop used in parallel, silently overwrite each other's whole workspace. This is the highest-severity data-integrity issue in the product, and it is newly load-bearing since the round-4 move to account sync.
3. **[Confirmed] `relayKey` — the single most powerful credential in the system — is stored unsealed.** `WSync.seal` encrypts only `providers[].apiKey` (workspace-sync.js:242); `settings.relayKey` (owner CONTROL_KEY when pasted, by design app.js:7541/7837) travels plaintext through the localStorage cache, `workspace_state`, and across devices. Anyone with read access to that blob can mint workspace grants, send mail, drain fetch budgets, and call `/v1/fetch` as the owner.
4. **[Confirmed] Trust is structurally single-tenant.** One relay control key gates every owner capability and every elevated budget tier (`PUBLIC_TIER` defaults to 1, i.e. *all* browser users are tier-0 against a shared relay). Fine for a pilot; a wall for anything bigger. The capability layer (0018) built the right second axis — it just doesn't reach relay auth yet.
5. **[Confirmed] UGC trust/safety is half of the required triangle.** Report exists (0015 + UI). **Block users does not exist. Account deletion does not exist.** Google Play's UGC policy and Apple 1.2 require in-app report *and block* plus timely moderation action; the report queue is view-only in-product (no resolve RPC — the relay only *fetches* reports, reports_store.py:49-65).
6. **[Confirmed] Brand drift at user-visible seams.** Every HTML title, the manifest, the settings version row, and legal pages say **Botocracy**; the repo, deploy, and admin pages say **Impose**. The version row claims "Keys and chats stay in this browser" — untrue since account sync shipped.
7. **[Confirmed] Scheduled hygiene exists but never runs.** `purge_rate_counters`, `purge_idempotency_keys`, `apply_thread_retention`, `notify_retention_sweep` are all defined; **no caller exists anywhere** (zero hits in backend/, no pg_cron confirmed live). Latent unbounded growth on write-heavy tables.
8. **[Confirmed] Path routes escape the cache policy.** `render.yaml` cache rules match `/`, `/*.html`, assets — but not the rewritten routes: `curl -I` shows `/` → `no-cache` while `/admin` and `/sign-in` → `public, max-age=0, s-maxage=300` (edge-cached for 5 minutes). No data leak (the HTML is public), but it defeats the deploy-freshness design intent for exactly the pages that change with capabilities and auth UX.
9. **[Confirmed] Post-`[DONE]` retry is a duplicate-generation risk.** The relay retries the provider call once when `[DONE]` never arrived (server.py:925-937) — but the browser's SSE parser already forwarded every delta to the UI, so a mid-stream cut can replay the whole generation into the user's chat, and the DB post fires twice on *different* idempotency keys (app.js:4186 uses `Date.now()` per attempt).
10. **[Inferred, strong] There is no session lifecycle handling at all.** Zero `onAuthStateChange` subscriptions anywhere (grep-verified); `BotoAuth._user` is a memory snapshot refreshed only at boot and after sign-in. Expiry mid-session is surfaced only as raw "session expired" errors from `verify_otp`/`mint_workspace_access`, and realtime dies silently (reloginBtn was deliberately removed as dead code, community-data.js:880-884).

Positives worth preserving, deliberately: RLS everywhere with definer-RPC boundaries; idempotency; keyset feeds; realtime→poll degradation; honest-failure toasts with retry affordances; soft deletes that keep threads intact; SSRF-pinned fetcher; capability console with per-cap audit trail; offline outbox with per-chat caps; deterministic local avatars; legal pages that don't overpromise. The repair job below is additive — the core is sound.

**Bottom line:** Impose behaves like a careful small product *inside* its happy path and a half-finished one at its edges — multi-device use, queue mechanics, account lifecycle, moderation closure, and brand-level self-description. Priority 1 (fix-broken) is a short list; the architecture needs no rewrite.

---

## 2. Current Architecture Map

```
Browser (PWA, 9.0k-line app.js shell; 3.3k-line community.js feed UI)
 ├─ localStorage (per-device cache) ──┐
 │   impose.workspace.v1 (per-uid, rev-stamped)   ┌ workspace-sync.js (WSync)
 │   impose.agent.v2 (per-uid trace store)        │ seals providers[].apiKey (WebCrypto,
 │   impose.auth.v1 (session mirror: name/email)  │ key in Supabase user_metadata.ws_key)
 │   impose.outbox.v2 (outbox lives inside payload)──► pushes 600ms-debounced full payload
 ├─ BotoAuth (auth-client.js) → Supabase GoTrue auth (OTP-only; password reset path)
 ├─ BotoAccess (access.js) → RPCs: my_workspace_access / join_waitlist / redeem_access_code
 │                            (+ 10-min cached grant, sessionStorage)
 ├─ BotoData (community-data.js) → PostgREST: RPC writes (create_generation, save_comment, …)
 │                            + feed_page/feed_since keyset reads + Realtime "community"
 │                            channel (generations/comments/notifications) → 25s→90s poll fallback
 ├─ Providers (OpenAI/Anthropic/Gemini/Ollama/LM-Studio/self-host…) — keys live in browser,
 │   called DIRECTLY from the browser (anthropic header explicitly enables this, app.js:1031-1060)
 └─ BotoRelay (optional proxy; base + key from settings.relayUrl/relayKey, 90s timeout)
      https://impose-relay.onrender.com (Python/uvicorn, free tier, sleep-to-zero)
       ├─ /v1/chat/completions — authed (session JWT or control key) provider proxy, SSE passthrough
       ├─ /v1/fetch /v1/read /v1/file /v1/source/catalog /v1/image-convert — search/proxy utilities,
       │   PUBLIC_TIER=0 budgets vs owner/agent-tier (10×) budgets, SSRF-pinned dial
       ├─ /v1/auth/otp/{request,verify} /v1/auth/password/reset — GoTrue bridge (SendLib mail)
       ├─ /notify/grant — session-cookie path; RLS can_do('admin:grant') decides
       ├─ /admin/* (status, accounts, grants/revoke, wake-llm, reports) — CONTROL_KEY only
       ├─ ⚠ NO maintenance endpoint exists — the purge/retention RPCs live only in
       │   SQL (0004 defs, service_role grants in 0008) with zero callers anywhere (confirmed)
       └─ in-memory rate buckets, caches, cold/wake flags (die on redeploy/free-sleep)

Supabase project xgqcvuzkeaferjsnpjjw
 ├─ GoTrue: signup disabled (relay-mints only), autoconfirm off, password_min_length 8
 ├─ Postgres (RLS on all public tables; 18 migrations; 0 storage buckets — none used)
 │   profiles · waitlist · workspace_grants · generations · comments · saves ·
 │   notifications · reports · workspace_state · auth_codes/tickets · idempotency_keys ·
 │   rate_counters · admins · admin_capabilities · admin_action_caps · admin_bootstrap
 ├─ Realtime publication "supabase_realtime" = generations, comments, notifications (live-verified)
 └─ Management-API migrations (no git→DB automation; apply-by-hand step exists in docs)

Deploy: Render free tier ×2 (static site + relay), Cloudflare in front
Build: scripts/build_inline.py → dist/index.html + impose-standalone.html (file:// build,
       same code, all remote features disabled at runtime by file: origin checks)
Tests: 6 node agent suites (51/63/14/24/7…) · pytest backend (178) · schema harness
       (schema_test.sql against real postgres) · audits/taste.js · audits/relay.py ·
       audit of payload sizes/inline scripts
```

---

## 3. Feature Inventory (what actually exists, per surface)

| Surface | Exists | Notes (state as of `7557b57`) |
|---|---|---|
| Chat workspace | Yes | folders, pin/lock/archive, search (local scan app.js:6669, cap 12), export/import JSON, retention rules, images as data URIs (size-capped), streaming with stop, retry, humanized errors (explain()), memory rows, agent runner with per-uid trace store + replay |
| Providers | Yes | 11 presets incl. local (LM Studio default URL) + self-host/custom; browser-direct calls; keys sealed in workspace sync; no server custody |
| Account / auth | Yes | OTP email sign-in (6-digit, 5-min TTL, 5-try cap), password reset, mint-on-verify, per-email 3-account cap, grant gate (approved / self-mint / redeem code) |
| Waitlist | **Half** | join + idempotency + spam/domain guards + 100k cap `[Confirmed]`; **position never computed** `[Confirmed bug]`; approval → workspace_grants → email notification `[Confirmed]` |
| Community feed | Yes | post/reply/remix/save/report, keyset feed (≤50), realtime+poll, signed-out read-only, profile pages (profile_by_handle), locked-thread self-lock, addressed/mention counters |
| Moderation | Half | reports table + submit RPC + admin view (rate-limited) `[Confirmed]`; **no resolve/lock-user/hide-content action RPC** `[Confirmed]`; lock exists but only self-service |
| Safety per-user | No | no block/mute, no user-level report, no rate identity beyond per-account DB caps + per-IP relay caps |
| Account lifecycle | No | no in-app deletion/erasure, no email change, no export-everything-from-server (client-side export only) |
| Admin `/admin` console | Yes | 7 tabs (Status/Accounts/Grants/Wake/Waitlist/Reports/Capabilities), 8 capabilities + 9 action contracts, bootstrap one-time owner claim, per-cap audit trail, anon-exec blocked (live-verified last round) |
| Standalone build | Yes | file:// full app; relay-dependent features disabled by origin check |
| PWA/offline | Yes | sw v60 fingerprint busting, precached shell, outbox queue (cap 20/chat) with banner, offline-queue dedupe (app.js:4326) |

**Feature honesty check (user-visible claims vs reality):** "You are number N" fallback copy never appears with a number (position NULL) — the copy handles it gracefully `[Confirmed]`; admin waitlist row shows `#null` — **does not** handle it `[Confirmed]`; version row "Keys and chats stay in this browser" — **false** since per-account sync `[Confirmed]`; privacy/data-security pages describe browser-first custody and *avoid* claiming server-side erasure — honest but silent on what the server keeps `[Confirmed]`.

---

## 4. Data-Flow Map (the load-bearing traces)

**T1 — Send message (the flagship flow)**
Intent (composer keydown) → `canSave()` guard → buildRequest (provider-shaped) → `relayFetchReq` *only if* user configured relay, else direct browser→provider → SSE deltas into assistant bubble → on `[DONE]`: if `autoPublicChat`, `saveGenToCommunity` with `idempotencyKey = chatId:msgId` (stable) or `post-<ts>` (manual, **unstable** app.js:4186) → `create_generation` RPC: parent visibility/lock checks → `rate_hit('gen',uid,8,60)` → idempotency `FOR UPDATE` + hash compare → insert → trigger counters (reply_count, mention notifications, addressed flag) → response: id + rate info → UI: optimistic node replaced by server id, feed refetch on next view. Failure paths: `rate_hit`→toast "slow down" `[Confirmed]`; idem mismatch → `idempotency_key_reused` error (user sees generic post-fail toast; retry then *bypasses* idem since new ts-key — see §8); network death → outbox enqueue (v2, cap 20/chat) + banner; mid-stream provider cut → relay single retry re-streams whole answer (dup risk, §1.9).

**T2 — Workspace save (the risky one)**
Every state mutation → `save()` (app.js:858+) → localStorage cache write → `BotoWorkspace.persist(payloadObj)` → seal providers (apiKey only) → 600 ms debounce → `save_workspace(p_data)` RPC: size ≤ 3 MiB → `rate_hit('ws',uid,30,60)` → upsert `(uid)` with `rev = rev+1`, `updated_at = now()` — **no expected-rev parameter, no rejection, full-row overwrite** (0016:60-83) → response rev → lastRev=max, cache rev bumped. Read side: boot only (`load()` → remote.rev > lastRev → adopt + reload) `[Confirmed]`. Consequences: concurrent writers lose data silently; no cross-tab `storage` listener in the workspace shell (unlike community.js:3243) `[Confirmed]`.

**T3 — Sign-in**
OTP request (relay, per-IP 12/h + per-addr 6/h `[Confirmed]`) → GoTrue generateLink → SendLib email → code in `auth_codes` (hash+pepper, single-use, 5 tries, 5 min) → `verify_otp` → auth ticket → GoTrade session → `create_pending_user` (profile + waitlist link + mint-on-verify) → sessions persist via supabase-js (`persist:true, autoRefresh:true`) `[Confirmed]` → no `onAuthStateChange`: every component re-reads `BotoAuth._user` at boot `[Confirmed]`.

**T4 — Admin grant**
`/admin` Grants tab → `relayFetch("admin/grant")` with CONTROL_KEY (owner) — or browser session hitting `/notify/grant` (must pass `can_do('admin:grant')` in Postgres) → `create_workspace_grant` (definer) → email via SendLib → grant cache on applicant side refreshes within 10-min TTL or on redeem/refresh `[Confirmed]`.

**T5 — Realtime & notifications**
`supabase.channel("community")` on 3 tables (publication live-verified) → events bump feed + unread count (count always *refetched*, not optimistically inc'd — multi-tab-safe `[Confirmed]`) → channel error/close → poll 25 s → after 2 failures back off to 90 s, resume on `visibilitychange` (hidden tab stops polling) `[Confirmed: community.js:2258+ poller]`.

---

## 5. Read & Write Audit

**Reads.** Feed: keyset `feed_page` (≤50, `least()` clamp — anon probe with `p_limit:9999` returned normal capped payload `[Confirmed live]`), partial index `(created_at desc, id) where public+alive`; thread: `thread_for` one-shot + `feed_since` count-only delta (cheaper than refetch — good); profile: `profile_by_handle` public fields only. Workspace read: one full-payload fetch at boot (whole JSON parsed; 3 MiB ceiling bounds it). Over-fetching is low; the *absence* of any server-side search over feed text is a gap §9 (community "search" = local chat scan + relay-backed web search; there is no `ILIKE` feed search RPC — `[Confirmed]`). Expensive-query DoS: bounded by RLS+RPCs+keyset+caps. Param manipulation: all feed params go through RPCs with clamps; PostgREST direct SELECTs are limited to `generations`/`profiles` with column-grants — the direct `saves`/`notifications`/`reports` selects are the residual surface (see §10.5).

**Writes.** Every write is an RPC; table-level INSERT/UPDATE/DELETE revoked (0004:219-227, live-verified in prior rounds). Server owns: ids, timestamps, counters (triggers), status transitions, rate accounting, soft-delete. Client supplies: prompt/response text (length-checked 1..4000 / ≤20000), visibility/lock/kind booleans-and-enums, parent id (validated), idempotency key (opaque uuid/ts), workspace payload (opaque, size-capped). Atomicity: insert+counter+notifications are one RPC transaction `[Confirmed]`. Duplicates: idem layer binds request hash; **browser only supplies a stable key for auto-share; manual posts use a timestamp key that changes on retry** `[Confirmed: app.js:4186]` — retry-after-error duplicates are possible by design-of-key, not prevented. Mid-flight death: outbox handles posts; workspace survives via local cache; comment writes have no offline queue (fire+toast) `[Confirmed]`. Retried-after-commit-lost-connection: `create_generation` idem row would already be committed → same-ts retry returns replay ✓, different-ts retry creates dup (same caveat).

---

## 6. Permission Matrix (resource × actor — enforced at the boundary, not in UI)

Actors: **anon** (no session), **user** (any verified), **waitlisted** (no grant), **member** (workspace grant), **moderator** (cap subset), **owner/admin** (CONTROL_KEY or full caps), **system** (relay service_role, definer RPCs).

| Resource | anon read | user read | user write | who may mutate others' rows | admin | notes |
|---|---|---|---|---|---|---|
| generations (public) | ✅ feed/profile | ✅ | insert own via RPC; save/report others via RPC | self-lock own; **no delete-by-author via UI path?? — soft-delete RPC is owner+admin** `[Confirmed 0013:215-266]` | ✅ hide/lock | counters via triggers only |
| generations (own, private) | ❌ RLS | ✅ owner | update visibility/lock/delete owner-only | ❌ cross-user blocked at RLS+policy (audited) | relay admin can lock via `admin_lock_generation` | direct-table UPDATE revoked |
| comments | public readable | ✅ | own only; thread-locked check inside RPC | parent-author can lock thread (self-service) | ✅ | 15/min + 5/min/thread `[Confirmed 0014]` |
| saves | via `saved_by_me` in feed_page | ✅ own | toggle own (RPC) | ❌ | — | denormalized count trigger |
| notifications | ❌ | owner only (RPC + grant) | mark-read own | ❌ | — | count refetch = multi-tab-safe |
| reports | ❌ | submit only | — | ❌ user cannot resolve | view (cap) — **no action at all** `[Confirmed gap]` | `admin:reports` view + `admin:resolve` action defined, action RPC missing |
| waitlist | join via RPC (anon) | own status | — | ❌ | approve/reject via relay admin (CONTROL_KEY) | 100k cap; **position NULL forever** `[Confirmed bug]` |
| workspace_state | ❌ | owner-only RLS | full-overwrite LWW `[Confirmed hazard]` | ❌ | — | 3 MiB, 30/min |
| workspace_grants | redeem code (anon) | own status | consume own | ❌ | mint/revoke | 10-min client cache TTL `[Confirmed access.js:19]` |
| profiles | handle/display/bio public | ✅ | update_own_profile (sanitized) | ❌ | relay-level edit | email never exposed publicly `[Confirmed]` |
| auth_codes/tickets/idem/rate | ❌ zero grants | ❌ | definer-internal | — | maintenance RPCs | purges never scheduled `[Confirmed]` |
| admins + 3 cap tables | ❌ | ❌ | ❌ direct (all revoked) | via admin RPCs (is_admin pinned) | ✅ | 0018 bootstraps owner once |
| provider keys | never server-side | owner browser | browser-local; apiKey sealed, **relayKey plaintext** `[Confirmed]` | — | — | ws_key in user_metadata |
| relay endpoints | health/models public | tier-0 budgets | owner-tier elevated | `/v1/fetch` = arbitrary GET/POST for any authed key holder `[Confirmed design]` | 6 admin endpoints | authfail 15/min/IP lockout-ish budget |

UI↔boundary mismatches found: (a) admin waitlist UI *renders* position though it can never exist (§1.1); (b) the app offers no report-on-*user* although `reports.kind` enum includes user-style kinds — submit path wires content reports only `[Inferred from enum vs call sites]`; (c) "block user" affordances absent entirely (see §9); (d) version row claims browser-only custody (§3); (e) nothing *else* — capability gating was verified to be at-RPC, not at-renderer, in the round-8 audit `[Confirmed]`.

---

## 7. UI ↔ System Consistency

- **Success-on-failure:** post path toast distinguishes rate/idem/transport (`humanizeUserError`) `[Confirmed]`; comment composer maps DB errors to copy `[Confirmed]`; **workspace push failure is *not* surfaced** — the persist `.catch` swallows (workspace-sync.js:332-334, comment: "next save pushes it") — honest by design (local is truth) but the *multi-device* user never learns the server copy is stale `[Confirmed]`.
- **Backend-success-no-UI:** grant cached up to 10 min → approved-but-"still-in-waitlist" window after email arrives; `access.js` exposes `refresh()` but the waitlist done-screen doesn't auto-refresh on focus `[Inferred; code shows no focus hook]`.
- **Refresh changes behavior:** yes, deliberately (boot adopts remote rev — a reload can *replace* unsynced local edits? No: adopt only when `remote.rev > lastRev`, and lastRev is bumped after each push; but a tab that pushed A then edited B *within* the debounce and then reloads keeps cached B — consistent `[Confirmed reading of :381-394]`).
- **Stale info:** 404 page serves branded content at HTTP **200** (pre-existing rewrite behavior `[Confirmed live probe]`); feed list uses `refreshThreadOnly` precisely to avoid composer repaint bugs `[Confirmed comment :999-1006]`.
- **Loading/empty:** poller pauses on hidden tab (no fake liveliness) `[Confirmed]`; realtime absence shows nothing (silent degradation — correct); feed empty states exist per round-4 UI audit.
- **Mobile/desktop:** PWA shell identical; `/admin` grid responsive per round-8 taste gates; community.js touch targets audited via taste (119/119) `[Confirmed]`.
- **Dead ends found:** admin `#null` (user can't act); reports tab has no next action; locked thread = terminal for everyone including author except unlocking own thread (author self-unlock exists `[Confirmed 0013:246-266]`); banned-but-session-live users keep feed read until session expires (no revocation channel — see §10.7).

---

## 8. Production Failure Audit (what happens when things go wrong)

| Failure | Current behavior | Assessment |
|---|---|---|
| Double-click / rapid post | dedupe only where idem key is stable; manual post key = `Date.now()` per attempt → **double post possible** `[Confirmed]` | fix by keying on content hash |
| Refresh mid-stream | stream aborts; partial assistant msg lost (persistence on completion); outbox unaffected | acceptable; documented? no `[Inferred]` |
| Close tab mid-save | debounced push may be lost; `flushNow()` on visibilitychange covers most (verify all 3 lifecycle hooks) — cache is local truth anyway | OK for single device, worsens §1.2 multi-device |
| Network dies posting | outbox queue (cap 20/chat) + banner + drain-on-online; drain suppressed while streaming `[Confirmed 4723-4772]` | good |
| Network dies saving workspace | local cache persists; server copy diverges silently; next online save overwrites — **collision resolution = latest wins, other device's chats vanish** `[Confirmed]` | Critical integrity gap |
| Provider 429/5xx mid-stream | relay retries whole call once after `[DONE]` miss → duplicate visible text; browser `explain()` maps 429/402/401 to sentences `[Confirmed]` | High annoyance risk |
| Auth expired mid-session | supabase-js autoRefresh covers normal case; if refresh fails: raw "session expired" from RPCs, feed goes read-only-ish silently, realtime stops (no relogin affordance — removed as "dead" `[Confirmed]`) | High UX risk |
| DB down | reads: empty feed + error toasts (community path shows "Could not reach…" — honest); writes: outbox; workspace: local continues | graceful `[Confirmed]` |
| Relay asleep (free tier) | 503 on wake-sensitive endpoints; admin Wake tab + `[DONE]` 503-wake single retry `[Confirmed]`; browser relay path: 90 s timeout + "check key" hints — cold-start of a user-configured relay surfaces as generic failure `[Inferred]` | Medium |
| Suspended/banned user | **no ban primitive exists in product** (waitlist 'rejected' blocks *approval*, not feed access; no status on profiles) `[Confirmed gap]` | feeds §9/§10 |
| Huge payloads | prompt 4000 / response 20000 / relay 10 MB / /v1/fetch 1 MB / workspace 3 MiB, all enforced server-side `[Confirmed]` | solid |
| Malformed payloads | RPCs raise typed errors → humanized toasts `[Confirmed]`; relay `_json_obj` guards `[Confirmed]` | solid |
| Storage quota | trim-oldest-images retry then honest toast `[Confirmed app.js save()]` | good |
| Rate limit hit | server-side: typed `rate_hit`/`too_many` surfaced; relay: in-memory buckets **lost on every redeploy/sleep** `[Confirmed]` | note: budget resets are an exploit (single instance, low value — Medium not High) |
| Multi-tab workspace | no `storage` listener; both tabs push full payloads; last writer wins **per push**, so interleaved edits destroy each other `[Confirmed]` | Critical (same as §1.2) |
| Partial failure of third-party (SendLib) | mailer is single-attempt — raises `MailFailed` on any transport error, no retry (mailer.py:102-144 `[Confirmed]`); OTP request surfaces a 502 to the user (correct), grant approval email loss leaves the grant row valid → login works even if mail dies `[Inferred from RPC order]` | acceptable, but a one-retry wrapper is cheap `[Recommended]` |

---

## 9. Incomplete Journeys (ranked by user harm)

1. **Second device / second tab** — works for reads (adopt), broken for concurrent writes (full-payload LWW). The round-4 promise ("your data follows your account") fails the *simultaneous* case. (Critical)
2. **Waitlist journey** — join → "we'll email you" → approval email → refresh grant → workspace. Complete **except** the position promise (`#null`/never-shown) and no "leave waitlist" (can't withdraw an email). (Medium)
3. **Reporting a person** — can report content; cannot report a user; blocked/harassed users have **no block**, no mute, nothing between "report" and "email the operator". Play-UGC/Apple-1.2 explicitly require user-block for social surfaces. (High — compliance + safety)
4. **Leaving the product** — no account deletion, no server-side data export, no erasure path (DB + GoTrue + workspace + waitlist row). Privacy page only covers *browser* data. (High — legal posture; the pages are silent, which is honest, but a public product with accounts needs the door)
5. **Moderation closure** — reports land in a viewable queue with `status`; **nothing in-product transitions it** (no resolve/lock-user/soft-delete-by-admin RPC despite `admin:resolve` cap existing). Operator = someone with SQL. (High — it's the difference between "moderated" and "moderatable")
6. **Notifications journey** — insert→refetch-count→badge→open→mark-all-read works; but no deep-link state (opening a notification re-derives via `thread_for` one-shot — fine), no email/push escalation (acceptable for pilot). (Low)
7. **Password reset** exists end-to-end (relay+GoTrue) but product is OTP-primary — two auth journeys, one barely advertised; fine. (Low)
8. **Search** — no community content search at all (only handles/profiles + local chats). A feed that's *about prompts* without prompt search is a discoverability gap. (Medium product gap)
9. **Onboarding** — grant-landed users hit an empty workspace with zero seeded examples; community is read-only pre-grant but nothing routes "browse first → join → come back". The gate order (feed → waitlist → email → app) is right; the *return* leg depends entirely on email deliverability. (Medium)

---

## 10. Security Audit (ranked by real severity)

1. **[Critical-at-scale / Confirmed] Shared owner credential.** CONTROL_KEY is pasteable in settings by design and yields grants, mail, wake, ×10 budgets, `/v1/fetch`. Single-user pilot: acceptable and documented; multi-user: Critical (no per-key scoping — capability model stops at Postgres, doesn't cover relay). Fix path: relay honors session JWT for admin routes (`/notify/grant` already proves the pattern) + retire pasted-key mode for non-owner users. `[Recommended]`
2. **[High / Confirmed] `relayKey` plaintext everywhere** (localStorage cache, `workspace_state` payload, `settings` blob — WSync seals apiKey only). XSS or device-read = full owner surface; cross-device sync *replicates* it. Fix: add `settings.relayKey` to the seal set (already has the crypto path), or never sync it (device-local like `relayUrl`? — currently it *is* synced). `[Recommended]`
3. **[High / Inferred] No CSP upgrade hazard today, but the app is XSS-adjacent-heavy** (markdown render of model output + comments). If a sanitizer gap exists, findings 1-2 become remote. (Audited earlier rounds: rendering is escaped; keeping `object-src 'none'`, two inline hashes `[Confirmed headers live]`.) Treat as a standing risk to re-probe, not a finding.
4. **[Medium / Confirmed] Grant/revocation staleness:** 10-min client grant cache + zero server-side revocation push (realtime publication excludes `workspace_grants`/`admins`). A revoked user keeps workspace until cache ages out (writes still fail at RPC? — `my_workspace_access` is *advisory*; enforcement lives inside each write RPC's own grant check `[Confirmed pattern in 0013]`), so this degrades to stale-UI, not stale-authz. Keep, note it.
5. **[Medium / Confirmed] Direct PostgREST SELECTs on `saves`, `notifications` (own rows) and `reports` (admins)** bypass RPC-level shaping. Rows are already owner/admin-scoped by policy — exposure = *extra columns* (`ip_hash`? on saves: no; notifications: read flags/timestamps; reports: full report rows incl. reporter reasoning). Low-value but it's the one place where column-grants aren't minimal. Trim column grants. `[Recommended]`
6. **[Medium / Confirmed] Relay in-memory rate buckets reset on cold start** (redeploy/free-sleep). Postgres-side caps (gen 8/min, com 15/min, ws 30/min, authfail) hold the real line; relay budgets (search/fetch) refillable by hammering deploys. Low-value, note.
7. **[Medium / Confirmed] No session revocation primitive.** Suspended/leaving users' JWTs ride to expiry (GoTrue default 1 h / refresh 30 d `[Inferred defaults]`); no way to force-logout (no admin "sign out everywhere" RPC). Matters for the ban journey that doesn't exist yet (§9.3/5).
8. **[Confirmed-solid / keep] SSRF posture on `/v1/fetch`:** `_resolve_public_ips` any-fail rejection, IP-pinned dial with Host+SNI preserved, redirects never followed, cookie/host/content-length stripped, 1 MB cap, 60/min — verified line-by-line. `create_generation` parent checks, idem FOR UPDATE, soft-delete-only, `addressed` persisted server-side, `locked` enforced in both policies and RPCs. This layer needs no rewrite.
9. **[Low / Confirmed] 404 at HTTP 200 on unknown routes** (rewrite behavior) — SEO hygiene, not security.
10. **[Low / Confirmed] `PUBLIC_TIER=1` toggle semantics:** flipping it to 0 would *reject* all browser-relay users; the code treats wrong key as public-tier rather than "deny" — correct for a demo product, flag for any monetization change.

---

## 11. Performance & Scalability

Live (15 MB DB, 11 users): **nothing hurts yet** — that's the honest baseline. Structural read of the design:
- Feed reads O(limit) via keyset + partial index `[Confirmed]`; thread reads one-shot `[Confirmed]`; counters denormalized by triggers (no COUNT(*) per render) `[Confirmed]`.
- `workspace_state`: whole-JSON r/w at boot/save — 3 MiB × 30/min worst case per user is the scaling ceiling; at ~100 active users fine, at ~10 k the boot fetch (avg payload parse) and full-row WAL churn matter. Chunking per top-level key would be the future refactor `[Recommended, not now]`.
- `rate_counters`/`idempotency_keys` unbounded (no purge caller `[Confirmed]`) — the first real ops fire drill. One opportunistic sweep per N writes kills it `[Recommended]`.
- Notifications growth linear with mentions; never pruned (no retention RPC for notifications) — same class `[Confirmed by absence of purge_notifications]`.
- Realtime: 3-table publication, per-connection fanout fine on Supabase free; poll fallback already assumes loss `[Confirmed]`.
- Relay: single uvicorn, streaming passthrough with SSE `[Confirmed]`, caches are in-memory (correct for 1 instance; wrong the moment Render scales to 2 `[Confirmed PUBLIC flag + comment]`). Cold start already modeled (wake endpoints) `[Confirmed]`.
- Mobile: 9.0k-line single JS file parse — cached by SW precache after first visit; first visit pays it. Standalone/file:// unaffected `[Confirmed build_inline]`.

---

## 12. Competitor & Product Research (Phase 8, condensed)

| Product | Interaction model | Steal-worthy | Their complaints (avoid) |
|---|---|---|---|
| **ChatGPT / Claude / Gemini** | account-synced conversations, auto memory, share links | Cross-device continuity is *table stakes* (implores our §9.1); Claude praised for **transparent, user-editable memory** — Impose's explicit memory rows match the liked pattern; research: memory is locked per-platform — "provider-agnostic, user-owned memory + export" is a real, documented gap `[research: memorylake/lumichats/aimemory 2026]` | opaque memory, no cross-provider portability, keys held by vendor |
| **Poe** | multi-bot aggregator, point economy | BYOK-vs-points contrast: Impose's no-markup BYOK is the pitch | point economy complaints = the thing we deliberately don't do |
| **Perplexity** | answer-first with sources | `/v1/source/catalog` already mirrors; citations rendering is a cheap UX win | model-favoritization distrust |
| **X/Grok threads + GitHub Discussions** | thread + replies + reactions | our addressed/mention/reply graph is the same loop; GitHub's *locked-with-explanation* + *resolve-thread* states map directly to a moderation closure fix (§9.5) — proven patterns, zero novelty needed | edit-with-history expectations; report black-hole is universally hated — our no-action queue is on that side today |
| **Waitlist-gated launches (Robinhood/Grocery Picker/Discord invite eras)** | position + invite amplification | **position numbers and shareable invites *are* the retention mechanic**; our invite-grants primitive (`workspace_grants` redeem) exists and is unused as a growth loop | fake positions/phantom queues — our bug is the accidental version of the classic sin |
| **Failed-adjacent:** Felt (community browser), Airchat | social+utility hybrid | lesson: public-by-default social layer needs *moderation you can finish in-app*, and messaging-adjacent surfaces need blocking day one (Play policy text says exactly this `[research]`) | — |

---

## 13. Patterns to Adopt (with reasons) / Not

**Adopt:** (1) **Content-hash idempotency for manual posts** — the stable-key rule the auto-share path already proves right (Proven). (2) **CAS on workspace writes** (`p_expected_rev` → `stale_workspace` → merge-prompt/soft-adopt) — the optimistic-concurrency standard; cheaper than CRDTs at this payload size (Proven). (3) **Sequence-backed waitlist position + per-row `#N`** — trivially correct with `nextval` (Proven). (4) **`resolve_report`/`lock_user_by_admin` definer RPCs** gated by the existing `admin:resolve` cap — GitHub-style thread state machine (Proven). (5) **Block list as a server table enforced inside `create_generation`/`save_comment` + feed read filtering, client-fake-success at composer** (Play/Apple-dictated; fliq's pattern found verbatim in research `[Confirmed-standard]`). (6) **Account deletion as definer RPC** (delete generations→comments→workspace_state, anonymize profile, GoTrue admin-API delete user; cascade rules already exist `on delete` — the graph supports it today). (7) **`onAuthStateChange("SIGNED_OUT") → one-tap relogin pill** re-using existing markup (Proven).

**Do NOT adopt:** per-key vault/KMS (overkill: single tenant + device sealing exists); OAuth-provider login (mail-OTP is the privacy line and already works); feed search *index* (pg `websearch_to_tsquery` + GIN is enough at this scale — a search service would be needless complexity); CRDT sync engine (payload is user-owned JSON; CAS + reload prompt is honest and debuggable); realtime-presence/typing (no DM feature to serve); push notifications (PWA push on free Render+Supabase is a deploy trap; email is fine for pilot).

---

## 14. Product Improvements (UX, ranked)

1. **Multi-device conflict surfacing** — after CAS (§13.2): a one-line bar "Synced from your other device · [Reload] / [Keep this one]" (removes the silent-loss cliff and makes the flagship promise true).
2. **Reliability pill for sign-out/expiry:** silent expiry today means "app looks broken"; reuse existing `#reloginBtn` slot pattern with the removed-affordance replaced by a working one.
3. **Manual-post double-send guard:** button disable-until-ACK + stable hash key (§13.1) — kills the most embarrassing possible demo failure.
4. **Waitlist UX honesty:** show `#position` (after §13.3) *or* change admin copy to "queue age" — pick truth over theater; add "leave waitlist" (one RPC).
5. **Report completion:** "You reported this · under review" state on the item (notifications-table kind already supports messages — reuse), plus admin-side resolve in-console.
6. **Version row honesty:** "Provider keys stay in this browser; chats sync to your account, sealed." (One string; aligns claim with crypto reality.)
7. **Brand unification pass:** Botocracy→Impose in titles/manifest/legal footers — or vice versa — plus og:/manifest-name (install sheet currently says Botocracy — a real PWA-install moment).
8. **Cache headers for path routes:** make Render rules cover `/admin`, `/sign-in`, `/about`, `/guide` (match-without-extension list) — 3 yaml lines.
9. **Community search lite:** `feed_search(text, keyset)` with `websearch_to_tsquery` over prompt+response (unlocks "find that post" and doubles as the moat's data-retention story).
10. **Onboarding return leg:** after grant email, deep-link `/?granted=1` → confetti-free quiet celebration + first-post composer prefilled with a one-tap example (converts the gate moment; the feed already renders for them — the only missing step is *doing* something).

---

## 15. Moat & Defensibility

**Practical (build on what exists):**
1. **User-owned, provider-agnostic memory + workspace, syncable but sealed** — the exact gap the 2026 memory research names (every major assistant locks memory in-product; portability/ownership is the named complaint). Impose's keys-never-custody + export-JSON + per-account sealing is already 70 % of a *productable* moat. `[Confirmed assets]`
2. **The remix/provenance graph** — `remix_of`/`root_id` trees + addressed/counter triggers = a *prompt genealogy* nobody else has; ordinary actions → proprietary data (moat test passed: usage inherently writes the graph, and the graph gets more valuable with every fork). `[Confirmed schema]`
3. **Capability-gated operator console on top of RLS** (0018) — auditable, DB-rooted, no separate admin service; small enough to be free. A genuine ops differentiator vs "log into the Supabase dashboard". `[Confirmed]`
4. **Offline-first/file:// standalone + self-host story** — real (proven twice by the build), and increasingly rare; enables the "air-gapped prompt journal" wedge. `[Confirmed]`
5. **Waitlist-as-invite loop:** approved users already *can* hold redeemable codes (`workspace_grants`); wiring "you got in → here are 3 seats" turns the gate into the growth engine with zero new tables. `[Confirmed primitive + Recommended loop]`

**Harder-to-copy (structural):** the whole *no-provider-keys-on-server* posture makes "we could never train on / sell your prompts" a *checkable* claim — marketing that survives scrutiny. That's the kind of moat that only exists because of an early constraint; preserve it.

**Anti-moats to avoid:** any feature requiring content moderation at scale *before* §9.3-5 exist; DMs (compliance triangle gets bigger, not different); hosted provider key custody (kills the only true differentiator).

---

## 16. Experimental Ideas (classified, none MVP-bound)

| Idea | Class | Why it might / why it might not |
|---|---|---|
| **Lineage badges** ("this prompt descends from @ada's thread ×4") on feed cards — cheap on existing tree | Proven-adjacent / Optimization | turns the moat visible; needs no new data. Risk: vanity metric fatigue |
| **Prompt regression journal:** re-run your saved prompt across models over time, diff responses; workspace `library` + trace store already hold the parts | Differentiator | matches the "personal eval" latent need of the BYOK crowd; cost = token spend honesty UI. **Most credible product-y idea on this list** |
| **Seat-claim social proof:** "joined via @handle's invite" chip (grants table already has inviter concept via email) — invites carry reputation | Differentiator + network effect | tiny schema add; risk: gaming via alt emails (per-email caps exist) |
| Auto-memory synthesis (ChatGPT-style "dreaming") from workspace chats | Optimization | users trust *editability* more (Claude lesson, §12); ship "suggested memory rows: accept/reject" or skip |
| Agent **recipes**: share a runnable trace (orchestrator steps) as a post kind in the feed, remixable like prompts | Experimental / moat-building | unique surface (trace-as-UGC); agent store is per-uid today — needs schema thought; *do not* MVP this |
| Feed-side GIN search | Proven pattern | §14.9; deliberately boring |
| Ephemeral "challenge" rooms (root post spawns time-boxed remix round, `challenge_count` trigger already exists) | Experimental | counters exist but no state machine; only if community >~100 DAU |
| PWA push notifications | Skip | infra cost on free tiers >> pilot value |

---

## 17. Prioritized Roadmap (implementation plan — awaiting go-ahead)

**0. Do not break** (standing): taste 119/119, pytest 178, 6 node suites, schema harness, audits/relay.py — run before/after every step; migrations land as numbered files + Management-API apply (established process); sw fingerprint recompute last.

**1. Fix what's broken (small, contained):**
 1.1 Waitlist position: `nextval`-backed or count-in-advisory-lock assignment in `join_waitlist`; backfill existing NULLs deterministically by `created_at`; render `#N`; test in schema harness. *(Critical-by-honesty, half-day)*
 1.2 Admin row guard `w.queue_position ?? "—"` in the meantime. *(cosmetic, same diff)*
 1.3 render.yaml cache rules to cover rewritten routes (list the 6 paths). *(3 lines)*
 1.4 Version-row string honesty (§14.6). *(1 string; touch taste fixtures if they snapshot it)*

**2. Security (small set, no rewrite):**
 2.1 Seal `settings.relayKey` in WSync (extend seal set + migration of cached payloads: treat missing-seal as plaintext-then-sealed-on-next-save). *(the crypto path exists — contained)*
 2.2 Trim column grants on `saves`/`notifications`/`reports` to the columns UIs read; re-run privilege matrix probe (live-verified before/after, as in prior rounds).
 2.3 Document PUBLIC_TIER=0 operational mode in RENDER_SETUP (deny semantics caveat).

**3. Data integrity (the one architectural patch):**
 3.1 `save_workspace(p_data, p_expected_rev)` → `stale_workspace` error on mismatch; client: on conflict, fetch + "Synced from elsewhere — [Reload] / [Merge mine]" bar. Backward-compatible default NULL=overwrite during rollout.
 3.2 Manual-post idempotency: stable key = `sha256(chatId+prompt+response-prefix)` (mirror the auto-share path).
 3.3 Opportunistic maintenance: call purge/retention RPCs probabilistically from `create_generation` tail (1/100) *and* document a curl for operators; keeps ops fire drill optional.
 3.4 Post-`[DONE]` retry: mark resumed stream "retrying — this answer may repeat" or send provider-request id so relay can dedupe. *(server.py only)*

**4. Complete missing flows (product minimum for a public UGC product):**
 4.1 `block_user`/`unblock` + enforcement inside write RPCs and feed read filter; client fake-success composer note (researched pattern).
 4.2 `resolve_report(status, action)` definer + `/admin` Reports tab action buttons gated by the **already-shipped** `admin:resolve` cap.
 4.3 Account deletion: `delete_my_account` RPC (delete cascades per §5 of 0001 FK map) + relay GoTrue-admin user removal + confirm-typed UI. Privacy page gains the erasure section it silently lacks.
 4.4 Leave-waitlist (trivial RPC) — folds into 4.3 plumbing.

**5. Reliability:** 5.1 `onAuthStateChange` → signed-out pill / auto-hydrate swap (community feed + workspace header). 5.2 Surface workspace-push failure with "Offline — saved on this device" quiet badge (turn §7's silent-divergence into a *visible* state). 5.3 Re-add realtime death indicator (dot, not modal).

**6. UX polish:** §14.9 feed search RPC + `websearch_to_tsquery` GIN migration; onboarding return-leg deep link; "under review" chip post-report; brand pass (titles/manifest/legal footers/og).

**7. Performance:** only proactive item = GIN index above; everything else is scale-gated (workspace chunking, notifications retention) — park until DAU > ~500.

**8. Differentiation:** prompt-regression journal (16.3-adjacent, biggest ask: needs a `runs` table + provider-diff UI — propose only after roadmap 1-5 land); seat-claim invite loop on existing grants (small).

**9. Experimental backlog:** agent-recipe posts, challenge rooms, suggested-memory accept/reject. Gate: never before §4 ships; each needs its own audit round first.

*Effort read (from the code as it stands): steps 1.x and 2.x are each ≤ half-day with existing fixtures; 3.1-3.2 ≈ 1-2 days incl. harness tests; 4.x ≈ 3-5 days (schema + UI + tests, all patterns already exist in-repo to copy — 0018 shows the RPC+cap+console pattern cold). Nothing in 1-5 justifies touching the stack; the honest verdict on the architecture is that it was right, only some of it was never finished.*
