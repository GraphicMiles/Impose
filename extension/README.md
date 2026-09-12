# Impose Agent Bridge (companion extension)

Lets the Impose web app read pages and perform your approved actions in
tabs where you are already logged in (X DMs today, more drivers later).
It never sees passwords: login always happens on the site itself, in
your own browser.

## Install (Chrome or Edge, 2 minutes)

1. Open `chrome://extensions`, turn on **Developer mode**.
2. **Load unpacked**, pick this `extension/` folder.
3. Pin it if you like. No login, no account, nothing to configure.
4. Open Impose, press the puzzle button in the top bar. It shows green
   when the bridge answers.

To update after a Impose release: return to `chrome://extensions` and
press the reload icon on Impose Agent Bridge.

## Mobile: use paste mode

Chrome on Android cannot run extensions, and the old workaround
browsers are discontinued. On your phone, open Agent actions in Impose
and scroll to paste mode: copy the conversation from your X app,
paste it in, draft, and copy the reply back. No install. The
extension stays the desktop path for true one-tap sending.

## How a send works

1. Open x.com in a tab and log in there.
2. In Impose: Agent actions → pick the tab → Read page → Threads.
3. Draft with Impose (or type the reply yourself) and review the text.
4. Send: the button arms first ("Tap again to send"), the second tap
   executes. Every send is logged in the panel and the debug log.

## Protocol (v1, JSON over postMessage)

Page → bridge content script → background → site tab, answers bubble
back with the same `id`:

- `ping` → `{ version, protocol }`
- `tabs.list` → `{ tabs: [{ tabId, title, url }] }`
- `probe` → `{ url, title, loggedOut, composer, send, threads }`
- `snapshot` → `{ url, title, text }` (bounded, main content)
- `dm.list` → `{ threads: [{ name, snippet, url }] }`
- `dm.send { tabId, threadUrl?, text }` → `{ sent: true }`

Errors are `{ ok: false, error }` with a human sentence.

## Permissions, and why each exists

- `tabs`: list your X tabs so you can pick where the agent acts.
- `storage`: one tiny status line for the toolbar popup.
- Host access, Impose origin only for the bridge; `x.com` and
  `twitter.com` only for reading and approved DM replies. No
  `<all_urls>`, no browsing history, no cookies API.

## When X redesigns

X obfuscates its markup, so selectors can break overnight. If a send
fails with "X may also have changed their markup", use **Check page**:
it reports exactly which pieces (composer, send button, threads) the
driver can still see, which is the whole diagnosis.

## Files

- `manifest.json` — MV3, Chrome 116+.
- `background.js` — routes commands, navigates to threads.
- `content/impose-bridge.js` — same-origin page relay, Impose origin only.
- `content/x-actions.js` — the X driver (probe, snapshot, dm.*).
- `popup.html/js` — toolbar status.
