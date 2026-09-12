# Impose backend: self hosted generation plus web search

The control plane adopted from Luna, trimmed to the two things Impose needs:
talking to a self hosted model on Lightning AI (generation), and searching
the web. No cron jobs, no demo monitors. Those can be added later following
Luna's `render-control-plane` job pattern.

## Architecture

```
Browser (Nova web UI) or any client
  │  HTTPS + Authorization: Bearer <CONTROL_KEY>
  │  (CORS is enabled, so the web UI calls these hosts directly)
  ▼
[optional layer 2] Relay (Render free tier, backend/relay/)
auth · wake-on-chat · idle auto-stop · proxy
  │  HTTPS + Bearer <LLM_GATEWAY_KEY>
  ▼
GPU box gateway (Lightning Studio, backend/lightning/)
auth · CORS · /v1/* proxy · /v1/search · llama watchdog
  │  http://127.0.0.1:8080 + Bearer <LLM_API_KEY> (localhost only)
  ▼
llama-server (Qwen3-Coder-30B-A3B Q3_K_M, 16k ctx, 44 GPU layers)
```

The relay is optional. The web UI can point straight at the box gateway.
Add the relay when you want the box to sleep between chats (it wakes the
Studio on demand and stops it after idle, which saves credits).

## Endpoints

Box gateway (`backend/lightning/`, port 9000 on the Studio):

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | open | liveness, model, search chain, uptime |
| `GET /v1/models` | Bearer | model list (proxied, spawns the LLM if down) |
| `POST /v1/chat/completions` | Bearer | chat incl. SSE streaming (proxied) |
| `GET /v1/search?q=&count=` | Bearer | web search, easy to curl |
| `POST /v1/search` | Bearer | web search, body `{query, count}` |
| `GET /admin/status` | Bearer | model status, search chain, uptime |
| `POST /admin/start-llm` | Bearer | (re)start llama-server if down |

Relay (`backend/relay/`, Render or anywhere):

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | open | liveness + gateway status (ping this to keep Render awake) |
| `GET /v1/models` | Bearer | proxied, wakes the box on 503 when configured |
| `POST /v1/chat/completions` | Bearer | proxied incl. SSE, wakes the box on 503 when configured |
| `GET/POST /v1/search` | Bearer | proxied to the box |
| `GET /admin/status` | Bearer | gateway status, idle minutes, wake flags |
| `POST /admin/wake-llm` | Bearer | wake the chain now (`?background=1` returns at once) |

Search replies look like this (same from both layers):

```json
{
  "query": "lagos traffic today",
  "provider": "duckduckgo",
  "results": [{"title": "...", "url": "...", "snippet": "..."}]
}
```

`provider` is `""` when nothing answered. `count` is clamped to 1..10.

## Search providers

`SEARCH_PROVIDERS` lists backends in try order. The first configured one
that returns results wins. Keyed backends are skipped when their key env
is empty.

| Name | Key env | Notes |
|---|---|---|
| `tavily` | `TAVILY_API_KEY` | AI focused, best snippets, free tier |
| `brave` | `BRAVE_API_KEY` | general index, free tier |
| `serper` | `SERPER_API_KEY` | Google results as JSON |
| `duckduckgo` | none | default, best effort HTML parsing |
| `wikipedia` | none | default fallback, reliable for facts |

Default chain is `duckduckgo,wikipedia`: no keys, works on day one. Add a
keyed provider when you want stronger general results.

## Setup (next turn checklist)

### Part 1: the GPU box (required)

1. On lightning.ai, create a Studio: GPU, T4, teamspace of your choice.
   Note the Studio name and teamspace for later.
2. Open a terminal in the Studio and get a build of llama.cpp, either from
   a release archive or from source. You need the `llama-server` binary.
3. Download the model weights into `~/impose/backend/lightning/models/`:
   `Qwen3-Coder-30B-A3B-Instruct-Q3_K_M.gguf` (about 18 GB).
4. Clone this repo to `~/impose` (or copy the `backend/` folder there).
5. `cd ~/impose/backend && pip install -r requirements.txt`.
6. Copy `backend/.env.example` to `backend/lightning/.env`, set `CONTROL_KEY`
   (long random string) and `LLM_API_KEY` (another one), then `chmod 600`
   the file. Keep the T4-tested defaults for context and GPU layers.
7. `bash backend/lightning/restart_all.sh`, then
   `curl http://127.0.0.1:9000/health` and expect `"llm_up": true`
   (first boot loads the model, give it a minute).
8. In the Studio settings, expose port 9000 publicly and copy the
   `https://9000-....cloudspaces.litng.ai` URL. That root plus `/v1` is
   the base address for clients.

### Part 2: the web UI (same turn, two minutes)

In Nova: Settings → Providers → Add → Self hosted. Paste the public box
URL plus `/v1` as the base address, the box `CONTROL_KEY` as the key
(Bearer is the default), tap Check models, pick three, save. Chat now
runs on your own model.

### Part 3: the relay (optional, later)

1. Push this repo to GitHub (root `render.yaml` is the Blueprint).
2. Render → New → Blueprint → pick the repo. Set `LLM_GATEWAY_URL` (box
   root, no `/v1`) and `LLM_GATEWAY_KEY` (box `CONTROL_KEY`). Copy the
   generated relay `CONTROL_KEY`: browsers use that one from then on.
3. Keep it awake with a free UptimeRobot monitor on `/health` every
   5 minutes, or the free tier sleeps after 15 idle minutes.
4. For wake and idle control: `WAKE_STUDIO=1` plus the `LIGHTNING_*`
   vars (account key from Lightning global settings, Studio and
   teamspace names, `T4` machine). Clients then point at the relay
   `/v1` base instead of the box.

## Testing

```bash
# box is alive, model loaded, search chain visible
curl http://127.0.0.1:9000/health

# search (from anywhere, with the key)
curl "https://BOX/v1/search?q=lagos&count=3" -H "Authorization: Bearer KEY"

# chat, non streaming
curl https://BOX/v1/chat/completions -H "Authorization: Bearer KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-coder-30b","stream":false,"messages":[{"role":"user","content":"Say OK"}]}'
```

## Files

| Path | Purpose |
|---|---|
| `backend/requirements.txt` | shared deps (fastapi, uvicorn, httpx) |
| `backend/.env.example` | every variable, both layers, no real values |
| `backend/common/websearch.py` | search chain, imported by the box gateway |
| `backend/lightning/server.py` | box gateway: auth, CORS, proxy, search, watchdog |
| `backend/lightning/restart_all.sh` | one command reboot of the box stack |
| `backend/relay/server.py` | optional relay: proxy, wake-on-chat, idle auto-stop |
| `backend/relay/requirements.txt` | relay extra dep (lightning-sdk) |
| `render.yaml` (repo root) | Render Blueprint for the relay |

## Security notes

- Three keys, three jobs: browser key (relay `CONTROL_KEY`, or the box
  one when relay-less), box `CONTROL_KEY` (relay → box), `LLM_API_KEY`
  (gateway → llama-server on localhost only). Never reuse one for another.
- Compare with `hmac.compare_digest`. `.env` is chmod 600 and never
  committed (`.gitignore` enforces it).
- llama-server binds 127.0.0.1 with its own key. Only port 9000 (the
  gateway) is ever exposed publicly.

## Honest limits

- Free Studios restart about every 4 hours and stop when credits run
  out. `restart_all.sh` (or the relay wake path) brings the stack back.
- T4 credits are free but finite: idle auto-stop on the relay is how
  you avoid burning them overnight.
- DuckDuckGo HTML parsing is best effort and datacenter IPs get
  throttled first; that is what the chain and the keyed providers are for.
