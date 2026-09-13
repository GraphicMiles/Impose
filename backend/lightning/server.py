#!/usr/bin/env python3
"""Impose control plane: the GPU box gateway (Lightning AI Studio).

Auth-gated reverse proxy in front of a self-hosted llama.cpp server, plus
web search. Adapted from Luna's lightning-control-plane, trimmed to the two
things Impose needs: generation and websearch. No cron jobs here.

What it does
------------
1. AUTH      Every /v1/* and /admin/* route requires
             `Authorization: Bearer <CONTROL_KEY>` (constant-time compare).
             llama-server binds to 127.0.0.1 and is only reached from here.
2. GENERATE  GET /v1/models and POST /v1/chat/completions (incl. SSE
             streaming) are forwarded to llama-server with its key attached.
3. SEARCH    GET/POST /v1/search runs the provider chain in common/websearch
             (keyless DuckDuckGo + Wikipedia by default, keyed Tavily/Brave/
             Serper when configured) and returns title/url/snippet results.
4. WATCHDOG  On startup (and via /admin/start-llm) it spawns llama-server if
             the model is not answering, so after a Studio restart, launching
             just this process brings the whole stack back.
5. CORS      Enabled for browser clients (the Impose web UI calls this host
             directly). Tighten ALLOWED_ORIGINS once the UI has a fixed home.

Config (env, or a .env file next to this script):
    CONTROL_KEY     required: the key clients must present (Bearer)
    LLM_BASE_URL    default http://127.0.0.1:8080
    LLM_API_KEY     required: llama-server's --api-key (kept server-side only)
    LLM_MODEL       default models/Qwen3-Coder-30B-A3B-Instruct-Q3_K_M.gguf
    LLM_ALIAS       default qwen3-coder-30b (the id clients see)
    LLM_CONTEXT     default 16384
    LLM_NGL         default 44 (GPU layers; T4-tested for the 30B Q3 model)
    START_LLM       default 1 (spawn llama-server on startup)
    PORT            default 9000 (the publicly exposed Studio port)
    ALLOWED_ORIGINS default * (comma separated to tighten)
    SEARCH_PROVIDERS default duckduckgo,wikipedia (try order)
    TAVILY_API_KEY / BRAVE_API_KEY / SERPER_API_KEY (optional search keys)
"""
import atexit
import hmac
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # backend/
from common.websearch import configured_chain, web_search  # noqa: E402

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

# --------------------------------------------------------------------------- #
# config
# --------------------------------------------------------------------------- #

BASE_DIR = Path(os.environ.get("CP_DIR", str(Path(__file__).resolve().parent)))
ENV_FILE = BASE_DIR / ".env"
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

CONTROL_KEY = os.environ.get("CONTROL_KEY", "")
LLM_BASE_URL = os.environ.get("LLM_BASE_URL", "http://127.0.0.1:8080").rstrip("/")
LLM_API_KEY = os.environ.get("LLM_API_KEY", "")
LLM_MODEL = os.environ.get("LLM_MODEL", "models/Qwen3-Coder-30B-A3B-Instruct-Q3_K_M.gguf")
LLM_ALIAS = os.environ.get("LLM_ALIAS", "qwen3-coder-30b")
LLM_CONTEXT = os.environ.get("LLM_CONTEXT", "16384")
LLM_NGL = os.environ.get("LLM_NGL", "44")
PORT = int(os.environ.get("PORT", "9000"))
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]

if not CONTROL_KEY:
    print("[control-plane] WARNING: no CONTROL_KEY set, auth disabled (dev only).", flush=True)

app = FastAPI(title="impose-control-plane")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
STARTED_AT = time.time()
LLM_PROC = None
_spawn_lock = threading.Lock()


def _reap_llm() -> None:
    """Do not leave llama-server holding the GPU after the gateway exits."""
    global LLM_PROC
    if LLM_PROC is not None and LLM_PROC.poll() is None:
        try:
            LLM_PROC.terminate()
            try:
                LLM_PROC.wait(timeout=10)
            except subprocess.TimeoutExpired:
                LLM_PROC.kill()
        except Exception:
            pass


atexit.register(_reap_llm)

# --------------------------------------------------------------------------- #
# auth
# --------------------------------------------------------------------------- #


def _authed(request: Request) -> None:
    if not CONTROL_KEY:
        return
    supplied = request.headers.get("Authorization", "")
    expected = "Bearer " + CONTROL_KEY
    if not hmac.compare_digest(supplied, expected):
        raise HTTPException(status_code=401, detail="invalid or missing API key")


# --------------------------------------------------------------------------- #
# upstream LLM helpers
# --------------------------------------------------------------------------- #


def _upstream_headers(extra: dict | None = None) -> dict:
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = "Bearer " + LLM_API_KEY
    if extra:
        headers.update(extra)
    return headers


def llm_reachable() -> bool:
    try:
        r = httpx.get(f"{LLM_BASE_URL}/health", timeout=3.0)
        return r.status_code == 200
    except Exception:
        return False


def _model_path() -> Path:
    """Resolve relative model paths from the gateway directory, not its cwd."""
    path = Path(LLM_MODEL).expanduser()
    return path.resolve() if path.is_absolute() else (BASE_DIR / path).resolve()


def spawn_llm() -> bool:
    """Start one llama-server process if it is not already answering."""
    global LLM_PROC
    with _spawn_lock:
        if llm_reachable():
            return True
        if LLM_PROC is not None and LLM_PROC.poll() is None:
            # Another request already launched a model that is still loading.
            for _ in range(60):
                if llm_reachable():
                    return True
                if LLM_PROC.poll() is not None:
                    return False
                time.sleep(1)
            return llm_reachable()
        if not LLM_MODEL:
            return False
        model_path = _model_path()
        if not model_path.is_file():
            print(f"[control-plane] model file not found: {model_path}", flush=True)
            return False
        cmd = [
            "llama-server",
            "-m", str(model_path),
            "--host", "127.0.0.1",
            "--port", "8080",
            "-c", LLM_CONTEXT,
            "-ngl", LLM_NGL,
            "--parallel", "1",
            "--alias", LLM_ALIAS,
        ]
        if LLM_API_KEY:
            cmd += ["--api-key", LLM_API_KEY]
        log = open(BASE_DIR / "llama-server.log", "ab")
        started = False
        try:
            try:
                LLM_PROC = subprocess.Popen(
                    cmd, cwd=str(model_path.parent), stdout=log, stderr=log,
                    start_new_session=True)
                started = True
            except FileNotFoundError:
                # llama-server not on PATH, try the Studio build paths.
                for cand in (BASE_DIR / "llama-server",
                             Path.home() / "llama.cpp/build/bin/llama-server"):
                    if cand.is_file():
                        cmd[0] = str(cand)
                        LLM_PROC = subprocess.Popen(
                            cmd, cwd=str(model_path.parent), stdout=log,
                            stderr=log, start_new_session=True)
                        started = True
                        break
        finally:
            # Popen duplicated the descriptor for the child; the gateway does
            # not need to hold its own copy for the lifetime of the model.
            log.close()
        if not started:
            print("[control-plane] llama-server binary not found", flush=True)
            return False
        # Give the model up to a minute to bind. Later requests can re-check a
        # still-loading process without spawning a duplicate because of lock.
        for _ in range(60):
            if llm_reachable():
                return True
            if LLM_PROC is not None and LLM_PROC.poll() is not None:
                return False
            time.sleep(1)
        return llm_reachable()


# --------------------------------------------------------------------------- #
# routes
# --------------------------------------------------------------------------- #


@app.get("/health")
def health():
    return {"ok": True, "service": "impose-control-plane",
            "llm_up": llm_reachable(), "model": LLM_ALIAS,
            "search": configured_chain(),
            "uptime_seconds": round(time.time() - STARTED_AT, 1)}


@app.get("/v1/models")
def models(request: Request):
    _authed(request)
    if not llm_reachable() and not spawn_llm():
        raise HTTPException(status_code=503, detail="upstream LLM is down")
    r = httpx.get(f"{LLM_BASE_URL}/v1/models", headers=_upstream_headers(), timeout=30.0)
    return Response(content=r.content, media_type="application/json", status_code=r.status_code)


@app.post("/v1/chat/completions")
async def chat(request: Request):
    _authed(request)
    raw = await request.body()
    if len(raw) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="request body too large (max 10MB)")
    try:
        body = json.loads(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")
    if not await run_in_threadpool(llm_reachable) and not await run_in_threadpool(spawn_llm):
        raise HTTPException(status_code=503, detail="upstream LLM is down")
    req = httpx.Request("POST", f"{LLM_BASE_URL}/v1/chat/completions",
                        headers=_upstream_headers(), json=body)
    client = httpx.AsyncClient(timeout=None)
    resp = await client.send(req, stream=True)
    if body.get("stream"):
        async def sse():
            try:
                async for chunk in resp.aiter_bytes():
                    yield chunk
            finally:
                await client.aclose()
        headers = {k: v for k, v in resp.headers.items()
                   if k.lower() in ("content-type", "cache-control")}
        return StreamingResponse(sse(), status_code=resp.status_code, headers=headers)
    content = await resp.aread()
    await client.aclose()
    return Response(content=content,
                    media_type=resp.headers.get("content-type", "application/json"),
                    status_code=resp.status_code)


async def _search(query: str, count: int):
    provider, results = await run_in_threadpool(web_search, query, count)
    return {"query": query, "provider": provider, "results": results}


@app.get("/v1/search")
async def search_get(request: Request, q: str = "", count: int = 5):
    _authed(request)
    return await _search(q, count)


@app.post("/v1/search")
async def search_post(request: Request):
    _authed(request)
    try:
        body = await request.json()
    except Exception:
        body = {}
    return await _search(body.get("query", ""), body.get("count", 5))


# --- admin (auth required) -------------------------------------------------- #


@app.get("/admin/status")
def admin_status(request: Request):
    _authed(request)
    return {"llm_up": llm_reachable(), "model": LLM_ALIAS,
            "search": configured_chain(),
            "uptime_seconds": round(time.time() - STARTED_AT, 1)}


@app.post("/admin/start-llm")
def admin_start_llm(request: Request):
    _authed(request)
    ok = spawn_llm()
    return {"llm_up": ok}


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #


def main() -> None:
    print(f"[control-plane] starting on 0.0.0.0:{PORT}, LLM base {LLM_BASE_URL}", flush=True)
    print(f"[control-plane] auth: {'enabled' if CONTROL_KEY else 'DISABLED (no CONTROL_KEY)'}", flush=True)
    print(f"[control-plane] search chain: {', '.join(configured_chain())}", flush=True)
    if os.environ.get("START_LLM", "1") == "1":
        up = spawn_llm()
        print(f"[control-plane] LLM watchdog: {'up' if up else 'not started (will retry on first request)'}", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
