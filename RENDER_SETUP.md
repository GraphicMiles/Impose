# Hosting Impose Chat Clone on Render

One Blueprint file in this repo (`render.yaml`) deploys both halves: the
chat UI as a static site and the slim relay as a Python web service.

## What you get

- `impose-web`: the chat UI (`index.html`, `styles.css`, `app.js`, icons).
  Static, never sleeps, free.
- `impose-relay`: the optional service in `backend/relay/`. It provides
  keyless search, images, verified YouTube and Twitch media results, page reading, and an optional provider proxy.

The UI and public relay tools do not require a GPU gateway. Direct browser
providers and demo mode also work without the relay. Lightning gateway wake
and idle control are optional and disabled by default.

## Before you start

1. This repo pushed to GitHub (done: `GraphicMiles/Impose`).
2. A Render account with the repo connected (Dashboard, New, Blueprint,
   pick the repo).
3. No GPU or Lightning configuration is required. If you later connect a
   self-hosted model, add its gateway URL and key in the Render dashboard.
4. Lightning API details are needed only if you deliberately enable Studio
   wake by changing `WAKE_STUDIO` to `1`.

## Deploy

1. In Render: New, Blueprint, select the Impose repo. Render reads
   `render.yaml` at the root and shows two services: `impose-web` and
   `impose-relay`.
2. Review the relay env vars below. `CONTROL_KEY` gets a generated random
   value; copy it somewhere safe, because it is the owner key your browser
   sends for protected relay features.
3. Apply. Render builds both. The UI lands on
   `https://impose-web.onrender.com` and the relay on
   `https://impose-relay.onrender.com` (exact hosts depend on the names
   you keep).
4. Every push to `main` redeploys both automatically.

## Relay env vars

| Var | Value | Meaning |
| --- | --- | --- |
| `CONTROL_KEY` | generated | The relay's own key. This is what you paste into the UI provider form. |
| `ALLOWED_ORIGINS` | your web origin | The Blueprint defaults to `https://impose-web.onrender.com`. Add custom UI origins as a comma-separated list. |
| `WAKE_STUDIO` | `0` | Optional. Set to `1` only after adding all required `LIGHTNING_*` values. |
| `WAKE_ON_CHAT` | `0` | Optional. Set to `1` only when Studio wake is fully configured. |
| `IDLE_MONITOR` | `0` | Optional GPU auto-stop. Needs `WAKE_STUDIO=1`. |
| `IDLE_STOP_MINUTES` | `5` | Idle minutes before an enabled stop. |
| `IDLE_CHECK_MINUTES` | `5` | How often an enabled idle monitor checks. |
| `LLM_GATEWAY_URL` | optional box root, no `/v1` | Add in the dashboard only when connecting a self-hosted model. |
| `SUPABASE_URL` | `https://xgqcvuzkeaferjsnpjjw.supabase.co` | The relay creates accounts itself, so it needs to reach Supabase. |
| `SUPABASE_SERVICE_KEY` | service role key, Project Settings > API | **The most dangerous credential in the system: it bypasses RLS.** It is what lets the relay create a confirmed user after it has checked a code, which is the only way an account can be made once public signup is off. Server side only. It must never appear in `config.js`, in the browser, or in this repo. |
| `SENDLIB_API_KEY` | from sendlib | Sends the sign-up and password-reset codes. Without it the relay prints codes to its log instead of emailing them, which is fine locally and wrong in production. |
| `SENDLIB_FROM` | your connected Gmail | The address Sendlib relays through. Must be a Gmail or Workspace account connected in the Sendlib dashboard. |
| `SENDLIB_REPLY_TO` | optional support address | Where replies to the code emails go. |
| `SENDLIB_ORIGIN` | optional | Sent as the `Origin` header so Sendlib can match its per-key allowlist. Defaults to `https://impose-relay.onrender.com`. **Add that exact value to the key's allowed origins in the Sendlib dashboard**, or sends are refused with `Origin not allowed: 'unknown'` even though the key is correct. |
| `SENDLIB_URL` | optional | Defaults to `https://sendlib.samueltuoyo.com/api/send`. |
| `OTP_PEPPER` | generated, 32+ random chars | Mixed into the code hash. Set it before launch: rotating it later invalidates every code in flight, which is harmless, but leaving it empty weakens the stored hashes. |
| `APP_NAME` | `Impose` | Used in the email subject line. |

### Checking it works

`GET /admin/accounts` with the relay's `CONTROL_KEY` as a bearer token
reports every dependency of the account flow: whether each credential is
present, whether the code store is actually callable, and what the mail
provider says when asked. Two outages so far looked identical from outside
(a 502 with a deliberately vague message) and both were told apart by this
one call: a missing database grant, then a Sendlib origin rejection.

```
curl https://impose-relay.onrender.com/admin/accounts -H "Authorization: Bearer $CONTROL_KEY"
```

`ready: true` means signup will reach the database. A non-`ok` `sendlib`
value means codes will not be delivered, and the message is the provider's
own words.

### Supabase dashboard, before any of this works

Two settings, both of which move the decision off the browser:

1. **Authentication > Sign In / Providers > Email > Confirm email: OFF.**
   The relay confirms the address itself, having just delivered a code to
   it. Left on, Supabase also emails its own link and the user gets two
   messages for one signup.

2. **Authentication > Sign In / Providers > Email > Allow new users to sign
   up: OFF.** This is the one that closes the hole. With it on, the
   publishable key can create a confirmed account directly and the code is
   decorative; an attacker simply skips it. Off, the service role is the
   only thing that can mint a user, and the only code path that uses it
   runs after verification inside the relay.

Run `supabase/migrations/0002_auth_codes.sql` as well as `0001`: the codes
live in a table now, because the free tier sleeps and a restart used to
strand anyone mid-signup.
| `LLM_GATEWAY_KEY` | optional box key | Lets the relay talk to that model gateway. |
| `LIGHTNING_*` | optional | Needed only when `WAKE_STUDIO=1`. |

The relay's default search and image engines are keyless and work without a
GPU box or Lightning account.

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

Note the two different sleeps: the pinger keeps only the Render relay warm.
It does not contact or require a GPU gateway. If configured later,
`WAKE_ON_CHAT=1` together with `WAKE_STUDIO=1` controls the GPU box.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Relay answers 401 on every call | The key in the UI does not match the relay `CONTROL_KEY`. Copy it fresh from the Render dashboard. |
| Gateway card says automatic wake is disabled | Set `WAKE_STUDIO=1`, then provide `LIGHTNING_API_KEY`, `LIGHTNING_STUDIO`, and `LIGHTNING_TEAMSPACE`. Add the username/user ID too if your Studio lookup needs an explicit owner. |
| Chat says the box is down | Read the Gateway card note. Check `LLM_GATEWAY_URL` first. A wake is actually in flight only when the card says **Gateway is waking**; `WAKE_ON_CHAT=1` alone cannot start a Studio. |
| Blank page on the UI host | The static build failed. Check the `impose-web` build logs in Render; a manual redeploy from the dashboard usually clears it. |
| Old UI after a push | Hard refresh (Ctrl Shift R). Render redeploys on push, your browser caches the rest. |
| Search returns nothing | The keyless search engines found nothing or rate limited the relay. This is independent of the GPU gateway. |
| CORS errors in the console | Serve the UI over https and include its exact origin in `ALLOWED_ORIGINS`. The debug tab shows the failing request. |
| Probe fails but Check models passes | If the shape is right, the provider may block browsers (a firewall answers instead of the API). Turn on Send through my relay in the provider Advanced section, with the relay address and key filled in. |

## Costs

Static site: free. Relay on the free plan: free, with sleep. There is no GPU
cost unless you later connect and enable a model gateway.
