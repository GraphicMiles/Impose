# Impose

An agent workspace where a request runs as something you can watch: the plan it
makes, the tools it picks, the approvals it asks you for, and a trace of what
actually happened.

The interface is a single HTML shell. The work happens in a Python backend that
relays to a llama.cpp server on a GPU box, alongside helpers for web search,
files, images, media and email.

## Why it exists

Most agent products show a spinner and then an answer. When the answer is wrong,
there is nothing to inspect. Impose is built the other way round: the run is the
product, and the answer is what the run produces. Every step is a visible object
with its own state, so a failure points at the step that failed instead of at the
whole request.

## What you can do

- **Send a request** and watch it turn into a plan with named steps.
- **See the tools it chooses**, including the arguments, before they run.
- **Approve or refuse** the steps that need a human, such as sending mail or
  writing files.
- **Read the trace** afterwards: what ran, in what order, what came back.
- **Pick capabilities** from the workspace registry rather than from a fixed
  prompt.

## Running it

Web shell:

```bash
npm ci
PORT=3000 npm start
```

`server.js` serves `index.html` for every non-file path and applies the content
security policy defined at the top of the file.

Backend relay, which expects a reachable GPU gateway:

```bash
cd backend/relay
pip install -r requirements.txt
CONTROL_KEY=local-dev-key \
LLM_GATEWAY_URL=http://127.0.0.1:8080 \
LLM_GATEWAY_KEY=local-dev-key \
python server.py
```

Every variable the relay reads is listed at the top of `backend/relay/server.py`
and in `backend/.env.example`. `backend/lightning/server.py` is the authenticated
gateway in front of llama-server, which stays bound to localhost.

## What is not here

- The shell runs on its own, but a real request needs the relay and a GPU
  gateway. Without them the interface shows the failure state.
- There is no hosted public instance in this repository. `render.yaml` is the
  blueprint used for deployment.
- The capability set is the one committed here. Adding tools means editing
  `agent/features.js`.

## How it is built

```
index.html              the whole web interface, owns its own state
server.js               Express server: shell, CSP, headers
manifest.json           installable web app manifest
agent/                  orchestration: plan, resolve tools, execute, verify
  orchestrator.js       intent-driven capability orchestration
  harness.js            execution harness
  features.js           capability registry
  trace.js, trace.css   the run trace the interface renders
  tests/                orchestrator and feature tests
backend/
  relay/                always-on layer in front of the GPU box
  lightning/            authenticated gateway in front of llama.cpp
  common/websearch.py   provider chain shared by both
supabase/migrations     ordered schema history, applied by supabase/apply.sh
```

Media helpers live in `backend/relay/` next to the capabilities that call them:
`files.py`, `images.py`, `media_core.py`, `media_providers.py`, `mailer.py`,
`otp_store.py`, `reports_store.py`, `search.py`, `source_intelligence.py`.

### Tests

```bash
node agent/tests/run.js
```

Two GitHub workflows handle the database side: `supabase-migrate.yml` applies
migrations and `db-backup.yml` takes the backup.

### Deploy

`render.yaml` provisions the web service and the relay together.
`render-relay.yaml` provisions the relay alone, which is the file to point a
fresh Render blueprint at.
