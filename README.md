# Impose. ChatGPT style chat client with bring your own key

A polished chat frontend that talks to real providers. Connect OpenAI,
Anthropic, Gemini, Groq, OpenRouter, or any endpoint you name yourself.
With no provider set, the app answers with built in demo replies.

## Run it

Any static server works. From this folder:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000

Or open `impose-standalone.html` directly. It is the same app in one file
with everything inlined, so it works from disk with no server.

## Files

- `index.html` markup and dialogs
- `styles.css` theme tokens, layout, motion
- `app.js` state, providers, streaming, markdown renderer, search
- `lucide.min.js` icon library, vendored so the app works offline
- `impose-standalone.html` portable single file build
- `build_inline.py` rebuilds the single file build

Rebuild with:

```bash
python3 build_inline.py
```

## Backend (self hosted)

`backend/` holds the control plane adopted from Luna: a Lightning GPU box
gateway (auth, generation proxy, web search, llama watchdog) plus an
optional always-on relay with wake on chat and idle auto stop. See
`backend/README.md` for the architecture and setup.

## Providers

Settings has a Providers tab. Adding one works like this:

1. Pick what you are connecting to. A preset fills in the request shape
   and the base address. Nothing it fills in is locked.
2. Paste a key. Keys stay in this browser's local storage. They are sent
   to your provider, nowhere else.
3. Tap Check models. Impose asks the provider what your key can actually
   use, and shows the answer as a list. Tap one to check it; only a
   model that answers is kept. Nothing is typed from memory.
4. Save. The kept model is checked once more with one real request
   before anything is kept.

Under Advanced: request shape (OpenAI style, Anthropic, Gemini), how the
key is sent (Bearer, a header you name, a query parameter you name, or
no key), and extra headers written one per line as Name: value. That
last one is what makes an endpoint nobody has heard of yet work today.
When a provider blocks browsers outright, Advanced also offers Send
through my relay: calls go server to server, and replies arrive whole
instead of streamed.

The top bar model menu lists every provider, plus demo mode. Switching
is instant. Failures come back as sentences about what to do, with the
provider's own detail attached when it offers any.

Notes:

- Anthropic sends the browser access header it documents, so direct
  calls from the page work.
- Plain http addresses are accepted only for hosts on your own network
  (localhost, LAN addresses). Everything else must be https.
- Export covers chats only. Keys are never exported.

## House rules honored

- Icons come only from the Lucide library via `data-lucide` attributes.
  No hand drawn SVG icons anywhere in the source.
- No `box-shadow`, `text-shadow`, or drop shadows. Depth comes from
  1px borders, layered flat fills, and spacing.
- No em dashes or en dashes in UI copy, code, or comments.
- No gradients, no purple filler art, no lorem ipsum, no filler adjectives
  in replies. Copy mirrors real product wording.

## Design notes (from emilkowalski/skills)

- Strong `ease-out` curve for entrances, `ease-in-out` for on screen
  movement, linear only for progress. Never `ease-in` on UI.
- UI motion stays under 300ms. Buttons press at 160ms with a subtle
  scale on `:active`. Only `transform` and `opacity` animate.
- Popovers scale from their trigger via a per open `transform-origin`.
  The centered modals are the exception.
- Search opens instantly with zero animation. It is keyboard initiated
  (Cmd/Ctrl + K), and frequent actions must feel instant.
- Destructive deletes use press and hold with a slow linear fill.
- Toasts stack bottom center and slide up on a soft curve.
- `prefers-reduced-motion` shortens all motion and speeds up streaming.

## Shortcuts

- Cmd/Ctrl + K toggles search
- Ctrl + Shift + O starts a new chat
- Esc closes menus and dialogs
- Enter sends, Shift + Enter adds a line (this is a setting)

## Make it yours

- Brand name, user name, and email are plain strings in `index.html`.
- The provider catalogue lives in the `PRESETS` array in `app.js`.
- Request shapes live in `streamChat`, `listModels`, and `probeModel`
  in `app.js`. A new shape is a new branch in each.
- Themes are CSS variable blocks at the top of `styles.css`.

## Hosting on Render

The chat UI is a static site and the relay is a small Python service.
Both deploy from this repo with one Blueprint file. See
[RENDER_SETUP.md](RENDER_SETUP.md) for the full walkthrough: Blueprint
deploy, env vars, keep-awake, and troubleshooting.
