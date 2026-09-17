# Botocracy — Product Production Plan (MVP)

Status: **SCOPE LOCKED** for the MVP described in §12. Version 1.0, 2026-09-17.
Skills applied: product-planner (scope/flows/traceability) + system-design-architect
(backend, security, failure, scale). Visual execution remains governed by the
project's own house design (dark, flat, borderless; no focus rings; no
decorative noise) — the two planner skills never override that.

---

## 1. Executive Product Definition

**Botocracy** enables mobile-first users to **watch, share, and remix AI
generations in an open community feed**, and gives granted members a private
**Workspace** (BYO-key chat with history, files, and tools) through a
waitlist-gated beta. The core loop: generate → post → get remixed/challenged
→ climb the engagement-ranked feed → bring the best prompts into your
Workspace.

## 2. Original User Intent (traceability root)

From the owner, verbatim in intent:

1. Unify Community and Workspace interactions — "no clashing syntax, functions
   or logic."
2. Build the remaining flows for a **presentable MVP**.
3. Community is **open now**; Workspace is **waitlist-only** for now.
4. Apply security/database/backend protocols **exactly as the system-design
   skill guides**.
5. Choose the database: **Firebase vs Supabase vs Postgres**.
6. Research what exists, define the **moat**, the **engagement engine**,
   operations, **AI cost and rate limits**, and a **monetization** approach
   including the moment users shift from "want" to "need".

## 3. Constraints

- Static frontend (vanilla JS, no framework, no build step beyond inlining);
  Render static hosting + existing Python relay backend.
- Mobile-first (user instruction): all new UI designed at 390px first.
- Regression gates must stay green (build sync, 5 node suites, pytest,
  6360+1308 audit scenarios).
- BYO-key model: provider keys stay in the user's browser (existing invariant,
  a differentiator — see §9).

## 4. Assumptions

- Botocracy's hosted "@bot" replies on the community feed are paid for by the
  operator (relay); Workspace chat costs the operator nothing (BYO key).
- The waitlist is curated (hand approvals at first), not first-come-auto-in.
- One operator/moderator persona for MVP; no self-serve admin UI yet.

## 5. Research Findings

| # | Finding | Source | Confidence | Product implication |
|---|---|---|---|---|
| R1 | In 2026 **model access is not a moat**; defensibility comes from a tight workflow, proprietary feedback loops, switching costs, and owned distribution. "Generic chatbot / prompt collections" are named fake moats. | valtorian.com "AI Moats in 2026" | High | The moat must be the **community corpus + remix lineage + reputation**, not the chat client (see §9). |
| R2 | Social platforms live or die on **engagement engineering**: personalization, community features, interactive formats must be built in from day one, not bolted on. | agileengine.com social app guide | High | The feed needs an explicit engagement engine (§10), not just "posts in date order". |
| R3 | Supabase = managed Postgres: **$25/mo flat**, 500MB/50K MAU free tier, RLS, passkeys, realtime, pgvector, self-hostable. Firebase Firestore bills **per document read** (~$0.18/100k reads) which disproportionately punishes paginated feeds; proprietary data model = lock-in. | designrevision.com, bytebase.com, hafencity.dev (2026 comparisons) | High | **Choose Supabase** (§7). |
| R4 | Economy-tier LLM pricing (Sept 2026): Gemini Flash-Lite $0.10–0.30 in / $0.40–2.50 out per Mtok; gpt-5.6-luna ~$0.20/$1.20; frontier tiers $2–5 in / $12–25 out. | getmaxim.ai, benchlm.ai, intuitionlabs.ai | Medium-High | Hosted "@bot" replies on an economy model cost **≈ $0.0006/generation** (500 in + 400 out) — free-tier sustainable with rate limits (§11). |

## 6. Existing Solutions / Competitors

- **Perplexity / ChatGPT / Gemini apps**: answer engines, single-player, no
  public generational corpus. Table stakes: streaming, history, model picker.
- **Character.ai / c.ai social layer**: persona chat with community, but no
  provenance of answers, no remix lineage, no BYO key, no export.
- **Prompt marketplaces (PromptBase etc.)**: sell static prompts; no evidence
  of outcomes; no community verification.
- **Open-source BYO chat UIs (LobeChat, Open WebUI, LibreChat)**: strong
  Workspace analogs, zero community layer. This is the whitespace:
  **the public, remixable corpus of prompt→response pairs with lineage and
  debate (challenge) as first-class objects.**

## 7. Database Decision: **Supabase (managed Postgres)**

| Criterion | Supabase (Postgres) | Firebase (Firestore) | Self-hosted Postgres |
|---|---|---|---|
| Data shape (threaded comments, remix lineage, grants) | Relational — natural | Document trees, awkward joins | Relational — natural |
| Authorization | **RLS in the DB** (server-side, can't be bypassed by client) | Security rules (client-library-centric) | Roll your own (Postgres RLS possible but you own auth) |
| Feed pagination cost | Flat (row reads) | Per-doc reads punish 100:1 read-heavy feeds | Flat but you operate it |
| Auth | Email/passkeys/anon built-in, ties to RLS via `auth.uid()` | Built-in but rules ≠ SQL | Build it |
| Realtime feed | Logical replication built-in | Built-in | Build it |
| Ops burden for MVP | Low | Low | High |
| Exit path | Plain Postgres — portable | Proprietary | n/a |
| Later AI features | **pgvector** for semantic search over the corpus | Add-on | Extension |

**Decision: Supabase.** It *is* Postgres (the user's third option is
satisfied by construction), adds auth+RLS+realtime the MVP needs, and leaves
the cheapest migration path (self-host the same schema) if costs demand it.
Migration `supabase/migrations/0001_mvp.sql` encodes the schema, RLS,
indexes, and the two RPCs.

## 8. Product Critique (result)

- **C1 — Two surfaces, one codebase**: duplicated logic already produced one
  shipped regression (composer collapse). **Response:** `ui-core.js` shared
  kernel; both surfaces delegate (done in this change).
- **C2 — Workspace behind a gate kills the empty-state demo**: a gated
  product that shows nothing converts nobody. **Response:** Community is the
  open, living showcase; the gate sells the Workspace *from inside* value
  (feed → remix → "I want my own").
- **C3 — Client-side gating is fake security**: any user can flip a flag.
  **Response:** the gate UI is cosmetic; `workspace_grants` + RLS + RPC are
  the boundary; all future workspace-bound server calls re-check server-side.
- **C4 — Anonymous feed posting = spam/abuse risk**: **Response:** MVP posts
  require an account (email/passkey); joins are idempotent by unique email;
  per-IP hashing for forensics; gateway rate limits (§11).

## 9. Differentiation & Moat

**Convention we keep:** feed, comments, remixes, follower-free ranking.
**Conventions we break (with reasons):**

| Convention elsewhere | What we do | Why | Risk | Mitigation |
|---|---|---|---|---|
| Answers are ephemeral chat bubbles | The **generation** (prompt+response pair) is the atomic public object | Corpus compounds; every chat can become content | Privacy fear | Private by default; publishing is an explicit act (visibility check in RLS) |
| Likes only | **Remix and Challenge** as first-class lineage | Debate + derivation create a provenance tree nobody else has (R1: proprietary feedback loop) | Complexity | Edge list `remix_of`; render lineage inline (already built) |
| Algorithmic black-box feed | Documented engagement ranking (remix 4 / challenge 3 / comment 2 / save 1) | Trust; auditable | Gaming | Rate limits + idempotent counters + moderation |

**Moat stack (in order of defness):** 1) the corpus + lineage graph,
2) reputation attached to handles across generations/comments,
3) Workspace lock-in via saved history/files/prompts,
4) BYO-key trust position (we never see provider keys — a distribution asset
with the exact audience this product wants).

## 10. Engagement Engine

1. **Onboarding without friction**: land directly in a populated feed (seeded
   deterministic content exists); no signup wall to read.
2. **The hook**: every generation card exposes remix/challenge — consumption
   converts to creation in one tap.
3. **Feedback that ranks**: documented score; a single remix moves you up the
   feed — instant, visible cause-and-effect.
4. **Return trigger**: new-posts pill (poll → realtime later) = session
   restart for free.
5. **The need-moment (want→need transition)**: the first time a user loses
   something by not having the Workspace — a thread they wanted to continue,
   a generation they wanted to keep private, a file they wanted to attach.
   Product placement: the waitlist sheet is shown **exactly at the moment of
   that intent** (tap on Workspace), with copy that sells *history, privacy,
   files, providers* — not "exclusive access" fluff. Secondary need-moment:
   power users hitting free "@bot" daily limits get routed to BYO-key (which
   is unlimited because it costs us nothing).
6. **Notifications (post-MVP)**: email on grant approval (the waitlist payoff
   moment), then remix/comment digests.

## 11. Operations: AI Cost & Rate Limits

**Cost model (hosted "@bot" replies, economy model, Sept 2026 pricing):**

| Item | Tokens | Rate (per Mtok) | Cost |
|---|---|---|---|
| Typical generation (in) | ~500 | $0.30 | $0.00015 |
| Typical generation (out) | ~400 | $2.50 | $0.00100 |
| **Total per generation** | | | **≈ $0.0012** |
| 1,000 generations/day | | | ≈ $1.20/day |
| 100k generations/month | | | ≈ $115/month |

Escalation path: route long/complex prompts to Flash tier ($0.75/$3.75) —
~3x cost, still <$0.005/gen; frontier models only for BYO-key users (their
keys, their cost).

**Rate limits (layered, per the system-design skill §6):**

| Layer | Limit | Enforcement point |
|---|---|---|
| Edge (CDN) | volumetric abuse | Cloudflare/Render edge |
| Gateway: `@bot` generate | 10/day per anon device-hash; 30/day per authed user | relay (Redis token bucket when multi-instance; in-memory counter acceptable for single instance MVP — bounded, restartable) |
| Gateway: waitlist join | 5/hour per IP-hash + unique(email) constraint | relay + DB constraint (last line) |
| Gateway: post/comment | 20/hour per user | relay |
| DB | unique(email), char_length checks, RLS | Postgres (unbypassable) |

**Backpressure:** overload → 429 + Retry-After, degrade gracefully: `@bot`
queue → "Busy — retry in a minute" toast; the community feed itself never
depends on the LLM path and stays readable during total model outage
(failure isolation by design).

## 12. MVP Scope

**MUST_HAVE (this lock):**
- F1 Shared interaction kernel (`ui-core.js`) — no clashing logic between surfaces. ✅ built
- F2 Access layer (`access.js` + `config.js`): open/enforce modes, grant cache, degraded-safe. ✅ built
- F3 Waitlist gate: Workspace tab + `#/workspace` route gated; waitlist sheet with idempotent join (position feedback). ✅ built
- F4 Supabase schema + RLS + RPCs (profiles, waitlist, workspace_grants, generations, comments, counters). ✅ migration committed
- F5 Community open: feed browse/remix/challenge/comment as today. ✅ (existing)

**SHOULD_HAVE (next lock, Phase 2):** live Supabase wiring (flip ACCESS_MODE,
auth UI hookup to GoTrue REST), posting generations to the DB (currently the
feed is seeded/deterministic), moderation queue, email on approval.
**COULD_HAVE:** realtime feed, pgvector semantic search, reputation page.
**FUTURE:** teams, exportable lineage trees, paid tiers below.
**DO_NOT_BUILD (now):** admin dashboard, analytics stack, native apps, DMs.

## 13–14. Non-Goals / Future Scope

Non-goals for MVP: self-serve monetization, model hosting, multi-tenancy,
moderation automation, i18n. Future scope: §15 monetization phases.

## 15. Monetization Approach & Point of Contact

**Positioning: free forever to read and remix; pay for leverage.**

| Tier | What | Price point | Why they pay |
|---|---|---|---|
| Free | Community feed, daily hosted @bot replies, read-only workspace preview | $0 | Acquisition + corpus growth |
| Member (waitlist grant) | Workspace: BYO-key unlimited chat, history, files, tools | Free during beta | Scarcity phase — feedback in exchange for access |
| Pro (post-beta) | Hosted inference (no key needed), private generations at scale, priority queue, exportable lineage | ~$8–12/mo | Users without keys; teams; privacy |
| Corpus API (much later) | Licensed access to the verified lineage graph | usage-based | B2B; only once corpus is defensible |

**Point of contact (where want becomes need) — the three trigger moments we
instrument and design for:**
1. **Loss aversion moment**: session ends, conversation was good, it's gone
   → Workspace pitch at that exact tap (implemented: gate at the Workspace
   tab, not a popup).
2. **Limit moment**: free @bot daily cap hit → BYO-key pitch (free unlimited,
   we never see the key) — converts skeptics without paying us.
3. **Corpus moment**: user's remix outperforms their original post → they
   need lineage privacy/control → Pro.

We monetize leverage and privacy, never the feed. The feed stays open because
the corpus is the moat (R1/R2).

## 16–21. Actors, Journeys, Screens, Interactions, States, Navigation

**Actors:** anonymous visitor (read feed), authenticated user (post, comment,
remix, join waitlist), granted member (workspace), operator/moderator
(grants, takedowns).

**Journey — discover→waitlist (the MVP's new spine):**
1. Anonymous lands → Community feed (no wall).
2. Taps **Workspace** tab → gate: `canUseWorkspace()` false → sheet opens
   (state: `anonymous`).
3. Enters email → `join_waitlist` RPC → unique(email) makes retries
   idempotent → success state with position → sheet closes, user continues in
   Community.
4. Failure paths: invalid email (inline, no alert), 429 (throttle message),
   network down (cached grant, sheet retries, never fails open).
5. Grant day: operator inserts into `workspace_grants` (service role) →
   user's next `my_workspace_access()` returns true → tab unlocks. No client
   trust involved anywhere.

**State machine (access):** `unknown → checking → granted | waitlisted |
anonymous`; degraded network → hold last grant if granted, else stay
`unknown` (deny with retry). Illegal transitions impossible by construction.

**New/changed screens:** Community header (unchanged), Workspace gate sheet
(new), Workspace (unchanged for granted users). Route ownership:
`#/` + `#/g/*` = Community; `#/workspace`, `#chat=` = Workspace (gated).

## 22–23. Domain Model & Database

See `supabase/migrations/0001_mvp.sql`. Entities: `profiles`, `waitlist`,
`workspace_grants`, `generations` (visibility enum, remix lineage,
denormalized counters maintained by triggers — the single-writer rule from
the system-design skill), `comments` (parent tree). Indexes match the two hot
queries: feed (public, newest-first, keyset-ready) and thread loads.
Soft deletion is out of scope for MVP (hard delete + cascade is the truth).

## 24–25. Authentication & Authorization

- Auth: Supabase GoTrue (email + passkeys available; anonymous sessions for
  feed identity later). Sessions in localStorage (GoTrue default); the relay
  and RLS verify tokens server-side on every call.
- Authorization: **RLS is the boundary** — private generations readable only
  by owner (`author_id = auth.uid()`), comments inherit parent generation
  visibility (no IDOR through private posts), `workspace_grants`/`waitlist`
  have **zero** client policies (reachable only through SECURITY DEFINER RPCs
  with explicit search_path). The anon key cannot read the waitlist table.

## 26. API / Service Contracts

| Operation | Contract |
|---|---|
| `join_waitlist(p_email)` | anon RPC; validates email server-side; idempotent via unique email; returns (position,status); 429 at gateway when hammered |
| `my_workspace_access()` | auth RPC; single typed verdict (can_use_workspace, email, waitlist_position); SECURITY DEFINER, stable |
| future: `post_generation`, `list_feed(keyset)` | auth; explicit column allowlists (no mass assignment — inserts name columns, never blindly bind); keyset pagination on (created_at,id) |

Client binding: `access.js` speaks raw REST with the anon key; no SDK; CSP
will need `https://*.supabase.co` in connect-src when enforced.

## 27. External Integrations

Supabase (auth+DB, timeout 8s, retry once with jitter, failure = degraded
grant §21); LLM provider for @bot via existing relay (timeout 60s, circuit
open → feed unaffected); Render (static + relay).

## 28. AI Architecture

@bot replies: relay → provider with economy model; prompt = community post +
thread context (bounded 4k tokens); output validated (length, char-escape)
before persisting; **model output never becomes trusted state without
validation**; generation of workspace chats is BYO-key = user's own provider
contract, we are transport only.

## 29–32. System Architecture, Threat Model, Failure, Scale

Architecture: browser (2 IIFE surfaces + shared kernel) → Render static CDN;
relay (FastAPI) → Supabase (auth/DB) + providers. No queues/microservices
(architecture-theatre rule: single-instance MVP, bounded in-memory buckets,
Redis only when a second instance exists).

**Threat model (client is untrusted):**

| Threat | Path | Control | Enforced |
|---|---|---|---|
| IDOR on private generations | guess/enum ids | RLS owner check on select | Postgres |
| Comment exfiltration of private posts | comment on private gen | comment insert/select policies check parent visibility | Postgres |
| Waitlist enumeration/spam | script joins | gateway per-IP-hash limit + unique(email) + email validation server-side | relay + DB |
| Fake workspace grant | flip localStorage flag | grants live in RLS table, no client policy; workspace server calls re-check | Postgres |
| Mass assignment | extra JSON fields | RPCs and inserts name explicit columns; RLS with-check | Postgres |
| XSS via post/comment body | escaped render | `esc()`/`escapeHtml` on every interpolation (kernel) + CSP headers file | client + `_headers` |
| Replay/double-post | retry storms | idempotent unique constraints; client dedupe keys post-MVP | DB |
| Token abuse | stolen anon key | RLS means anon key alone reads only public rows; write paths require authed JWT | Postgres |

**Failure/recovery:** refresh mid-join → unique email makes re-join safe;
Supabase down → feed (local/seeded) still renders, sheet shows retry (deny,
never fail open); relay down → community readable, generation queue degrades
with toast; crash of relay → stateless, restart clean.

**Scale path:** 10k MAU fits Supabase free→Pro single instance; first real
lever = keyset pagination (already indexed) + realtime channel; second =
Redis for rate buckets; sharding is explicitly not an MVP topic.

## 33. Observability

Existing debug log (client) + relay logs. MVP additions: waitlist-join and
grant-grant events logged server-side with request ids; error rate on the two
RPCs alerted via Supabase logs. No analytics stack yet (do-not-build).

## 34. Design-Skill Handoff

Visual language unchanged: dark flat borderless; the gate sheet reuses the
onboarding sheet idiom (badge + copy + single field + one primary button);
mobile-first at 390px; press feedback per the house kernel; no focus rings;
no noise.

## 35–37. Implementation Architecture, Phases, Tasks (executed)

- Phase A (done): F1 kernel, F2 access layer, F3 gate + sheet, F4 migration,
  plan doc. Tasks trace: T-101 ui-core (F1), T-102 access/config (F2),
  T-103 gate+sheet (F3), T-104 SQL (F4), T-105 docs (F6-plan).
- Phase B (next): flip to enforce + GoTrue auth UI + server post/list feed.
- Phase C: moderation + approval email + realtime.

## 38. Acceptance Criteria (Phase A, all verified)

1. Both surfaces' shared behaviors come from `ui-core.js` — grep proves
   single definitions; all suites green.
2. With `ACCESS_MODE=open`, nothing gates (dev/demo unaffected) — verified in
   browser.
3. With `enforce` simulated, tapping the Workspace tab or deep-linking
   `#/workspace` lands in Community with the sheet; join is idempotent
   (unique email); success shows position; continue returns to feed.
4. RLS: anon key cannot read `waitlist`; private generations unreadable by
   others; comments inherit visibility (migration encodes; verified by
   policy review until live DB test in Phase B).
5. Build sync + node suites + pytest + audit matrix all green.

## 39. QA / Edge-Case Matrix (Phase A)

Empty (no grant cache) / stale cache >10min / network fail during join /
double-submit join / invalid email / route guard on cold load / hash set to
`#/workspace` while open-mode / sheet Escape+backdrop close / keyboard-only
sheet navigation. Each covered in the Phase A test pass.

## 40. Known Risks

R-DB1 Supabase free tier pause on inactivity (low: paid at launch);
R-GATE1 client gate spoofable by design (accepted: boundary is RLS);
R-CORPUS1 seeded feed must be replaced by real posts before launch noise
matters (Phase B).

## 41. Open Decisions

D1 exact economy model choice (Gemini 3.5 Flash-Lite vs gpt-5.6-luna) —
benchmark on real prompts in Phase B. D2 passkey-first vs email-first auth.

## 42. Traceability

User intent 1→T-101 (kernel); 2→§12 MVP; 3→T-102/103 (gate);
4→§24–26, migration; 5→§7 decision; 6→§5, §9–11, §15.

## 43. Adversarial Review

"What if everyone joins the waitlist and nobody gets in?" — grants batched
weekly; sheet sets expectation ("a few at a time"). "What if the corpus fills
with junk?" — ranking weights engagement quality (remix/challenge > comment),
moderation in Phase B/C. "What if Supabase raises prices?" — schema is plain
Postgres; exit documented. "What did we invent?" — nothing outside user
intent 1–6; monetization tiers are labeled proposals pending owner approval.

## 44. SCOPE LOCK

```yaml
SCOPE_LOCK:
  product_goal: open community feed of AI generations + waitlist-gated BYO-key workspace
  core_loop: generate/post -> remix/challenge -> ranked feed -> workspace for power use
  mvp_features: [F1 shared kernel, F2 access layer, F3 waitlist gate+sheet, F4 supabase schema+RLS+RPC, F5 open community]
  required_screens: [community_feed, generation_detail, access_sheet, workspace(gated)]
  required_actors: [anonymous, authenticated, granted_member, operator]
  required_entities: [profiles, waitlist, workspace_grants, generations, comments]
  required_api_operations: [join_waitlist, my_workspace_access]
  critical_security_requirements: [RLS visibility, grant table no-client-policy, idempotent join, server-side email validation, escaped rendering]
  critical_recovery_requirements: [degraded-safe grant check (never fail open), idempotent join on retry, feed independent of LLM path]
  future_scope: [live posting to DB, realtime, pgvector search, monetization tiers, moderation UI]
  explicitly_not_building: [admin dashboard, analytics stack, native apps, DMs, model hosting]
  approved_design_source: house design (dark flat borderless, mobile-first)
  implementation_rule: implement only this specification or approved change requests
```
