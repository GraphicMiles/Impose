# Nova. ChatGPT style chat client (frontend demo)

A polished, frontend only clone of a modern AI chat app. New chats, history
grouped by date, search, streaming replies with markdown, model picker, three
themes, settings, and toasts. Chats persist in the browser via localStorage.

## Run it

Any static server works. From this folder:

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000

Or open `nova-standalone.html` directly. It is the same app in one file
with everything inlined, so it works from disk with no server.

## Files

- `index.html` markup and dialogs
- `styles.css` theme tokens, layout, motion
- `app.js` state, streaming, markdown renderer, search, settings
- `lucide.min.js` icon library, vendored so the app works offline
- `nova-standalone.html` portable single file build
- `build_inline.py` rebuilds the single file build

Rebuild with:

```bash
python3 build_inline.py
```

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
  The centered settings modal is the one exception.
- Search opens instantly with zero animation. It is keyboard initiated
  (Cmd/Ctrl + K), and frequent actions must feel instant.
- Destructive delete uses press and hold with a slow linear fill.
- Toasts stack bottom center and slide up on a soft curve.
- `prefers-reduced-motion` shortens all motion and speeds up streaming.

## Shortcuts

- Cmd/Ctrl + K toggles search
- Ctrl + Shift + O starts a new chat
- Esc closes menus and dialogs
- Enter sends, Shift + Enter adds a line (this is a setting)

## Make it yours

- Brand name, user name, and email are plain strings in `index.html`.
- Models live in the model menu in `index.html` plus `syncModelLabel`.
- Canned replies live in the `REPLIES` object in `app.js`. To go live,
  replace `generateReply` plus `streamAssistant` with a fetch call to
  your API and stream tokens into the same renderer.
- Themes are CSS variable blocks at the top of `styles.css`.
