# Impose

An agent workspace where a request runs as something you can watch: the plan,
the tools it picks, the approvals it asks for, and a trace of what happened.

The interface is a single HTML shell. The thinking happens in a Python backend
that talks to a llama.cpp server on a GPU box, plus web search, files, media and
email helpers.

## Layout

```
index.html              the whole web interface (one page, owns its own state)
server.js               Express server: serves the shell, sets CSP and headers
manifest.json           installable web app manifest
agent/                  orchestration: plan → resolve tools → execute → verify
  orchestrator.js       intent-driven capability orchestration, task states
  harness.js            execution harness
  features.js           capability registry
  trace.js, trace.css   the run trace the interface renders
  tests/                orchestrator and feature tests
backend/
  relay/                always-on layer in front of the GPU box
    server.py           OpenAI-compatible surface, wake-on-chat, idle stop
    routers/            auth, admin, media
    capabilities.py     tool capability definitions
    files.py, images.py, media_core.py, media_providers.py
    mailer.py, otp_store.py, reports_store.py, search.py
    source_intelligence.py, supabase_admin.py
    provider_catalog.json
  lightning/            GPU box gateway
    server.py           auth-gated proxy in front of llama.cpp, plus search
  common/websearch.py   provider chain used by both
supabase/
  migrations/           schema and auth migrations, numbered
  apply.sh
render.yaml             production blueprint (web + relay)
render-relay.yaml       standalone blueprint for the relay only
_headers                static host headers
```

## Running the web shell

```sh
npm ci
PORT=3000 npm start
```

`server.js` serves `index.html` on every non-file path and applies the CSP from
the top of the file. The interface embeds its typeface as a data URI, which is
why `font-src` includes `data:`.

## Running the backend

The relay expects a reachable GPU gateway:

```sh
cd backend/relay
pip install -r requirements.txt
CONTROL_KEY=local-dev-key \
LLM_GATEWAY_URL=http://127.0.0.1:8080 \
LLM_GATEWAY_KEY=local-dev-key \
python server.py
```

Environment variables are listed at the top of `backend/relay/server.py` and in
`backend/.env.example`. The gateway in `backend/lightning/server.py` needs its
own `CONTROL_KEY`; llama-server stays bound to `127.0.0.1` and is only reached
through the gateway.

## Agent tests

```sh
node agent/tests/run.js
```

## Database

`supabase/migrations` is the ordered schema history; `supabase/apply.sh` applies
it. The two GitHub workflows in `.github/workflows/` handle migrations and
database backups.

## Deploy

`render.yaml` at the repository root provisions the web service and the relay
together. `render-relay.yaml` provisions the relay alone, for a fresh Render
account; point a new Blueprint instance at that file instead of the default.
