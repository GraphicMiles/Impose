# Platform inventory

What exists today, read off the code rather than from memory. Written to
support planning the next features, so it flags what is load-bearing, what is
decoration, and what is built past the point the product can use.

Repo: 95 tracked files, 131 commits. Frontend is vanilla JS, no framework, no
build step beyond an inliner. Backend is FastAPI.

---

## 1. Shape of the thing

Two modes behind one shell, switched by a segmented control in the header.

| | Community | Workspace |
|---|---|---|
| Entry | `#/` | `#/workspace` |
| Code | `community.js` (2499) + `community.css` (1254) | `app.js` (8059) + `styles.css` (1972) |
| Storage | `localStorage` key `slopify:v6` | `localStorage`, several keys |
| Backend | **none, zero network calls** | relay (FastAPI) when a provider is configured |
| Maturity | heavily iterated, 10 tasks of fixes | broad, built early, largely untouched since |

The asymmetry matters for planning: Community is the surface that has had real
design attention, Workspace is the surface with real capability.

---

## 2. Community

### Feed
- Infinite scroll, 10 per page, `IntersectionObserver` sentinel, loader and
  end-cap states.
- Pull to refresh with a spinner ring.
- "New posts" pill with stacked avatars when items arrive while you read.
- Empty state.
- Seeded fixture data (`seed()`), 8 generations with comments.

### Posts (generations)
- Compose with visibility toggle (public / private, private shows an
  "Only you" note).
- `@bot` addressing. A post starting with `@bot` calls the agent and streams a
  response. A post without it is a plain post that never calls the agent. The
  mention is syntax-highlighted in the composer like a code token.
- Streaming state with a "@bot is thinking" indicator, and a retry action on
  failure.
- Card actions: **remix**, **challenge**, **discuss**, **save**, plus
  **lock** and a **kebab** (delete) for your own posts.
- Counts on each action.
- Lock prevents remix/challenge by others.
- Detail view at `#/g/:id` with full prompt and response.
- Delete with undo, and a tombstone row that collapses once the undo expires.

### Comments (the X-style thread model, most recent work)
- Three distinct actions, deliberately kept separate: the post's comment
  button opens the thread; Reply on an empty thread composes the first
  top-level comment; Reply on a comment targets that comment.
- Zero-comment posts show an invitation and a Reply CTA, not an empty list and
  not an open composer.
- Nested replies, capped at 3 visual layers, with connector rails that touch
  their root.
- Per-comment expand/collapse of sub-threads, with expansion state that moves
  branch-wide.
- Reply target chip naming who you are answering, cancellable.
- Reply-target integrity: the target is re-resolved by id before posting, and
  if it was deleted or removed by another tab the post is refused and the
  draft kept. A reply can never silently become top-level.
- Comment delete with undo, behind a kebab.
- Counts derived from live data, never incremented.
- Cross-tab sync: another tab's comment appears without destroying your draft
  or your expansion state.

### Identity
- Generated avatars per handle (`avatars.js`), deterministic colour and face.
- Handles, relative timestamps.

---

## 3. Workspace

### Chat core
- Streaming chat, SSE, with cancel.
- Markdown renderer with syntax highlighting for fenced code.
- Message actions: copy, retry (with a model picker), edit, branch.
- Image lightbox.
- Citation hover cards for web results.
- "Jump to latest" pill.
- Token estimate in the composer.
- Attachments via file picker, with preview.
- Voice input (mic) and **read aloud** (TTS) on replies.

### Organisation
- Chats, folders, pinning, rename, duplicate, move, delete.
- Search across chats.
- Command palette (keyboard driven).
- Keyboard shortcuts overlay.
- Sidebar with collapse, plus mobile drawer gestures (swipe to close, edge to
  open).

### Providers
- Bring-your-own-provider: add any OpenAI-compatible endpoint.
- Provider catalog (1204-line JSON) for presets.
- Auth kinds, custom headers, per-provider pricing.
- Model menu with health dot.
- Relay mode per provider, with a status card and a "wake" button for cold
  starts.
- Demo mode with canned replies when no provider is set.

### Agent layer (`agent/`)
- `orchestrator.js` (695): capability registry, tool normalisation, task store,
  intent orchestration.
- `harness.js` (977): runs the agent, intent detection for image/video/search
  requests, subject extraction, query broadening.
- `trace.js` + `trace.css` (920): a live "thinking" trace UI mounted on
  messages.
- `features.js` (405): tokens, generation params, system prompt assembly,
  vision, PII redaction, prompt library, memory capture, follow-ups, usage and
  cost, retention, encrypted backup, share-as-HTML.

### Settings (5 tabs)
- **General**: send with Enter, smart follow-ups, auto-name chats, redact
  personal info.
- **Providers**: the full provider editor.
- **Prompts**: prompt library, inserted by typing `/`.
- **Usage**: per-provider table of replies, token estimate, estimated cost.
- **Data**: export, encrypted backup (WebCrypto), wipe.

### Other
- Conversation memory (facts captured across chats).
- Per-chat generation settings (system prompt, temperature, top-p, max tokens).
- Share a chat as a standalone HTML page.
- Export to Markdown.
- Feedback modal that opens the maker's email.
- Debug panel with a request log and a trace demo.
- PWA: service worker, manifest, install prompt.

---

## 4. Backend

**Relay** (`backend/relay/`, FastAPI):
- `/health`, `/v1/models`, `/v1/chat/completions`
- `/v1/images`, `/v1/videos` (generation, with provider racing)
- `/v1/search`, `/v1/fetch`, `/v1/read` (web research)
- `/v1/file`, `/v1/image-convert`
- `/v1/source/catalog`, `/admin/status`, `/admin/wake-llm`
- Modules: capabilities, files, images (618), media_core, media_providers,
  search, source_intelligence, videos.

**Lightning** (`backend/lightning/`, 335 lines): a second, near-duplicate
server with its own `/health`, `/v1/models`, `/v1/chat/completions`,
`/v1/search`, `/admin/start-llm`.

**Supabase**: one migration defining `profiles`, `waitlist`,
`workspace_grants`, `generations`, `comments`.

---

## 5. Auth, access, marketing

- `auth.html/.js`: sign in, sign up, forgot password, OTP, reset password.
- `access.js`: waitlist gate. `ACCESS_MODE: "open"` today; `"enforce"` would
  put Workspace behind a granted waitlist.
- Marketing and legal: about, contact, privacy, terms, data-security,
  acceptable-use, 404.
- `render.yaml` with CSP headers and route rewrites.

## 6. Tests and tooling

- `agent/tests/`: run (51), features (63), lifecycle (14), orchestrator (24),
  audit-regressions (7), **taste (91)**. All green.
- `audit/run.js`: 6360 generated scenarios. `audit/relay.py`: 1308.
- `backend/relay/tests/`: 11 pytest files, 77 pass / 2 fail (environmental).
- `build_inline.py`: inlines everything into `impose-standalone.html`
  (1.37 MB). Must be rebuilt on every CSS/JS change.

---

# What to cut, and what is built too far

Grouped by how confident I am, because these are recommendations, not facts.

## Cut: things that are pretending

**Auth is theatre.** `auth.js` validates that an email looks like an email and
a password is 8+ characters, then writes a session to `localStorage` and
redirects. Any password works. Five pages of it. This is the single most
misleading thing in the repo: it looks like a security boundary and is not
one. Either wire it to Supabase or delete it and ship the app as local-first
with no sign-in.

**Image / video / Git tool buttons are stubs.** Three items in the tool menu
whose entire implementation is `toast("... is coming soon.")`. Worse, the
relay *already implements* `/v1/images` and `/v1/videos` with provider racing
and a 618-line images module. So the capability exists on the server and the
UI says coming soon. Either wire the buttons up, which looks like a small job,
or remove them until you do.

**`onboardTitle`, `accessTitle`, `cmFeed`, `cmComposer`** are ids in the HTML
that no JS ever references. Dead markup.

## Cut: duplicated infrastructure

**The Lightning backend.** 335 lines duplicating the relay's health, models,
chat completions and search, plus its own `/admin/start-llm`. Nothing in the
frontend references it. Two servers to keep in sync, one of them unused.

## Over-engineered relative to what ships

**The agent orchestration layer.** `orchestrator.js` + `harness.js` is 1672
lines with a capability registry, tool normalisation, implied-capability
resolution, utility scoring, a persistent task store, and multi-step intent
planning. Exactly one tool is ever registered. That is a plugin architecture
serving a single plugin. It is not wrong, but it is a large, abstract surface
to carry and to keep tested (24 orchestrator assertions) for the value
currently extracted. Worth keeping only if multi-tool agent work is genuinely
next; otherwise the same behaviour is a few hundred lines.

**The provider catalog.** 1204 lines of JSON presets. Reasonable if users add
many providers, heavy if most add one and the UI already accepts any
OpenAI-compatible URL.

**Encrypted backup.** Full WebCrypto passphrase encryption with a
double-entry confirm modal, for data that otherwise sits unencrypted in
`localStorage` on the same machine. The threat model it defends against is
narrow: someone who can read your disk can usually read the plaintext store
anyway. It is a nice artefact, but it is defending a door next to an open
window.

**The 6360-scenario audit.** Impressive, and it does catch things, but
scenario count is not coverage. Worth checking how many of those 6360 are
distinct behaviours versus permutations.

## Questionable, needs a product call rather than a code call

**Remix and Challenge.** Two of the four post actions. Both have counts and
lock interactions. I cannot tell from the code whether people use them or
whether they are conceptual scaffolding from the original design. They cost
UI space in the most valuable row on the card.

**Community has no backend at all.** Every post, comment, count, and delete
lives in `localStorage`, seeded with fixture data. The Supabase schema for
`generations` and `comments` exists and is unused. This is the biggest gap
between what the product appears to be (a social feed) and what it is (a
single-device demo). Two tabs of the same browser sync; two devices do not,
and two people never meet. **If one thing gets planned next, it is this.**

**Debug panel and trace demo** ship in production. Fine if deliberate,
noise if not.

---

# The one-line version

Workspace is broad and capable but has drifted: real backend features sit
behind "coming soon" toasts, and a sophisticated agent framework runs one
tool. Community is polished and coherent but has no server, so it is a
beautiful single-player simulation of a social network. The next meaningful
feature is almost certainly persistence for Community, and the cheapest wins
are deleting the fake auth, the duplicate backend, and the three stub buttons.
