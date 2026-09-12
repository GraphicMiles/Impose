#!/usr/bin/env python3
"""Impose relay: the always-on layer in front of the GPU box (optional).

Same OpenAI-compatible surface as the box gateway (models, chat, search),
plus the two things that make free-tier self-hosting practical:

  WAKE-ON-CHAT  a request arriving while the box is down starts the Studio
                in the background and answers 503 "waking up, retry soon".
  IDLE AUTO-STOP  with no inference for IDLE_STOP_MINUTES, the Studio is
                stopped to save credits. The next chat wakes it again.

No cron jobs here (that is Luna's render-control-plane plus jobs; this relay
stays focused on proxy + wake + idle). Deploy to Render free tier via the
root render.yaml, or any host that runs uvicorn.

Env (Render dashboard, or .env for local):
  CONTROL_KEY        required: Bearer key browsers must present (its own key)
  LLM_GATEWAY_URL    required: the box gateway root, WITHOUT /v1
  LLM_GATEWAY_KEY    required: the box CONTROL_KEY
  ALLOWED_ORIGINS    default * (comma separated to tighten)
  PORT               default 8000
  WAKE_STUDIO        0|1: allow starting/stopping the GPU Studio
  WAKE_ON_CHAT       0|1: auto-wake when a request finds the box down
  IDLE_MONITOR       0|1: stop the Studio after idle
  IDLE_STOP_MINUTES  int: idle minutes before stopping (default 5)
  IDLE_CHECK_MINUTES int: how often the idle loop checks (default 5)
  LIGHTNING_API_KEY / LIGHTNING_USER_ID / LIGHTNING_USERNAME /
  LIGHTNING_STUDIO / LIGHTNING_TEAMSPACE / LIGHTNING_MACHINE (default T4)
"""
import hmac
import os
import threading
import time
from pathlib import Path

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse

BASE_DIR = Path(os.environ.get("CP_DIR", str(Path(__file__).resolve().parent)))
ENV_FILE = BASE_DIR / ".env"
if ENV_FILE.exists():
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))

CONTROL_KEY = os.environ.get("CONTROL_KEY", "")
GATEWAY_URL = os.environ.get("LLM_GATEWAY_URL", "").rstrip("/")
GATEWAY_KEY = os.environ.get("LLM_GATEWAY_KEY", "")
WAKE_STUDIO = os.environ.get("WAKE_STUDIO", "0") == "1"
WAKE_ON_CHAT = os.environ.get("WAKE_ON_CHAT", "1") == "1"
IDLE_MONITOR = os.environ.get("IDLE_MONITOR", "1") == "1"
IDLE_STOP_MINUTES = int(os.environ.get("IDLE_STOP_MINUTES", "5"))
IDLE_CHECK_MINUTES = int(os.environ.get("IDLE_CHECK_MINUTES", "5"))
PORT = int(os.environ.get("PORT", "8000"))
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",") if o.strip()]
RESTART_SCRIPT = os.environ.get("RESTART_SCRIPT", "bash ~/impose/backend/lightning/restart_all.sh")

if not CONTROL_KEY:
    print("[relay] WARNING: no CONTROL_KEY, auth disabled (dev only)", flush=True)

app = FastAPI(title="impose-relay")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
STARTED_AT = time.time()
_last_activity = STARTED_AT
_wake_lock = threading.Lock()
_waking = False

# --------------------------------------------------------------------------- #
# auth
# --------------------------------------------------------------------------- #


def _authed(request: Request) -> None:
    if not CONTROL_KEY:
        return
    supplied = request.headers.get("Authorization", "")
    if not hmac.compare_digest(supplied, "Bearer " + CONTROL_KEY):
        raise HTTPException(status_code=401, detail="invalid or missing API key")


def _gateway_headers() -> dict:
    headers = {"Content-Type": "application/json"}
    if GATEWAY_KEY:
        headers["Authorization"] = "Bearer " + GATEWAY_KEY
    return headers


# --------------------------------------------------------------------------- #
# gateway reachability + wake + idle
# --------------------------------------------------------------------------- #


def gateway_reachable() -> bool:
    """Whether the box gateway answers at all. Only a transport error (DNS,
    connect, timeout) means it is down; any HTTP answer proves it is up."""
    if not GATEWAY_URL:
        return False
    try:
        httpx.get(f"{GATEWAY_URL}/health", timeout=8.0)
        return True
    except Exception:
        return False


def touch_activity() -> None:
    global _last_activity
    _last_activity = time.time()


def idle_minutes() -> float:
    return (time.time() - _last_activity) / 60.0


def _lightning_teamspace() -> str:
    ts = os.environ.get("LIGHTNING_TEAMSPACE", "").strip()
    if "/" in ts:
        return ts
    owner = (os.environ.get("LIGHTNING_USERNAME")
             or os.environ.get("LIGHTNING_USER_ID") or "").strip()
    return f"{owner}/{ts}" if owner else ts


def _studio_running(studio) -> bool:
    try:
        return "running" in str(getattr(studio, "status", "")).lower()
    except Exception:
        return False


def stop_studio() -> bool:
    if not os.environ.get("LIGHTNING_API_KEY"):
        print("[idle] lightning creds incomplete, cannot stop studio", flush=True)
        return False
    try:
        from lightning_sdk import Studio
        studio = Studio(
            name=os.environ.get("LIGHTNING_STUDIO", ""),
            teamspace=_lightning_teamspace(),
        )
        if _studio_running(studio):
            print("[idle] stopping studio (idle)", flush=True)
            studio.stop()
            return True
        return False
    except Exception as e:
        print(f"[idle] stop error: {e!r}", flush=True)
        return False


def idle_monitor() -> dict:
    if not (IDLE_MONITOR and WAKE_STUDIO):
        return {"ok": True, "idle_minutes": round(idle_minutes(), 1), "acted": False}
    if idle_minutes() < IDLE_STOP_MINUTES:
        return {"ok": True, "idle_minutes": round(idle_minutes(), 1), "acted": False}
    if not gateway_reachable():
        return {"ok": True, "idle_minutes": round(idle_minutes(), 1), "acted": False,
                "note": "gateway already down"}
    stopped = stop_studio()
    return {"ok": True, "idle_minutes": round(idle_minutes(), 1), "acted": stopped,
            "stopped_studio": stopped}


def _idle_loop() -> None:
    while True:
        time.sleep(max(1, IDLE_CHECK_MINUTES) * 60)
        try:
            result = idle_monitor()
            if result.get("acted"):
                print(f"[idle] {result}", flush=True)
        except Exception as e:
            print(f"[idle] loop error: {e!r}", flush=True)


def wake_studio() -> bool:
    """Wake the whole chain, at most once at a time."""
    global _waking
    with _wake_lock:
        if _waking:
            print("[wake] already waking, skipping duplicate", flush=True)
            return gateway_reachable()
        _waking = True
    try:
        return _wake_studio_once()
    finally:
        with _wake_lock:
            _waking = False


def _wake_studio_once() -> bool:
    """1. Start the Studio if stopped. 2. Wait for Running. 3. Run the
    in-studio restart script (relaunches the gateway, whose watchdog spawns
    llama-server). 4. Poll the gateway until it answers."""
    if not os.environ.get("LIGHTNING_API_KEY"):
        print("[wake] lightning creds incomplete, set LIGHTNING_API_KEY", flush=True)
        return False
    try:
        from lightning_sdk import Studio, Machine
        machine = getattr(Machine, os.environ.get("LIGHTNING_MACHINE", "T4"), Machine.T4)
        studio = Studio(
            name=os.environ.get("LIGHTNING_STUDIO", ""),
            teamspace=_lightning_teamspace(),
        )
        status = str(getattr(studio, "status", "")).lower()
        if status in ("", "none", "stopped"):
            print(f"[wake] starting studio on {machine.slug} ...", flush=True)
            studio.start(machine=machine)
        for _ in range(30):  # up to ~5 min
            if _studio_running(studio) or gateway_reachable():
                break
            time.sleep(10)
        if not (_studio_running(studio) or gateway_reachable()):
            print("[wake] studio did not reach Running in time", flush=True)
            return gateway_reachable()
        try:
            studio.run(RESTART_SCRIPT)
            print("[wake] in-studio restart script executed", flush=True)
        except Exception as e:
            print(f"[wake] restart script error: {e!r}", flush=True)
        for _ in range(60):  # up to ~10 min
            if gateway_reachable():
                print("[wake] gateway reachable", flush=True)
                return True
            time.sleep(10)
        return gateway_reachable()
    except Exception as e:
        print(f"[wake] wake error: {e!r}", flush=True)
        return False


def _wake_in_background() -> None:
    threading.Thread(target=wake_studio, daemon=True).start()


def _need_wake() -> None:
    """Raise the waking 503 (and kick a background wake) when the box is down."""
    if WAKE_ON_CHAT and WAKE_STUDIO:
        _wake_in_background()
        raise HTTPException(status_code=503,
                            detail="model is waking up. Retry in a moment (usually 1-3 min)")
    raise HTTPException(status_code=503, detail="upstream LLM is down")


# --------------------------------------------------------------------------- #
# routes
# --------------------------------------------------------------------------- #


@app.get("/health")
def health():
    return {"ok": True, "service": "impose-relay",
            "gateway_up": gateway_reachable(),
            "uptime_seconds": round(time.time() - STARTED_AT, 1)}


@app.get("/v1/models")
def models(request: Request):
    _authed(request)
    if not gateway_reachable():
        _need_wake()
    touch_activity()
    headers = {}
    if GATEWAY_KEY:
        headers["Authorization"] = "Bearer " + GATEWAY_KEY
    r = httpx.get(f"{GATEWAY_URL}/v1/models", headers=headers, timeout=30.0)
    return Response(content=r.content, media_type="application/json", status_code=r.status_code)


@app.post("/v1/chat/completions")
async def chat(request: Request):
    _authed(request)
    body = await request.json()
    if not gateway_reachable():
        _need_wake()
    touch_activity()
    req = httpx.Request("POST", f"{GATEWAY_URL}/v1/chat/completions",
                        headers=_gateway_headers(), json=body)
    client = httpx.AsyncClient(timeout=None)
    try:
        resp = await client.send(req, stream=True)
    except Exception:
        await client.aclose()
        raise HTTPException(status_code=502, detail="upstream LLM is down")
    if body.get("stream"):
        async def sse():
            try:
                async for chunk in resp.aiter_bytes():
                    yield chunk
            finally:
                await client.aclose()
        out_headers = {k: v for k, v in resp.headers.items()
                       if k.lower() in ("content-type", "cache-control")}
        return StreamingResponse(sse(), status_code=resp.status_code, headers=out_headers)
    content = await resp.aread()
    await client.aclose()
    return Response(content=content,
                    media_type=resp.headers.get("content-type", "application/json"),
                    status_code=resp.status_code)


@app.api_route("/v1/search", methods=["GET", "POST"])
async def search_proxy(request: Request):
    _authed(request)
    if not gateway_reachable():
        _need_wake()
    touch_activity()
    url = f"{GATEWAY_URL}/v1/search"
    if request.url.query:
        url += "?" + request.url.query
    body = await request.body() if request.method == "POST" else None
    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            r = await client.request(request.method, url,
                                     headers=_gateway_headers(), content=body)
    except Exception:
        raise HTTPException(status_code=502, detail="upstream LLM is down")
    return Response(content=r.content,
                    media_type=r.headers.get("content-type", "application/json"),
                    status_code=r.status_code)


@app.get("/admin/status")
def admin_status(request: Request):
    _authed(request)
    return {"gateway_up": gateway_reachable(),
            "idle_minutes": round(idle_minutes(), 1),
            "idle_stop_minutes": IDLE_STOP_MINUTES,
            "idle_monitor": IDLE_MONITOR,
            "wake_on_chat": WAKE_ON_CHAT,
            "wake_studio": WAKE_STUDIO,
            "uptime_seconds": round(time.time() - STARTED_AT, 1)}


@app.post("/admin/wake-llm")
def admin_wake(request: Request, background: bool = False):
    """Wake the LLM chain on demand. Safe to call anytime. With
    `?background=1` it returns immediately and the wake continues server-side."""
    _authed(request)
    if gateway_reachable():
        return {"llm_up": True, "woke": False}
    if WAKE_STUDIO:
        if background:
            _wake_in_background()
            return {"llm_up": False, "woke": True, "state": "waking"}
        ok = wake_studio()
        return {"llm_up": ok, "woke": ok}
    return {"llm_up": False, "woke": False,
            "note": "gateway is down and WAKE_STUDIO is disabled. Set WAKE_STUDIO=1 "
                    "and provide LIGHTNING_* credentials to auto-wake."}


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #


def main() -> None:
    print(f"[relay] starting on 0.0.0.0:{PORT}", flush=True)
    print(f"[relay] gateway: {GATEWAY_URL or 'UNSET'} | "
          f"auth: {'enabled' if CONTROL_KEY else 'DISABLED'} | wake_studio: {WAKE_STUDIO}", flush=True)
    if IDLE_MONITOR:
        threading.Thread(target=_idle_loop, daemon=True).start()
        print(f"[relay] idle monitor every {IDLE_CHECK_MINUTES}m "
              f"(stop GPU after {IDLE_STOP_MINUTES}m idle)", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
