# ARCH BRIEF ALIGNMENT — arch.md vs deployed Impose (2026-09-19)

Comparand: production state verified in `docs/FINAL_CLOSURE_AUDIT_PRODUCTION_2026-09-19.md`
(object-by-object prod dump, live probes, 0023 fixes applied).
Stack as deployed: Supabase free-tier-class project (Postgres + GoTrue + PostgREST + custom OTP),
FastAPI relay + static site on Render free tier, self-managed LLM gateway that idles to zero,
Sendlib for email. No React, no Express relay (the static file server is Express; the relay is
Python), no Realtime use, no storage buckets, no billing.

---

## A. Verdict

**Yes — the brief correlates, and it complements the architecture rather than competing with it.**
Roughly three quarters of Parts I–II describe the system *as it actually runs*: the brief's
contracts (§7 create-generation param surface, §13 column-level mutation, §14 RPC-as-business-
action, §20–21 workspace CAS, §22–23 idempotency, §36–39 capability admin, §90–92 lineage/counters)
are verbatim what the audit verified in production bodies and RLS. The codebase reads as built
from this spec.

The remaining quarter splits into:

- **~10% stale** — the brief describes things production has already moved past (§C).
- **~15% roadmap** — gap-closure addendum A1–A20, mostly NOT yet implemented and mostly NOT
  needed at current scale (§D). Almost all of it is implementable at **$0**; only managed
  backups/possibly MFA/plan-scale items sit behind payment, and every one has a free-tier
  alternative (§E).

One genuine architectural disagreement, not drift: **§2/A1 vs BYOK**. The brief's correction
says "the browser never holds provider credentials of any kind." The shipped product is
deliberately BYOK: user provider keys are sealed (AES-GCM, device- or passphrase-wrapped)
inside the 3 MiB `workspace_state` blob and decrypt only in the user's browser. This is a
scope decision, not an accident — the relay never touches BYOK traffic. Keep it as a stated
exception or redesign; do not silently treat one as the other.

---

## B. Correlation map (brief ↔ production, verified)

| BRIEF | PRODUCTION TRUTH | STATE |
|---|---|---|
| §1–2 browser never authoritative; one canonical owner/datum | Verified: all writes via SECURITY DEFINER RPCs or column-scoped PATCH; ownership matrix in audit artifacts B–D | **MATCHES** |
| §5 profiles (owner-only writes, handle quota, spam-shape) | `update_my_profile`/`customize_profile` RPC-only writes; handle quota + spam-shape rules live | **MATCHES** |
| §6–8 generations contract + post states | `create_generation` param surface exactly as specced; soft-delete/locked/visibility server-enforced | **MATCHES** |
| §9 comments | Contract matches; **thread depth cap is client-side only** (MAX_REPLY_DEPTH walk-up), brief wants server-side | MATCHES except depth cap |
| §11–13 RLS defense-in-depth, column mutation control | Verified live: table-level grants = read nearly-nothing; UPDATE only `locked/visibility/deleted_at`, comments `deleted_at`; profiles none | **MATCHES** |
| §14 RPC design | 40 RPCs all business actions; error contract via SQLSTATE (42501/22023/53100/40001/P0001..) | **MATCHES** (form differs from §29 JSON envelope) |
| §15–16 transactions & triggers | In-tx side effects (counters, notifications via triggers); notify triggers verified; no hidden business flows | **MATCHES** |
| §17 notifications | ID references ✓; **no `dismissed_at`**; dead targets are *hidden* by join filter (aligned badge in 0023), not "content unavailable" | MATCHES w/ philosophy delta |
| §18 reports | Dedupe (target,reporter) + 20/hr ✓; **no `reviewer_id/resolution/resolved_at` columns ever existed** | PARTIAL |
| §19 waitlist→grant state machine + §57 grant function | Matches, and 0023 hardened the two holes the brief implies (silent revocation, status oracle) | **MATCHES** |
| §20–21 workspace CAS | `rev` bigint, row-lock CAS, `stale_workspace`, conflict toast with keep-mine/load-newest | **MATCHES** |
| §22–23 idempotency | Global single `key` unique (not `(user,operation,key)`), replay returns stored row, budget post-replay; daily purge = 24h replay window | MATCHES w/ narrower shape |
| §24–29 optimistic UI, action states | community.js pending/failed/stale/retry + adoptServerRow; durable outbox re-enabled 0023-fix | **MATCHES** |
| §30 error taxonomy | SQLSTATE+message codes; frontend *does* parse message strings in places (forbidden by §29) | PARTIAL |
| §31–34 rate limits & resource caps | `rate_hit` fixed-window engine, per-user/op budgets, bot global ceiling, payload/size caps verified in bodies; no `Retry-After` return; no IP layer on authed ops | MATCHES (minor gaps) |
| §35 relay SSRF abuse posture | Relay key-gates admin, public tier for search, per-process OTP limits now backed by DB floor; SSRF/redirect validation **UNVERIFIED** (files.py/media paths not fully audited) | PARTIAL / UNVERIFIED |
| §36–39 admin capability model | `admins` + `admin_capabilities` + cap-gated RPCs, owner/last-admin guards, action budgets | **MATCHES** (minus MFA/audit, §D) |
| §40–43 constraints, FK lifecycle, soft-delete | Verified 24 FKs with deliberate delete actions 0023; **no retention purge** of soft-deleted content | MATCHES except purge |
| §44 realtime = sync, not truth | **Realtime unused entirely** (polling `feed_since`); nothing to secure — divergence by design, $0-friendlier | DIVERGES (deliberate) |
| §45–48 cache/session/multi-tab | User-keyed caches, logout sweep verified, rev-based multi-device reconcile | **MATCHES** |
| §49–51 observability | debug-bus local diagnostics; no request_id-to-DB correlation, no metrics pipeline | PARTIAL / ABSENT |
| §52–54 performance | Keyset cursors in `feed_page`/`profile_web` (no offset), bounded pages; PostgREST `max-rows`/timeouts **UNVERIFIED** | MATCHES (verify caps) |
| §55–56 definer discipline | search_path pinned + schema-qualified bodies + EXECUTE restriction verified; **owners are `postgres`** (hosted platform reality vs "non-superuser owner" text) | MATCHES (except owner clause) |
| §61–65 expensive ops, UNKNOWN outcome | Addressed-post budgets incl. global ceiling; client timeout; unknown-outcome resolved by idempotency replay (hardened) | **MATCHES** |
| §71–74 leak/test matrices | Executed in the closure audit (anon/role probe matrix) + relay test suites | **MATCHES** |
| §75 storage/media | **No storage buckets at all** (storage list = []); images are dataURLs inside the workspace blob | OUT OF SCOPE |
| §76–79 migrations/deploy/health | Object-parity verified; deploy blueprint declared; relay status endpoints exist | **MATCHES** |
| §80–83 cleanup jobs | 3 pg_cron jobs live-verified (auth codes, idempotency, rate counters) | **MATCHES** |
| §84–89 admin hardening | Capability guards ✓; **MFA ✗, audit_events ✗**; **relay `/admin/sign-in-as` = impersonation tool** — brief forbids impersonation outright | PARTIAL + one conflict |
| §90–92 lineage/counters/saves | Lineage/counters trigger-derived ✓; saves decided LEGACY and **dropped in 0021** — exact compliance with the brief's "no zombie" demand | **MATCHES** |
| §101 DoD | Closure audit executed against this bar (report verdict + fix phase) | **MATCHES** |

---

## C. Where the brief is stale relative to production

1. **§4/§6/§90–92 `saves` + `save_count`** — dropped by migration 0021; UI normalizes legacy fields only.
2. **§18 reports reviewer fields** — never existed; resolution is status-only via `admin_resolve_report`.
3. **"Express relay"** — the privileged relay is FastAPI (`backend/relay/server.py`); Express serves only the static site.
4. **"React / PWA"** — vanilla ES modules + `impose-standalone.html` build; PWA shell exists (manifest/sw).
5. **§17 `dismissed_at`** — notifications have `read_at` (+UPDATE policy) only.
6. **§A1's §2-correction** — collides with shipped BYOK sealed-key design (see Verdict).
7. **Realistic error envelope §29** — PostgREST SQLSTATE responses, not the JSON envelope; don't retrofit the envelope, the taxonomy (§30) is what the client uses.

---

## D. In the brief, NOT in current scope (all implementable at $0 unless flagged)

| ITEM (section) | WHAT IT WOULD TAKE | $0 PATH |
|---|---|---|
| Jobs pipeline + SKIP LOCKED workers, leases (A2/A8) | `jobs` table, relay worker loop, polling | pg_cron already free on this project; single relay worker is enough at MVP. **Skip for now** — generation is synchronous with a global 12/min bot ceiling, exactly the back-pressure the brief wants |
| Transactional outbox table (A3) | `outbox` table + relay publisher | $0 SQL + relay cron. The one real hole today: OTP/grant **email** redelivery is best-effort (grant email failure surfaces to operator; OTP resend is manual). DB-side notifications are already in-transaction |
| `audit_events` (§39/A11) | table + inserts in cap RPCs | $0 migration; closes the "who granted what when" gap incl. relay `/admin/grant` and `/admin/sign-in-as` |
| `quota_counters` + spend breaker (A7/A9) | table + same transaction as insert | $0 SQL pattern mirrors `rate_counters`. Today's practical breaker: `bot:global` 12/min + the LLM box idles to stopped when unused |
| Webhooks/billing/entitlements (A6, BILLING domain) | — | **N/A** — no payments; do not build |
| Reports review metadata (§18) | add `resolved_by/resolved_at/note` + RPC change | $0 migration |
| Content moderation in/out (A4) | blocklist table, rules, appeal path, DMCA page/endpoint | $0: extend existing `text_is_spammy` + a `blocked_terms` table + moderation queue UI you already have via reports. Provider-side AI moderation costs API spend — skip; DMCA is docs + endpoint, $0 |
| Data export archive (A5) | RPC assembling own rows as JSON | $0: export RPC (bounded sizes). "Export chats" already exists client-side. Skip storage+signed URLs |
| Erasure semantics (A5 vs 0023) | chose hard-cascade in `delete_my_account` | Brief prefers anonymize-where-referenced (`[deleted user]`). Policy decision — both $0; current behavior is cleaner but removes comment history |
| Retention purge for soft-deleted content (§43/§81–83) | pg_cron job deleting `deleted_at < now() - interval` | $0 — **cheapest open hygiene item**, same pattern as the 3 existing cron jobs |
| Admin MFA (A11) | TOTP enrollment | **Possibly PAID** (plan-gated on Supabase; verify in dashboard) → see §E |
| Admin session step-up / revocation (A11) | re-auth for destructive ops; revoke-all | **$0**: you already own a full OTP stack (`auth_codes`). Require a fresh `consume_auth_code < 10 min` for destructive cap RPCs (compare against `issued_at`), and add a relay endpoint calling GoTrue admin sign-out with the service key. No subscription needed |
| Realtime (§44/A15) | publication membership, channel auth | $0 within free quotas — recommend **staying with polling**; nothing to fix |
| Media pipeline, buckets, signed URLs (§75/A14) | storage bucket, lifecycle sweeps | $0 within free 1 GB storage **if** media features ever land; alternative: Cloudflare R2 free 10 GB zero-egress. Currently nothing to build |
| Edge WAF/bot (A10) | CDN in front | **$0**: Cloudflare Free plan in front of Render; Cloudflare Turnstile (free) on `join_waitlist`/OTP endpoints — recommended, complements the B-04 IP budget |
| SLOs/alerting/metrics (A12/§50) | pings, dashboards | **$0**: UptimeRobot free (HTTP check relay `/health` + static site every 5 min — also keeps Render warm); Grafana Cloud free tier; `pg_stat_statements` already enabled — snapshot slow queries into a table via a weekly pg_cron job |
| Backups + restore drills (§76/A12) | managed backups | **PAID on platform** (Pro $25/mo) → free path in §E |
| Status page (A12) | page | $0: static page on the existing Render site |
| Log retention beyond platform | drain | $0: Render logs cover the relay; optional Better Stack / Axiom free tiers if ever needed |
| Migration CI lint (A16) | GitHub Action running `supabase db lint` against shadow DB | $0 (GitHub Actions free) |
| PostgREST `max-rows`, `statement_timeout` per role (§54/A16) | `alter role … set` | $0 SQL; currently **UNVERIFIED** — cheap close: set `statement_timeout`/`lock_timeout` for `authenticated`/`anon` |
| `handle_history` (A13) | table + trigger on handle change | $0 migration; impersonation defense |
| Server-side comment depth cap (§9) | CHECK in `create_comment` | $0: 5-line RPC change |
| `Retry-After` semantics (§31/A17) | return seconds in error payload (relay already has the budget math; DB functions can encode `rate_limited:<secs>` in message) | $0 code change |
| Impersonation conflict (A11 vs relay `/admin/sign-in-as`) | remove endpoint or wrap with audit + owner-only | $0 — **decision needed**: the brief forbids impersonation; the relay ships it under CONTROL_KEY |

---

## E. Things that cost money / are plan-gated — flagged, NOT applied

1. **Managed daily backups — Pro plan, $25/mo (PITR add-on $100/mo).**
   Free tier has **no platform backups** [4](https://axonbuild.com/blog/supabase-backup/). 
   **$0 alternative (recommended):** a GitHub Actions nightly workflow that runs `pg_dump`
   (direct connection string, free) into an artifact/private-repo release (private repos get
   2,000 CI minutes/mo free; a nightly 2-minute dump uses ~60). DB is currently megabytes.
   Quarterly restore drill = restore dump into a scratch Supabase project (free tier allows
   2 projects) and run the audit's parity queries.
2. **Supabase plan scale ceilings** [1](https://apicostcalc.com/supabase.html): free = 500 MB DB,
   1 GB storage, 50k MAU, and **free projects pause after ~1 week of inactivity**. Not a cost
   today; watch DB size (`workspace_state` blobs up to 3 MiB/user are the growth driver) and
   keep the UptimeRobot ping so the project never idles into a pause.
3. **Admin MFA (TOTP) (A11)** — plan-gated on Supabase (verify in dashboard; historically Pro).
   **$0 alternative:** step-up auth via your existing custom OTP: destructive cap RPCs require a
   code issued < 10 minutes ago; relay exposes "revoke all sessions" via GoTrue admin. TOTP can
   also run fully self-hosted later if wanted — nothing in the brief forces the hosted version.
4. **AI moderation APIs (A4)** — per-call provider spend. **$0 alternative:** the heuristics path
   in §D or a small classifier on the Lightning box (only runs while the box is awake anyway).
5. **Realtime at scale / larger egress / log retention** — growth-trigger costs, not features.
   Free quotas are generous for MVP; revisit only when dashboards say so.
6. **Render always-on web service** — free tier sleeps after 15 min idle (you saw cold starts in
   the OTP probe). Paid would be $7/mo-ish. **$0 alternative:** UptimeRobot ping every 5 min
   keeps the relay and the LLM-wake path warm, which is what the relay's own idle_monitor was
   designed around.

Nothing else in the brief requires spending money. Every other gap item above is SQL, a cron job,
or a relay code path on infrastructure you already run.

---

## F. Recommended $0 closes (small, high leverage, no scope creep)

1. `audit_events` table + writes from cap RPCs and the two relay admin paths (§D row 3).
2. Soft-delete retention purge cron (§D row 9).
3. `statement_timeout`/`lock_timeout` on `anon`/`authenticated`; verify `db-max-rows` (§D row 15).
4. GitHub Actions nightly `pg_dump` + first restore drill (§E-1).
5. UptimeRobot monitor on static site + relay `/health` (§D row 14 / §E-6).
6. Decide the impersonation question: remove `/admin/sign-in-as` or audit-event every use (§D row 19).
7. Cloudflare Free + Turnstile in front of the two public write surfaces when convenient (§D row 13).
8. Server-side comment depth check to match §9 (§D row 17).

Each maps one-to-one to a brief section and each costs $0 on the current stack.
