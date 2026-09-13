# Hosting Impose Chat Clone on Render

One Blueprint file in this repo (`render.yaml`) deploys both halves: the
chat UI as a static site and the slim relay as a Python web service.

## What you get

- `impose-web`: the chat UI (`index.html`, `styles.css`, `app.js`, icons).
  Static, never sleeps, free.
- `impose-relay`: the always-on proxy in `backend/relay/`. Forwards chat
  and search to your GPU box, wakes it on demand, stops it when idle.

The relay is optional. The UI works without it when your providers are
reachable straight from the browser, but a browser cannot wake your box,
so use the relay once the box is live.

## Before you start

1. This repo pushed to GitHub (done: `GraphicMiles/Impose`).
2. A Render account with the repo connected (Dashboard, New, Blueprint,
   pick the repo).
3. Your box gateway root URL and its `CONTROL_KEY` (from the `.env` on
   the Studio, see `backend/.env.example`). If the box is not set up
   yet, deploy anyway and fill these in later; until the box answers,
   chats get a clear retry message instead of failing silently.
4. Lightning API details, only if you set `WAKE_STUDIO` to `1`.

## Deploy

1. In Render: New, Blueprint, select the Impose repo. Render reads
   `render.yaml` at the root and shows two services: `impose-web` and
   `impose-relay`.
2. Fill the relay env vars (table below). Anything marked `sync: false`
   must be typed in by hand. `CONTROL_KEY` gets a generated random
   value; copy it somewhere safe, it is the key your browser sends.
3. Apply. Render builds both. The UI lands on
   `https://impose-web.onrender.com` and the relay on
   `https://impose-relay.onrender.com` (exact hosts depend on the names
   you keep).
4. Every push to `main` redeploys both automatically.

## Relay env vars

| Var | Value | Meaning |
| --- | --- | --- |
| `CONTROL_KEY` | generated | The relay's own key. This is what you paste into the UI provider form. |
| `LLM_GATEWAY_URL` | box root, no `/v1` | e.g. `https://9000-abcd.cloudspaces.litng.ai` |
| `LLM_GATEWAY_KEY` | box `CONTROL_KEY` | Lets the relay talk to the box. |
| `ALLOWED_ORIGINS` | your web origin | The Blueprint defaults to `https://impose-web.onrender.com`. Add custom UI origins as a comma-separated list. |
| `WAKE_STUDIO` | `1` | The Blueprint enables it so wake-on-chat can work. Make sure the `LIGHTNING_*` values below are present before deploying. |
| `WAKE_ON_CHAT` | `1` | A chat triggers a wake only when `WAKE_STUDIO=1` and all Lightning values are configured. |
| `IDLE_MONITOR` | `1` | Stops the GPU Studio after idle minutes. Needs `WAKE_STUDIO` set to `1`. |
| `IDLE_STOP_MINUTES` | `5` | Idle minutes before the stop. |
| `IDLE_CHECK_MINUTES` | `5` | How often the relay checks. |
| `LIGHTNING_*` | your details | Needed only when `WAKE_STUDIO` is `1`. |

Search keys (`TAVILY_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY`) live on
the box, not the relay. Keyless DuckDuckGo plus Wikipedia work with
nothing filled in.

## Point the UI at the relay

1. Open your `impose-web` URL. Settings, Providers, Add provider, preset
   Self hosted.
2. Base URL: `https://impose-relay.onrender.com/v1` (your relay host
   plus `/v1`).
3. Key: the relay `CONTROL_KEY` from the dashboard.
4. Check models, tap one to check it, save. From here it behaves
   like any other provider.

## Keep-awake

Render's free tier sleeps a service after about 15 minutes with no
traffic. The static UI never sleeps, but the relay does. A sleeping
relay adds roughly a minute to the first request while it boots, then
behaves normally.

If that minute bothers you, use any free uptime pinger (cron-job.org,
UptimeRobot, and friends) to GET
`https://your-relay.onrender.com/health` every 5 minutes. That endpoint
needs no key and the relay stays warm.

Note the two different sleeps: the pinger keeps the relay warm;
`WAKE_ON_CHAT=1` together with `WAKE_STUDIO=1` wakes the GPU box. They
cover different halves.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Relay answers 401 on every call | The key in the UI does not match the relay `CONTROL_KEY`. Copy it fresh from the Render dashboard. |
| Gateway card says automatic wake is disabled | Set `WAKE_STUDIO=1`, then provide `LIGHTNING_API_KEY`, `LIGHTNING_STUDIO`, and `LIGHTNING_TEAMSPACE`. Add the username/user ID too if your Studio lookup needs an explicit owner. |
| Chat says the box is down | Read the Gateway card note. Check `LLM_GATEWAY_URL` first. A wake is actually in flight only when the card says **Gateway is waking**; `WAKE_ON_CHAT=1` alone cannot start a Studio. |
| Blank page on the UI host | The static build failed. Check the `impose-web` build logs in Render; a manual redeploy from the dashboard usually clears it. |
| Old UI after a push | Hard refresh (Ctrl Shift R). Render redeploys on push, your browser caches the rest. |
| Search returns nothing | The box search chain found nothing, or the box is down. Keyless providers can be rate limited; add a search key on the box if it persists. |
| CORS errors in the console | Serve the UI over https and keep `ALLOWED_ORIGINS` as `*`. Both servers send open CORS headers. The debug tab shows the exact failing request. |
| Probe fails but Check models passes | If the shape is right, the provider may block browsers (a firewall answers instead of the API). Turn on Send through my relay in the provider Advanced section, with the relay address and key filled in. |

## Costs

Static site: free. Relay on the free plan: free, with sleep. GPU box:
your Lightning credits, trimmed by the idle monitor.
