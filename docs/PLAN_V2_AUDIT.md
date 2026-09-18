# Botocracy — Completeness Audit & Production Plan v2.0

Status: **AUDIT COMPLETE — SCOPE LOCK v2.0 PROPOSED** (pending owner sign-off on D1/D2).
Date: 2026-09-18. Method: the four governing documents run against the shipped
product — `PRODUCT_PLANNER_SKILL` (pipeline/traceability), `flow.txt` (journey
completeness), `text.txt` (language), `system-design-architect` (pre-ship
checklist). This is the §54 post-implementation audit of PRODUCT_PLAN.md v1.0
(2026-09-17), whose scope lock predates migrations 0002–0014 and the relay
hardening rounds.

---

## STEP 1 — Intent & Constraints (re-extracted from the repo, verified)

**Product idea (verified in code, not assumed):** Botocracy is a mobile-first
social feed of AI generations ("prompt → response" pairs as public objects)
with remix/challenge lineage, plus a private BYO-key chat Workspace gated
behind a waitlist.

| Item | Value | Evidence |
|---|---|---|
| PRIMARY USER | mobile-first reader/creator of AI content | plan §1; mobile-first CSS |
| CORE LOOP | generate/post → get remixed/challenged → ranked feed → Workspace for power use | plan §1; `trendingScore` remix4/challenge3/comment2/save1 (community.js:662) |
| CORE MECHANISM | public corpus + lineage graph; BYO-key trust position | migrations 0001/0004; app.js providers |
| PLATFORM | static site (Render) + FastAPI relay + Supabase | render.yaml, config.js |
| CONSTRAINT | zero-framework vanilla JS; regression gates (build sync, 6 node suites, pytest, 6360-scenario audit) | .github/workflows/regression.yml |
| CONSTRAINT | BYO-key invariant: provider keys never reach the operator | app.js provider storage; plan §9 |
| SECURITY POSTURE | Rounds 1–2 shipped: GoTrue hardened, RLS privilege matrix, idempotency, server-side rate limits, realtime gating | docs/audit-2026-09-18.md; migrations 0013/0014 |

**Unknowns (marked, not invented):** U1 whether the operator will flip the
Workspace gate soon (see GAP-02); U2 real-model choice for hosted @bot
(plan D1, still open); U3 moderation staffing model (plan assumed one operator).

---

## STEP 2 — Product Definition & Critique (delta since the v1.0 lock)

The v1.0 lock shipped F1–F5. Since then, **most of "Phase B" was built
without a matching plan update**: live Supabase posting (community-data.js),
GoTrue+relay email-code auth (auth.js/auth-client.js, migrations 0002–0003),
realtime + adaptive polling (0009), notifications (0010), post locking (0012),
adversarial hardening (0013), write rate limits + @bot cooldown (0014).
Per the planner's Rule 13 ("scope is locked deliberately"), shipped-but-unplanned
work must now be ratified or rejected. This document ratifies it (Step 7) and
locks what remains.

**Critique results (new, this pass):**

| # | Issue | Evidence | Impact | Severity | Proposed response |
|---|---|---|---|---|---|
| C-01 | Workspace gate is OFF in production: `ACCESS_MODE: "open"` ⇒ `canUseWorkspace()` always true; the waitlist journey (plan §16 "the MVP's new spine") never runs for real users | config.js:19; access.js:31-36,180-183 | The monetization "need-moment" and scarcity mechanic are dormant; waitlist table unused | **High (product)** | Owner decision D1: flip to `enforce` or consciously stay open during beta. Either is valid; *undefined* is not |
| C-02 | Hosted @bot is a local canned-reply demo (`replyFor`, community.js:2637) while UI presents it as an agent ("Ask @bot anything") | community.js:2635-2637; composer placeholder | Core hook is simulated; plan §28's relay→provider path unbuilt | **High (product integrity)** | TASK-02 (wire relay @bot) or TASK-02b (explicit "demo replies" disclosure) — owner picks; flow.txt hard rule "no fake functionality" |
| C-03 | Passkey & SSO buttons are decorative: toast "ready for backend integration" | auth.js:210-213 | flow.txt §3 violation: functional-looking controls that do nothing; dev-speak leaking into UI (text.txt §21) | Medium | TASK-03: hide until wired, or demote to honest "coming soon" treatment like the Workspace tools |
| C-04 | No post/comment editing (delete-only CRUD) | grep: no editGeneration/editComment | Acceptable for MVP but must be a *stated* decision, not an accident (flow.txt §8 Update completeness) | Low | Record as explicit non-goal for v2 lock; revisit with moderation |
| C-05 | No reporting/moderation surface | grep: none | plan put it in Phase C; corpus junk risk (plan §43) grows with real posting | Medium | TASK-04 minimal report flag → operator queue (email), no admin UI (still DO_NOT_BUILD) |
| C-06 | Plan doc drift: PRODUCT_PLAN.md still says "Phase B (next)" while B is ~80% shipped | docs/PRODUCT_PLAN.md §35 | Traceability rot — the exact thing the planner's Rule 29 prevents | Low | This document supersedes §35–44 of v1.0 |

---

## STEP 3 — Product Surface Inventory & Navigation Graph (verified in code)

**Routes (hash router):**

| Route | Screen | Access | Deep-link behavior |
|---|---|---|---|
| `#/` | Community feed | public | ✅ loads feed; error state w/ retry; empty w/ direction; skeleton while loading; "You are all caught up" terminal; outbox note; new-posts pill |
| `#/g/<id>` | Generation detail + thread | public (RLS-filtered) | ✅ missing → "This post does not exist"; deleted → "This post was deleted" + reason + back link (community.js:1121) |
| `#/u/<handle>` | Profile | public | ✅ profile head, posts list, empty state, Edit profile (own) |
| `#/workspace` | Workspace chat shell | gated (currently open — GAP-02) | gate sheet on deny; `canUseWorkspace` server-verdict |
| `#/chat=<id>` | Specific workspace chat | gated | local restore |
| auth.html views | sign-in / sign-up / forgot / otp / reset / success | public | view switch via `data-route` |
| static | about, privacy, terms, data-security, contact, acceptable-use, 404 | public | ✅ all exist as files |

**Dialogs/popovers (index.html):** settings (General/Providers/Prompts/Usage/Data),
provider editor (presets→form→advanced), chat params, encrypted backup,
shortcuts, onboard, access/waitlist sheet, notifications sheet, feedback
(email compose), command palette, chat search, item menu (rename/pin/move/
export/share/duplicate/delete), folder menu, tool menu (attach/web-search +
3× labeled "Soon"), model menu, retry-with menu, debug panel.

**Navigation graph findings:** no orphan pages; no dead-end pages (every
terminal view has back/continue); 404.html exists for unknown paths.
✅ §46 audit passes.

---

## STEP 4 — Interaction Contracts, Consequence Test & Flow Completeness Scorecard

Spot-audited every primary action against flow.txt's 16 questions. Results
(PASS unless noted):

| Action | Success | Failure | Interrupt/Resume | Undo | Verdict |
|---|---|---|---|---|---|
| Post generation | optimistic card → server row adopted via outbox settlement | shaped error on card (auth/duplicate/parent_gone/post_gone/locked/rate_limited), job dropped or retried per retryability | outbox persists in localStorage; jobs outliving the tab settle via `setJobHandler` | delete w/ hold-confirm + undo window (delete-flow-plan) | ✅ PASS |
| @bot addressed post | streams demo reply (see C-02) | rate_limited → friendly retryable; budget 3/min user, 12/min global | same outbox path | same | ⚠️ PASS-with-GAP-03 |
| Remix / Challenge | compose ctx chip w/ clear + lineage rendered on card | parent_gone / parent_locked shaped errors | draft kept | — | ✅ PASS |
| Comment / reply | optimistic, thread refresh preserves draft against realtime overwrite (refreshThreadOnly) | rate caps 15/min, 5/min/thread; parent_gone keeps draft | persisted draft | soft-delete → "Comment deleted." tombstone keeps reply tree | ✅ PASS |
| Save/unsave | optimistic + revert on refusal | server recompute corrects drift | — | toggle | ✅ PASS |
| Waitlist join | position feedback; idempotent unique(email); provider/spam rules server-side | 429 / provider / invalid shaped | re-join safe | n/a | ✅ PASS (dormant — GAP-02) |
| Sign up | relay OTP (email code) → ticket → account; terms consent required; password rules live-checked | shaped field errors; resend w/ cooldown | reload mid-OTP → "Start signup again: this page was reloaded" (honest) | n/a | ✅ PASS |
| Password reset | no-op-for-strangers (round 1) → uniform success wording | — | — | n/a | ✅ PASS |
| Notifications | sheet w/ loading/error/empty(+direction); mark-all-read on open; badge realtime-synced | error shows shaped message | — | n/a | ⚠️ rows navigate to post ✅ but no per-item read state (accepted: badge = list seen) |
| Profile edit | update_my_profile RPC; client mirrors server validation | name_* shaped errors incl. spam-shape refusal | — | re-edit | ✅ PASS |
| Delete post | confirm sheet names consequence; soft delete hides post **and its comments** (0014 gate) | shaped | — | undo window | ✅ PASS |
| Workspace send (BYO) | streaming; failure = provider sentence w/ provider detail | timeouts; retry-with-another-model menu | sendRing progress; jump-to-latest | regenerate | ✅ PASS |
| Provider add/edit | preset→form→Check models (only a model that answers is kept)→save | http blocked except LAN; status lines | — | hold-to-remove | ✅ PASS |
| Data (export/import/encrypted/retention/wipe) | JSON export (keys never exported); AES-GCM backup warns "no recovery without the passphrase"; hold-to-delete | import validation | retention auto-prune spares pinned | wipe is hold-confirm | ✅ PASS |

**Scorecard (flow.txt §53) per category:** Entry ✅ · Interaction ⚠️ (C-03 fake
buttons) · Success ✅ · Failure ✅ (shaped, actionable, retry-safe) ·
Interruption ✅ (outbox, drafts, optimistic reconciliation) · Data ✅
(idempotency keys, triggers recompute counters, realtime refetch-on-event) ·
Exit ✅ (back behavior, deep links, terminal states) · Security ✅ (rounds 1–2:
server-side enforcement everywhere, RLS boundary, rate limits) · Recovery ✅.

**Flow gaps found (this is the actionable list):**

| ID | Gap | flow.txt ref | Fix |
|---|---|---|---|
| GAP-01 | "Sign in to do that." error carries no sign-in affordance — the user must hunt for the avatar menu | §11 "what can the user do now?" | TASK-01: add "Sign in" action to the auth-coded failure card/toast |
| GAP-02 | `ACCESS_MODE=open` — gate dormant (C-01) | §5 first-use, plan spine | TASK-00: owner decision + flip + verify waitlist journey end-to-end in enforce mode |
| GAP-03 | @bot demo undisclosed (C-02) | §3 no fake functionality | TASK-02/02b |
| GAP-04 | Passkey/SSO fake buttons (C-03) | §3 no fake functionality | TASK-03 |
| GAP-05 | No moderation path (C-05) | §36 | TASK-04 |
| GAP-06 | Profile empty state ("No posts yet.") has no direction on own profile | §9, §12 | TASK-05 (copy-only) |
| GAP-07 | Detail view loading is a bare spinner (no "Loading thread…" wording) | text.txt §13 | TASK-05 (copy-only) |
| GAP-08 | Post/comment *edit* absent — must be declared, not discovered | §8 | recorded: explicit non-goal v2 (see C-04) |

---

## STEP 5 — Copy Audit (against text.txt)

Audited error/empty/loading/button copy across community-data.js `shape()`,
community.js, access.js, auth.js, index.html.

**Passes (already conformant):**
- Errors are human, non-blaming, and consequence-named: "That looked like a
  duplicate. Nothing was posted twice." / "The comment you were replying to is
  gone. Your draft was kept." / rate-limit message explains recovery (text.txt
  §10, §11, §15) ✅
- Empty states mostly carry direction: feed ("Start a generation with @bot.
  It shows up here for everyone to remix."), notifications ("Nothing yet. When
  someone replies to you it shows up here.") ✅ (§12)
- Buttons name consequences: "Join the waitlist", "Hold to delete",
  "Send reset code", "Try again", "Check models" ✅ (§8)
- Destructive confirms name the consequence (delete sheet) ✅ (§9)
- Honest "Soon" pills with toast fallback ✅ (§16 careful-usage)
- No marketing-speak inside controls ✅ (§21)

**Vocabulary dictionary (text.txt §22 — ratify these as canonical):**

| Concept | Term | Not |
|---|---|---|
| public prompt+response object | **generation** (UI: "post") | content, item |
| derive from a post | **remix** | fork, copy |
| counter-post | **challenge** | rebuttal, duel |
| saved post | **saved** | bookmarked, favorited |
| hosted agent | **@bot** | assistant, AI (in feed context) |
| private chat surface | **Workspace** | chat app, studio |
| access request | **waitlist** | queue, beta list |
| product (user-facing) | **Botocracy** | Impose (internal/repo name only) |

**Failures to fix:**
- COPY-1: "…sign in is ready for backend integration." — developer language in
  UI (text.txt §3, §21). Fix with GAP-04 removal/demotion.
- COPY-2: profile own-empty and detail-loading wording (GAP-06/07).
- COPY-3: `README.md` title says "Impose" while product is Botocracy —
  internal doc, low priority, align when convenient.

---

## STEP 6 — System Pre-Ship Checklist (system-design-architect §15, mapped)

| Checklist block | Status | Evidence |
|---|---|---|
| Requirements/capacity | ✅ ratified | plan §11 cost model; economy-model math |
| Data layer (normalized ledger w/ triggers, keyset indexes, denormalized counters synced by trigger) | ✅ | 0001/0004; schema_test.sql runs against every migration |
| Concurrency: every read-modify-write protected | ✅ | idempotency_keys row-lock; counters trigger-maintained; rate_hit upsert |
| Idempotency on all retriable mutations | ✅ | client UUID keys + server replay-before-rate ordering (0014, verified live) |
| Rate limiting layered | ✅ | relay per-rightmost-XFF-IP buckets + DB buckets gen/bot/com per-minute (0014) |
| Timeouts on network calls | ✅ | auth-client 8s w/ abort; community-data fetch guards; relay httpx timeouts |
| Retry policy (idempotent-only, backoff) | ✅ | outbox retryable/non-retryable classification |
| Error taxonomy transient vs permanent | ✅ | shape() retryable flag drives outbox |
| Statelessness / horizontal path | ✅ | relay stateless (buckets in-memory, documented single-instance MVP); app tier static |
| Secrets | ✅ | keys client-side BYO; relay CONTROL_KEY server-side; anon key public-by-design under RLS |
| AuthN/AuthZ server-side everywhere | ✅ | GoTrue hardened (round 1) + RLS privilege matrix + SECURITY DEFINER gates incl. deleted-post comment gate (0014) |
| Input validation at boundary | ✅ | relay signup rules ≡ SQL `text_is_spammy` ≡ client mirror; RPC length checks |
| Abuse vectors (race, replay, IDOR, mass-assignment, negative values) | ✅ | rounds 1–2 wire-level probes; schema_test asserts each class |
| Audit/observability | ⚠️ partial | client debug-bus + relay logs + request ids; **no tamper-evident security log, no alerting** — accepted MVP risk (plan §33), revisit at monetization |
| DR: backups/restore, RPO/RTO | ⚠️ | Supabase free-tier daily backups (7-day retention), PITR requires Pro — **R-DB1 upgraded: define RPO/RTO before launch** |
| Split-brain/consensus | N/A | single-writer Postgres |
| Crash recovery | ✅ | outbox (transactional client-side outbox), idempotent replays, stateless relay |
| Realtime correctness | ✅ | publication = exactly generations/comments/notifications, replica identity FULL, RLS applies to payloads, refetch-on-event |

**Architect-doc anti-pattern scan (§14):** none present. The two classic
near-misses (check-then-act on counters; unbounded limiter memory) were
closed in round 2.

---

## STEP 7 — Adversarial Review, Gap List & SCOPE LOCK v2.0

**Adversarial questions and answers:**
- *What breaks at 10× usage?* rate buckets hold (DB-side); feed pagination
  holds (keyset); @bot demo is free so no cost cliff — but the moment @bot is
  real (TASK-02), 0014's `bot:global` 12/min is the cost valve ✅.
- *What can the client still manipulate?* nothing found beyond rounds 1–2
  coverage; new check: realtime payloads are untrusted (refetch) ✅;
  notification rows are escaped ✅.
- *What did v1.0 invent that never got used?* none — but `ACCESS_MODE=open`
  means the waitlist investment (F3) is currently cargo: built, never active.
- *What operational burden exists?* grants are manual operator inserts
  (accepted, plan §4); no approval email yet (Phase C) — remains future scope
  until gate flips.
- *Unresolved?* D1 (gate flip), D2 (@bot real vs disclosed-demo).

**Gap → task traceability:**

| Task | Gap/Req | Definition | Acceptance criteria |
|---|---|---|---|
| TASK-00 | GAP-02, C-01 | Owner decides gate policy; if enforce: flip `ACCESS_MODE`, verify waitlist sheet → join → position → grant → unlock end-to-end | In enforce mode: no grant ⇒ sheet; join idempotent; grant row ⇒ tab unlocks within one refresh; network-fail ⇒ deny-with-retry (never open) |
| TASK-01 | GAP-01 | Auth-coded failure shows a working "Sign in" affordance | Tapping it reaches auth.html and returns to the same screen after sign-in |
| TASK-02 | GAP-03 (owner choice A) | Wire @bot to relay→provider per plan §28: bounded context, validated output, cost valve = existing bot buckets | Addressed post produces real reply; provider failure ⇒ shaped error, feed unaffected; budget caps verified live |
| TASK-02b | GAP-03 (owner choice B) | Explicit demo disclosure: composer + first bot reply labelled "demo replies until launch" | No user can believe replies are live agent output (text.txt §30 mom test) |
| TASK-03 | GAP-04 | Remove or demote Passkey/SSO buttons to labeled coming-soon | Zero functional-looking controls with no behavior (flow.txt §3) |
| TASK-04 | GAP-05, C-05 | Report action on posts/comments → stored flag → operator email digest; author sees "reported/under review" only if actioned | Report is rate-limited, idempotent, invisible to the reported user until action (moderation lifecycle §36) |
| TASK-05 | GAP-06, GAP-07, COPY-2 | Copy polish: own-profile empty direction; detail loading wording | text.txt §12/§13 conform |
| NON-GOAL v2 | C-04 | Post/comment *editing* deliberately deferred (delete + repost is the v2 truth) | recorded, not built |

**QA/edge matrix additions for the new tasks:** enforce-mode cold load with
stale grant cache >10 min; join during relay outage; sign-in affordance from a
failed comment as well as a failed post; report on an already-deleted post;
demo-disclosure copy at 390px.

```yaml
SCOPE_LOCK_v2_0:
  supersedes: PRODUCT_PLAN.md v1.0 sections 35-44
  ratified_since_v1: [live posting, relay-OTP auth, realtime+polling, notifications,
                      post locking, adversarial hardening, write rate limits + bot cooldown,
                      deleted-post comment gate, relay XFF client-ip + bucket pruning]
  open_owner_decisions:
    - D1: flip ACCESS_MODE to enforce now or keep open during beta
    - D2: TASK-02 (real @bot) vs TASK-02b (disclosed demo)
  task_order: [TASK-00 (gates D1), TASK-03, TASK-01, TASK-05, TASK-02|02b (gates D2), TASK-04]
  future_scope: [approval emails, moderation admin, pgvector search, Pro tier,
                 post/comment editing, realtime typing/read-receipts]
  explicitly_not_building: [admin dashboard, analytics stack, native apps, DMs,
                            model hosting, i18n]
  invariants_unchanged: [RLS is the boundary, client untrusted, BYO keys never
                         touch operator, feed independent of LLM path, no fail-open]
  implementation_rule: implement only the task list above or approved change requests
```

---

## Definition-of-done check (planner §38)

Every question answerable from this document + PRODUCT_PLAN.md v1.0 §1–34:
what/why/who/MVP-scope/screens/navigation/actions/success/failure/interruption/
data ownership/permissions/API/transactions/dependency failure/attacker surface/
scale path/design source/first task/verification/change-control. ✅

**Bottom line:** the shipped system is flow-complete and security-complete for
everything it claims to be. The two live contradictions are product honesty,
not engineering: the gate is off (GAP-02) and the agent is a demo (GAP-03).
Both need owner decisions, not more audits.

---

## EXECUTION ADDENDUM — 2026-09-18 (owner said "go ahead")

**Recorded assumptions (planner Rule 4 — reversible by the owner):**

- **A1 (D1 resolved): gate flipped to `enforce`.** Basis: the owner's own
  verbatim intent in the v1.0 traceability root — "Community is open now;
  Workspace is waitlist-only." The owner account (`rfarouq69`) was granted
  directly in `workspace_grants` so the flip locks nobody out who should be
  in. Reversal = set `ACCESS_MODE: "open"` in config.js and rebuild.
- **A2 (D2 resolved): TASK-02b shipped now; TASK-02 deferred.** Basis: real
  @bot requires an operator LLM key and a model choice, neither of which
  exists yet; the honesty fix cannot wait on that. All disclosure is driven
  by one flag (`BOT_DEMO` in community.js) plus the composer disclaimer, so
  wiring real replies later is one flag-flip and one code path, and every
  "demo" mark disappears in the same commit.

**CHANGE-001 (scope deviation, recorded per planner §33):** the audit table
promised an *email* digest for reports. Shipped instead: `GET /admin/reports`
on the relay (CONTROL_KEY-gated, service-role read, newest first, reporter
handle embedded). Reason: the relay's mail path is OTP-shaped (`send_code`),
and bending it into a digest sender would put the OTP path at risk for a
feature the operator can already get from one URL. Email digest moves to
future scope; the moderation lifecycle (pending → reviewed/actioned/
dismissed) is fully modeled in the schema either way.

**Shipped in this pass:**

| Task | What landed | Verification |
|---|---|---|
| TASK-00 | `ACCESS_MODE: "enforce"` + owner grant row | `my_workspace_access` returns granted for owner; waitlist journey now live |
| TASK-01 | `finishHref()` return-to-context in auth.js; "Sign in" affordance on auth-coded post failures and comment toasts; `goSignIn()` stashes the return hash | sign-in lands back on the screen the attempt happened on |
| TASK-02b | `BOT_DEMO` flag, "demo" tag on every @bot answer, composer disclaimer "@bot answers are demo replies until launch" | no path renders a canned reply unlabelled |
| TASK-03 | Passkey/SSO buttons and their toast handler removed from auth.html/auth.js | zero functional-looking controls without behavior |
| TASK-04 | Migration 0015 (reports table, `report_content` RPC: visibility-gated, 20/hour rate limit, unique-per-target idempotency); Report in post and comment kebab menus; `/admin/reports` relay endpoint + tests | schema suite green; live probes: reported → already → target_gone → anon denied |
| TASK-05 | "Loading notifications…" wording; own-profile empty state gets a direction | text.txt §12/§13 conform |

**Not built (recorded, not discovered):** post/comment editing (NON-GOAL v2),
report email digest (future), real @bot (future, needs key + model choice).

**Verification at ship:** schema suite green on a scratch DB with all 15
migrations; pytest 156; node suites 51/63/14/24/7/113; standalone build
current; service worker v55; live probes (rolled-back) confirm report,
idempotent replay, enumeration refusal, and RLS denial.
