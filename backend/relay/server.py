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
import asyncio
import base64
import hmac
import hashlib
import ipaddress
import io
import json
import os
import re
import secrets
import socket
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import quote, unquote, urljoin, urlparse, urlunparse

import httpx
import uvicorn
from PIL import Image, UnidentifiedImageError
try:
    import cairosvg
except ImportError:  # dependency is installed by backend/requirements.txt in production
    cairosvg = None
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from relay.search import SearchFailed, engine_search
from relay.images import ImagesFailed, engine_images
from relay.videos import VideosFailed, engine_videos
from relay.files import discover_files
from relay import otp_store
from relay import reports_store
from relay import supabase_admin
from relay.mailer import MailFailed, send_code, configured as mailer_configured, probe as mailer_probe
from relay.source_intelligence import CATALOG

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

_lifecycle_lock = threading.Lock()
_lifecycle_started = False


@asynccontextmanager
async def _lifespan(_app):
    """Start background work whether launched with ``python`` or uvicorn.

    Render imports ``relay.server:app`` directly, so setup hidden only in
    main() never ran there. Keep this hook idempotent for tests and reloads.
    """
    global _lifecycle_started
    with _lifecycle_lock:
        if not _lifecycle_started:
            _lifecycle_started = True
            print(f"[relay] gateway: {GATEWAY_URL or 'UNSET'} | "
                  f"auth: {'enabled' if CONTROL_KEY else 'DISABLED'} | "
                  f"wake_studio: {WAKE_STUDIO}", flush=True)

            # Accounts need three things and silently refuse without them.
            # A user found this by filling in a signup form and getting
            # "accounts are not configured on the server", which is a
            # deployment gap discovered in the worst possible place. Say it
            # at boot, in the logs, where it is cheap to notice and name
            # exactly which variable is missing.
            missing = [name for name in
                       ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "OTP_PEPPER")
                       if not os.environ.get(name, "").strip()]
            if missing:
                print("[relay] ACCOUNTS DISABLED, missing: " + ", ".join(missing) +
                      " -- signup, sign-in and password reset will answer 503"
                      " until these are set.", flush=True)
            elif not (os.environ.get("SENDLIB_API_KEY", "").strip()
                      and os.environ.get("SENDLIB_FROM", "").strip()):
                # Both are needed together; one alone falls back to console
                # mode, which looks like it works and emails nobody.
                print("[relay] accounts ON, but SENDLIB_API_KEY/SENDLIB_FROM are"
                      " incomplete: codes will be printed to this log, not"
                      " emailed.", flush=True)
            else:
                print("[relay] accounts: ready", flush=True)
            if IDLE_MONITOR and WAKE_STUDIO:
                threading.Thread(target=_idle_loop, daemon=True).start()
                print(f"[relay] idle monitor every {IDLE_CHECK_MINUTES}m "
                      f"(stop GPU after {IDLE_STOP_MINUTES}m idle)", flush=True)
    yield


app = FastAPI(title="impose-relay", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _correlate(request: Request, call_next):
    """Carry the browser's request id through the log and back in the reply.

    A browser log line and a relay log line describing the same request
    previously had nothing in common, so matching them meant comparing
    timestamps by eye across two systems. Three of the recent signup
    outages were diagnosed that way and it was slow every time.

    Only the account endpoints are logged. Logging every request would
    bury the ones that matter under feed traffic, and these are the ones
    that fail in ways the browser cannot see.
    """
    # The id travels back into a response header and into the log, so it is
    # stripped of control characters first: an echoed request header is a
    # classic injection point, and a log line is a spoofable one.
    rid = re.sub(r"[\x00-\x1f\x7f]+", "", request.headers.get("X-Request-Id", ""))[:64]
    started = time.time()
    response = await call_next(request)
    if rid and request.url.path.startswith("/v1/auth/"):
        ms = int((time.time() - started) * 1000)
        print(f"[req] {rid} {request.method} {request.url.path} "
              f"-> {response.status_code} ({ms}ms)", flush=True)
    if rid:
        response.headers["X-Request-Id"] = rid
    return response


STARTED_AT = time.time()
_last_activity = STARTED_AT
_wake_lock = threading.Lock()
_waking = False

# Gateway state is a cache, not a question we ask the network on every
# request: an 8 second health round trip per chat completion made every
# message slower and stampeded the box under load. Transport errors mark it
# down at once; any successful probe marks it up.
_GW_TTL = 10.0
_gateway_state = {"up": None, "llm_up": None, "at": 0.0,
                  "status": None, "error": None}
_state_lock = threading.Lock()

# --- auth + proxy rate limiting (per client IP, in memory) ---
_RATE_BUCKETS = {}
_rate_lock = threading.Lock()
_rate_pruned_at = 0.0


def _client_ip(request: Request) -> str:
    """The address to hold limits against.

    Behind a terminating proxy (Render) request.client.host is the load
    balancer, so every caller on earth shares one bucket and per-IP limits
    become one global limit that a single abuser spends. The proxy appends
    the hop it saw to X-Forwarded-For, so the RIGHTMOST parseable entry is
    the one the infrastructure added: a client that prepends its own fake
    value cannot move what we read. No usable header falls back to the
    socket address, which keeps direct deployments honest.
    """
    fwd = request.headers.get("x-forwarded-for", "")
    for part in reversed([p.strip() for p in fwd.split(",") if p.strip()]):
        try:
            ipaddress.ip_address(part)
            return part
        except ValueError:
            continue
    try:
        return request.client.host if request.client else "?"
    except Exception:
        return "?"


def _rate_prune(now: float) -> None:
    """Drop buckets quiet for an hour. Called under _rate_lock, throttled
    to once a minute: the dict otherwise grows forever, one key per
    address and email ever seen, which is a slow leak no traffic pattern
    ever empties."""
    global _rate_pruned_at
    if now - _rate_pruned_at < 60.0:
        return
    _rate_pruned_at = now
    cutoff = now - 3600.0
    stale = [key for key, events in _RATE_BUCKETS.items()
             if not events or events[-1] < cutoff]
    for key in stale:
        _RATE_BUCKETS.pop(key, None)


def _rate_hit(bucket: str, key: str, limit: int, window: float) -> bool:
    """Record one event; True when the caller is over the limit."""
    now = time.time()
    with _rate_lock:
        _rate_prune(now)
        events = _RATE_BUCKETS.setdefault(f"{bucket}:{key}", [])
        cutoff = now - window
        while events and events[0] < cutoff:
            events.pop(0)
        events.append(now)
        return len(events) > limit


_CACHE = {}  # (kind, key) -> (expires_at_epoch, value); a small TTL memo so
             # repeats and regenerates skip the wobbly upstream engines
_cache_lock = threading.Lock()


def _cache_get(kind: str, key: str):
    with _cache_lock:
        hit = _CACHE.get((kind, key))
        if not hit:
            return None
        expires, value = hit
        if expires < time.time():
            _CACHE.pop((kind, key), None)
            return None
        return value


def _cache_put(kind: str, key: str, value, ttl: float):
    with _cache_lock:
        if len(_CACHE) > 256:
            for stale, _ in sorted(_CACHE.items(), key=lambda kv: kv[1][0])[:64]:
                _CACHE.pop(stale, None)
        _CACHE[(kind, key)] = (time.time() + ttl, value)


def _rate_over(bucket: str, key: str, limit: int, window: float) -> bool:
    now = time.time()
    with _rate_lock:
        events = _RATE_BUCKETS.get(f"{bucket}:{key}", [])
        cutoff = now - window
        while events and events[0] < cutoff:
            events.pop(0)
        return len(events) > limit

# --------------------------------------------------------------------------- #
# auth
# --------------------------------------------------------------------------- #


def _authed(request: Request) -> None:
    if not CONTROL_KEY:
        return
    ip = _client_ip(request)
    # Constant time compare is necessary, not sufficient: without a failure
    # budget the key can be brute forced one guess at a time, forever.
    if _rate_over("authfail", ip, 15, 60.0):
        raise HTTPException(status_code=429, detail="too many attempts; wait a minute")
    supplied = request.headers.get("Authorization", "")
    if not hmac.compare_digest(supplied, "Bearer " + CONTROL_KEY):
        _rate_hit("authfail", ip, 15, 60.0)
        raise HTTPException(status_code=401, detail="invalid or missing API key")


# Public demo tier: the keyless read-only surface for site visitors. Search
# and image search only, tight per-IP limits, and every expensive or
# dangerous endpoint (chat proxy, page reader, fetch proxy, admin) stays
# behind the control key. PUBLIC_TIER=0 turns the whole thing off.
PUBLIC_TIER = os.environ.get("PUBLIC_TIER", "1").strip().lower() not in ("0", "false", "no")
PUB_SEARCH_LIMIT = int(os.environ.get("PUB_SEARCH_LIMIT", "10"))
PUB_IMAGES_LIMIT = int(os.environ.get("PUB_IMAGES_LIMIT", "10"))
PUB_VIDEO_LIMIT = int(os.environ.get("PUB_VIDEO_LIMIT", "10"))
PUB_FILES_LIMIT = int(os.environ.get("PUB_FILES_LIMIT", "10"))
PUB_FILE_BYTES_LIMIT = int(os.environ.get("PUB_FILE_BYTES_LIMIT", "20"))
PUB_WINDOW = 60.0


def _is_owner(request: Request) -> bool:
    """True when the request carries the control key. Never raises."""
    if not CONTROL_KEY:
        return True
    supplied = request.headers.get("Authorization", "")
    return hmac.compare_digest(supplied, "Bearer " + CONTROL_KEY)


def _tier_auth(request: Request, owner_bucket: str, pub_bucket: str,
               owner_limit: int, pub_limit: int) -> None:
    """Owner key: the normal bucket and limit. Anyone else: the public tier,
    if it is on, with the tight bucket. A wrong key is treated as public on
    purpose: guessing at the search endpoints wins nothing."""
    ip = _client_ip(request)
    if _is_owner(request):
        if _rate_hit(owner_bucket, ip, owner_limit, PUB_WINDOW):
            raise HTTPException(status_code=429, detail="rate limit reached; wait a minute")
        return
    if not PUBLIC_TIER:
        raise HTTPException(status_code=401, detail="invalid or missing API key")
    if _rate_hit(pub_bucket, ip, pub_limit, PUB_WINDOW):
        raise HTTPException(status_code=429, detail="public search limit reached; wait a minute")


def _bounded_mapping(value, *, keys=24, chars=12000):
    """Accept common semantic-planner JSON shapes without exposing an
    unbounded provider input surface."""
    if isinstance(value, str):
        try: value = json.loads(value)
        except Exception: return {}
    if not isinstance(value, dict): return {}
    out = {str(key)[:80]: item for key, item in list(value.items())[:keys]}
    try: return out if len(json.dumps(out)) <= chars else {}
    except Exception: return {}


def _bounded_strings(value, *, limit=8, width=80):
    if isinstance(value, str): value = value.split(",")
    if not isinstance(value, (list, tuple, set)): return []
    return [str(item).strip()[:width] for item in list(value)[:limit] if str(item).strip()]


def _semantic_bool(value):
    if isinstance(value, bool): return value
    if isinstance(value, (int, float)): return bool(value)
    if isinstance(value, str) and value.strip().lower() in {"true", "yes", "1"}: return True
    if isinstance(value, str) and value.strip().lower() in {"false", "no", "0", ""}: return False
    return None


def _gateway_headers() -> dict:
    headers = {"Content-Type": "application/json"}
    if GATEWAY_KEY:
        headers["Authorization"] = "Bearer " + GATEWAY_KEY
    return headers


# --------------------------------------------------------------------------- #
# gateway reachability + wake + idle
# --------------------------------------------------------------------------- #


def _wake_missing() -> list[str]:
    """Configuration fields needed before the relay can control a Studio."""
    missing = []
    for key in ("LIGHTNING_API_KEY", "LIGHTNING_STUDIO", "LIGHTNING_TEAMSPACE"):
        if not os.environ.get(key, "").strip():
            missing.append(key)
    return missing


def _gateway_snapshot() -> dict:
    with _state_lock:
        return dict(_gateway_state)


def gateway_reachable(force: bool = False) -> bool:
    """Whether the real box gateway health endpoint answers correctly.

    A CDN error page or an unrelated HTTP service is not a healthy gateway.
    Cache probes briefly so concurrent chat requests do not stampede the box.
    """
    if not GATEWAY_URL:
        with _state_lock:
            _gateway_state.update(up=False, llm_up=None, at=time.time(),
                                  status=None, error="LLM_GATEWAY_URL is not set")
        return False
    now = time.time()
    with _state_lock:
        if (not force and _gateway_state["up"] is not None
                and now - _gateway_state["at"] < _GW_TTL):
            return bool(_gateway_state["up"])
    up = False
    llm_up = None
    status = None
    error = None
    try:
        response = httpx.get(f"{GATEWAY_URL}/health", timeout=8.0)
        status = response.status_code
        if response.status_code != 200:
            error = f"gateway health returned HTTP {response.status_code}"
        else:
            try:
                data = response.json()
            except Exception:
                data = None
            if isinstance(data, dict) and data.get("ok") is True and data.get("service") == "impose-control-plane":
                up = True
                llm_up = data.get("llm_up") if isinstance(data.get("llm_up"), bool) else None
            else:
                error = "gateway health returned an unexpected response"
    except Exception as exc:
        error = f"{type(exc).__name__}: {str(exc)[:180]}"
    with _state_lock:
        _gateway_state.update(up=up, llm_up=llm_up, at=time.time(),
                              status=status, error=error)
    return up


def mark_gateway_down() -> None:
    with _state_lock:
        _gateway_state.update(up=False, llm_up=None, at=time.time(),
                              error="gateway proxy request failed")


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
    missing = _wake_missing()
    if missing:
        print("[wake] Lightning configuration incomplete: " + ", ".join(missing), flush=True)
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


def _start_gateway_llm() -> bool:
    """Ask an already-running box gateway to start its local model."""
    try:
        response = httpx.post(f"{GATEWAY_URL}/admin/start-llm",
                              headers=_gateway_headers(), timeout=90.0)
        data = response.json() if response.status_code == 200 else {}
        ok = data.get("llm_up") is True
    except Exception as exc:
        print(f"[wake] model start through gateway failed: {exc!r}", flush=True)
        ok = False
    with _state_lock:
        _gateway_state["llm_up"] = ok
        _gateway_state["at"] = time.time()
    return ok


def _start_gateway_llm_in_background() -> None:
    threading.Thread(target=_start_gateway_llm, daemon=True).start()


def _need_wake() -> None:
    """Raise the waking 503 (and kick a background wake) when the box is down."""
    if WAKE_ON_CHAT and WAKE_STUDIO:
        missing = _wake_missing()
        if missing:
            raise HTTPException(status_code=503,
                                detail="automatic wake is not configured: " + ", ".join(missing))
        _wake_in_background()
        raise HTTPException(status_code=503,
                            detail="model is waking up. Retry in a moment (usually 1-3 min)")
    if not WAKE_STUDIO:
        raise HTTPException(status_code=503,
                            detail="upstream LLM is down and automatic Studio wake is disabled")
    raise HTTPException(status_code=503,
                        detail="upstream LLM is down and wake on chat is disabled")


# --------------------------------------------------------------------------- #
# routes
# --------------------------------------------------------------------------- #


@app.get("/health")
def health():
    """Report liveness without waiting on the optional LLM gateway.

    Health contains no private data and is readable from every origin. This
    lets the portable/local app distinguish a live relay from a browser CORS
    failure while protected relay routes keep the configured origin policy.
    """
    snap = _gateway_snapshot()
    return JSONResponse(
        {"ok": True, "service": "impose-relay",
         "gateway_up": snap.get("up") is True,
         "uptime_seconds": round(time.time() - STARTED_AT, 1)},
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"},
    )


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
    raw = await request.body()
    if len(raw) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="request body too large (max 10MB)")
    try:
        body = json.loads(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")
    if not gateway_reachable():
        _need_wake()
    touch_activity()
    req = httpx.Request("POST", f"{GATEWAY_URL}/v1/chat/completions",
                        headers=_gateway_headers(), json=body)
    timeout = httpx.Timeout(timeout=None, connect=15.0, read=70.0, write=30.0, pool=15.0)
    client = httpx.AsyncClient(timeout=timeout)
    try:
        resp = await client.send(req, stream=True)
    except asyncio.CancelledError:
        await client.aclose()
        raise
    except httpx.TimeoutException:
        await client.aclose()
        mark_gateway_down()
        raise HTTPException(status_code=504, detail="upstream LLM timed out")
    except Exception:
        await client.aclose()
        mark_gateway_down()
        raise HTTPException(status_code=502, detail="upstream LLM is down")
    if body.get("stream"):
        # A stream that ends without [DONE] is a dead upstream, not a
        # finished answer. Say so on the wire; the client flags the message.
        saw_done = False
        tail = b""

        async def sse():
            nonlocal saw_done, tail
            try:
                async for chunk in resp.aiter_bytes():
                    scan = tail + chunk
                    if b"[DONE]" in scan:
                        saw_done = True
                    tail = scan[-8:]
                    yield chunk
            finally:
                await client.aclose()
            if resp.status_code == 200 and not saw_done:
                print("[relay] upstream stream ended without [DONE]", flush=True)
                yield b"\n: impose: upstream stream ended early\n\n"
                yield b'data: {"error":{"message":"upstream stream ended before completion",'
                yield b'"type":"impose_truncated_stream"}}\n\n'
        out_headers = {k: v for k, v in resp.headers.items()
                       if k.lower() in ("content-type", "cache-control")}
        return StreamingResponse(sse(), status_code=resp.status_code, headers=out_headers)
    content = await resp.aread()
    await client.aclose()
    return Response(content=content,
                    media_type=resp.headers.get("content-type", "application/json"),
                    status_code=resp.status_code)


@app.get("/v1/source/catalog")
async def source_catalog(request: Request):
    """Explainable read-only provider catalog and observed performance."""
    _tier_auth(request, "sourcecatalog", "pubsourcecatalog", 60, PUB_SEARCH_LIMIT)
    performance = CATALOG.ledger.snapshot()
    return {"version": CATALOG.version, "providers": [{
        "id": provider.id, "mechanism": provider.mechanism,
        "sourceClasses": sorted(provider.source_classes), "artifactTypes": sorted(provider.artifact_types),
        "formats": sorted(provider.formats), "capabilities": sorted(provider.capabilities),
        "domains": sorted(provider.domains), "metrics": dict(provider.metrics), "discovered": provider.discovered,
        "performance": performance.get(provider.id)
    } for provider in CATALOG.providers() if not provider.discovered]}


@app.api_route("/v1/search", methods=["GET", "POST"])
async def search_proxy(request: Request):
    """Web search for the agent (SearXNG, Bing HTML, DDG HTML). Owners get
    the normal key and limits; visitors get the public tier."""
    _tier_auth(request, "search", "pubsearch", 60, PUB_SEARCH_LIMIT)
    if request.method == "POST":
        try:
            data = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="body must be JSON")
        query = str(data.get("query", ""))
        limit = data.get("limit", 8)
        domains = data.get("domains")
        freshness = data.get("freshness")
        language = data.get("language", "en")
        region = data.get("region")
        requirements = data.get("requirements") or {}
    else:
        q = request.query_params
        query = str(q.get("query", "") or q.get("q", ""))
        limit = q.get("limit", 8)
        raw_domains = q.get("domains")
        domains = raw_domains.split(",") if raw_domains else None
        freshness = q.get("freshness")
        language = q.get("language", "en")
        region = q.get("region")
        requirements = {}
    query = query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    if len(query) > 500:
        raise HTTPException(status_code=400, detail="query is too long (max 500 chars)")
    try:
        limit = max(1, min(20, int(limit)))
    except Exception:
        raise HTTPException(status_code=400, detail="limit must be 1..20")
    domains = [domain.lower() for domain in _bounded_strings(domains, limit=12, width=253)]
    requirements = _bounded_mapping(requirements)
    ckey = "|".join([
        query.lower(), str(limit), ",".join(sorted(domains)),
        str(freshness or "").lower(), str(language or "en").lower(),
        str(region or "").lower(), json.dumps(requirements, sort_keys=True),
    ])
    cached = _cache_get("search", ckey)
    if cached is not None:
        return cached
    try:
        search_options = {"limit": limit, "domains": domains, "freshness": freshness,
                          "language": str(language or "en"), "region": region}
        if requirements: search_options["requirements"] = requirements
        out = await engine_search(query, **search_options)
    except SearchFailed as e:
        raise HTTPException(status_code=502, detail=str(e))
    _cache_put("search", ckey, out, 120.0)
    return out


_IMAGE_VERIFY_CAP = 8 * 1024 * 1024
_image_conversion_key = (CONTROL_KEY.encode("utf-8") if CONTROL_KEY else secrets.token_bytes(32))


def _conversion_signature(source: str) -> str:
    return hmac.new(_image_conversion_key, source.encode("utf-8"), hashlib.sha256).hexdigest()


@app.get("/v1/image-convert")
async def image_convert(request: Request, source: str, sig: str):
    _tier_auth(request, "imageconvert", "pubimageconvert", 120, 60)
    if not source or not hmac.compare_digest(sig, _conversion_signature(source)):
        raise HTTPException(status_code=403, detail="invalid artifact signature")
    if cairosvg is None:
        raise HTTPException(status_code=503, detail="image converter unavailable")
    content, ctype, _ = await _safe_file_bytes(source, cap=2 * 1024 * 1024)
    if ctype not in ("image/svg+xml", "text/xml", "application/xml"):
        raise HTTPException(status_code=415, detail="source is not a verified SVG image")
    try:
        png = await asyncio.to_thread(cairosvg.svg2png, bytestring=content, output_width=1024)
    except Exception:
        raise HTTPException(status_code=422, detail="SVG conversion failed")
    if len(png) > _IMAGE_VERIFY_CAP:
        raise HTTPException(status_code=413, detail="converted image exceeds relay limit")
    return Response(png, media_type="image/png", headers={
        "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff"})


async def _verify_image_constraints(rows: list, requirements: dict, artifact_base_url: str = "") -> tuple[list, list]:
    """Verify requested binary properties from bytes, not titles or URLs."""
    formats = requirements.get("formats") or requirements.get("format") or []
    if isinstance(formats, str): formats = [formats]
    formats = {str(value).lower().lstrip(".") for value in formats}
    if "jpg" in formats: formats.add("jpeg")
    characteristics = requirements.get("characteristics") or []
    if isinstance(characteristics, str): characteristics = [characteristics]
    characteristics = {str(value).lower().replace("-", "_").replace(" ", "_") for value in characteristics}
    needs_transparency = bool(characteristics & {"transparent", "transparency", "transparent_background", "no_background", "alpha_channel"})
    if not formats and not needs_transparency:
        return rows, []

    async def inspect(row):
        try:
            content, ctype, _ = await _safe_file_bytes(str(row.get("image") or ""), cap=_IMAGE_VERIFY_CAP)
            converted_from = None
            if formats and "png" in formats and ctype in ("image/svg+xml", "text/xml", "application/xml"):
                if cairosvg is None:
                    return None, "SVG-to-PNG converter is unavailable"
                content = await asyncio.to_thread(cairosvg.svg2png, bytestring=content, output_width=1024)
                if len(content) > _IMAGE_VERIFY_CAP:
                    return None, "converted image exceeds verification limit"
                ctype, converted_from = "image/png", "svg"
            if not ctype.startswith("image/"):
                return None, "host returned " + ctype
            with Image.open(io.BytesIO(content)) as image:
                image_format = (image.format or "").lower()
                image_format = "jpeg" if image_format == "jpg" else image_format
                width, height = image.size
                if width * height > 40_000_000:
                    return None, "image dimensions exceed verification limit"
                if formats and image_format not in formats:
                    return None, "decoded format did not match request"
                transparent = False
                if needs_transparency:
                    if image.mode in ("RGBA", "LA"):
                        transparent = image.getchannel("A").getextrema()[0] < 255
                    elif "transparency" in image.info:
                        transparent = True
                    if not transparent:
                        return None, "decoded image has no transparent pixels"
                clean = dict(row)
                claims = (["format"] if formats else []) + (["transparent_background"] if needs_transparency else [])
                if converted_from:
                    source_url = str(row.get("image") or "")
                    clean["image"] = (artifact_base_url.rstrip("/") + "/v1/image-convert?source=" +
                                      quote(source_url, safe="") + "&sig=" + _conversion_signature(source_url))
                    clean["thumb"] = clean["image"]
                    clean["transformedFrom"] = converted_from
                    claims.append("converted_to_png")
                clean.update({"format": image_format, "w": width, "h": height,
                              "byteSize": len(content), "verifiedClaims": sorted(claims)})
                return clean, None
        except (HTTPException, UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError) as exc:
            return None, str(getattr(exc, "detail", None) or exc)[:120]

    inspected = await asyncio.gather(*(inspect(row) for row in rows[:8]))
    verified, rejected = [], []
    for row, (clean, reason) in zip(rows[:8], inspected):
        if clean: verified.append(clean)
        else: rejected.append({"title": str(row.get("title") or "image")[:120], "reason": reason})
    return verified, rejected


@app.api_route("/v1/images", methods=["GET", "POST"])
async def images_proxy(request: Request):
    """Image search for the agent (Bing Images, DDG Images, Openverse).
    Owners get the normal key and limits; visitors get the public tier."""
    _tier_auth(request, "images", "pubimages", 60, PUB_IMAGES_LIMIT)
    if request.method == "POST":
        try:
            data = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="body must be JSON")
        query = str(data.get("query", ""))
        limit = data.get("limit", 8)
        requirements = data.get("requirements") or {}
    else:
        q = request.query_params
        query = str(q.get("query", "") or q.get("q", ""))
        limit = q.get("limit", 8)
        requirements = {}
    query = query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    if len(query) > 500:
        raise HTTPException(status_code=400, detail="query is too long (max 500 chars)")
    try:
        limit = max(1, min(20, int(limit)))
    except Exception:
        raise HTTPException(status_code=400, detail="limit must be 1..20")
    requirements = _bounded_mapping(requirements)
    ckey = query.lower() + "|" + str(limit) + "|" + json.dumps(requirements, sort_keys=True)
    cached = _cache_get("images", ckey)
    if cached is not None:
        return cached
    try:
        out = await engine_images(query, limit=limit, requirements=requirements)
        verified, rejected = await _verify_image_constraints(out.get("results") or [], requirements,
                                                               str(request.base_url).rstrip("/"))
        if requirements and not verified:
            raise ImagesFailed("candidate images failed binary artifact verification")
        if requirements:
            out["results"], out["count"] = verified, len(verified)
            plan = out.get("sourcePlan") or {}
            evaluation = plan.get("resultEvaluation") or {}
            evaluation.update({"binaryVerified": len(verified), "binaryRejected": rejected,
                               "transformedArtifacts": sum(1 for row in verified if row.get("transformedFrom")),
                               "constraintsSatisfied": bool(verified)})
            plan["resultEvaluation"] = evaluation
            out["sourcePlan"] = plan
    except ImagesFailed as e:
        raise HTTPException(status_code=502, detail=str(e))
    _cache_put("images", ckey, out, 180.0)
    return out


@app.api_route("/v1/videos", methods=["GET", "POST"])
async def videos_proxy(request: Request):
    """Verified YouTube and Twitch results for click-to-play media cards."""
    _tier_auth(request, "videos", "pubvideos", 60, PUB_VIDEO_LIMIT)
    if request.method == "POST":
        try:
            data = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="body must be JSON")
        query = str(data.get("query", ""))
        limit = data.get("limit", 6)
        raw_constraints = _bounded_mapping(data.get("constraints", {}), keys=12, chars=3000)
        constraints = {
            key: raw_constraints[key] for key in ("live", "latest", "creator", "subject", "platforms")
            if key in raw_constraints
        }
    else:
        q = request.query_params
        query = str(q.get("query", "") or q.get("q", ""))
        limit = q.get("limit", 6)
        constraints = {}
    for flag in ("live", "latest"):
        if flag in constraints:
            normalized = _semantic_bool(constraints[flag])
            if normalized is None: constraints.pop(flag, None)
            else: constraints[flag] = normalized
    for field in ("subject", "creator"):
        if field in constraints: constraints[field] = str(constraints[field])[:500]
    if "platforms" in constraints: constraints["platforms"] = _bounded_strings(constraints["platforms"], limit=2)
    query = query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    if len(query) > 500:
        raise HTTPException(status_code=400, detail="query is too long (max 500 chars)")
    try:
        limit = max(1, min(10, int(limit)))
    except Exception:
        raise HTTPException(status_code=400, detail="limit must be 1..10")
    ckey = query.lower() + "|" + str(limit) + "|" + json.dumps(constraints, sort_keys=True)
    cached = _cache_get("videos", ckey)
    if cached is not None:
        return cached
    try:
        out = await engine_videos(query, limit=limit, constraints=constraints)
    except VideosFailed as e:
        raise HTTPException(status_code=502, detail=str(e))
    _cache_put("videos", ckey, out, 120.0)
    return out


@app.api_route("/v1/files", methods=["GET", "POST"])
async def files_proxy(request: Request):
    """Discover typed remote artifacts and canonical source/download URLs."""
    _tier_auth(request, "files", "pubfiles", 40, PUB_FILES_LIMIT)
    if request.method == "POST":
        try:
            data = await request.json()
        except Exception:
            raise HTTPException(status_code=400, detail="body must be JSON")
    else:
        q = request.query_params
        data = {"query": q.get("query", "") or q.get("q", ""), "limit": q.get("limit", 8),
                "extensions": q.get("extensions", "").split(",") if q.get("extensions") else [],
                "platforms": q.get("platforms", "").split(",") if q.get("platforms") else []}
    query = str(data.get("query", "")).strip()
    if not query or len(query) > 500:
        raise HTTPException(status_code=400, detail="query is required and must be at most 500 chars")
    extensions = _bounded_strings(data.get("extensions"))
    platforms = _bounded_strings(data.get("platforms"))
    requirements = _bounded_mapping(data.get("requirements"))
    try:
        limit = max(1, min(12, int(data.get("limit", 8))))
    except Exception:
        raise HTTPException(status_code=400, detail="limit must be 1..12")
    ckey = query.lower() + "|" + str(limit) + "|" + json.dumps([extensions, platforms, requirements], sort_keys=True)
    cached = _cache_get("files", ckey)
    if cached is not None:
        return cached
    try:
        out = await discover_files(query, limit, extensions, platforms, requirements)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    _cache_put("files", ckey, out, 120.0)
    return out


# --------------------------------------------------------------------------- #
# generic fetch proxy: lets browsers reach providers that block them.
# Browsers call this; the relay calls the target server to server.
# --------------------------------------------------------------------------- #

_SSRF_BLOCKS = [ipaddress.ip_network(c) for c in (
    "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
    "169.254.0.0/16", "0.0.0.0/8", "::1/128", "fc00::/7", "fe80::/10")]

_FETCH_BODY_CAP = 8 * 1024 * 1024


def _resolve_public_ips(host: str) -> list:
    """Resolve a target only when *every* answer is globally routable.

    Accepting one public answer beside a private answer leaves mixed-DNS and
    rebinding routes to the internal network. ``is_global`` also covers
    ranges beyond the hand-written RFC1918 list (carrier NAT, multicast,
    reserved, documentation, unspecified, and mapped addresses).
    """
    host = (host or "").strip().rstrip(".").lower()
    if not host:
        return []
    try:
        infos = socket.getaddrinfo(host, None)
    except Exception:
        return []
    ips = []
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except Exception:
            return []
        if (not ip.is_global or ip.is_private or ip.is_loopback or
                ip.is_link_local or ip.is_multicast or ip.is_reserved or
                ip.is_unspecified or any(ip in block for block in _SSRF_BLOCKS)):
            return []
        value = str(ip)
        if value not in ips:
            ips.append(value)
    return ips


_FILE_BODY_CAP = 32 * 1024 * 1024
_FILE_REDIRECTS = 5


async def _safe_file_bytes(url: str, cap: int = _FILE_BODY_CAP) -> tuple[bytes, str, str]:
    """Fetch public bytes with DNS pinning, hop-by-hop redirect validation,
    and a hard response cap. Returns bytes, content type, final URL."""
    current = str(url or "").strip()
    async with httpx.AsyncClient(timeout=45.0, follow_redirects=False) as client:
        for hop in range(_FILE_REDIRECTS + 1):
            try:
                parts = urlparse(current)
            except Exception:
                raise HTTPException(status_code=400, detail="bad URL")
            if parts.scheme != "https" or parts.username or parts.password or not parts.hostname:
                raise HTTPException(status_code=400, detail="file URL must be public HTTPS with no credentials")
            ips = _resolve_public_ips(parts.hostname)
            if not ips:
                raise HTTPException(status_code=400, detail="private or unresolvable host")
            ip = ips[0]
            netloc = f"[{ip}]" if ":" in ip else ip
            if parts.port: netloc += f":{parts.port}"
            pinned = urlunparse(parts._replace(netloc=netloc))
            headers = {"Host": parts.netloc, "User-Agent": "Impose-file-relay/1", "Accept": "*/*"}
            ext = {"sni_hostname": parts.hostname}
            try:
                async with client.stream("GET", pinned, headers=headers, extensions=ext) as response:
                    if response.status_code in (301, 302, 303, 307, 308):
                        target = response.headers.get("location", "")
                        if not target or hop >= _FILE_REDIRECTS:
                            raise HTTPException(status_code=502, detail="too many or invalid redirects")
                        current = urljoin(current, target)
                        continue
                    if response.status_code < 200 or response.status_code >= 300:
                        raise HTTPException(status_code=502, detail=f"file host returned {response.status_code}")
                    declared = response.headers.get("content-length", "")
                    if declared.isdigit() and int(declared) > cap:
                        raise HTTPException(status_code=413, detail="file exceeds the relay size limit")
                    chunks, total = [], 0
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > cap:
                            raise HTTPException(status_code=413, detail="file exceeds the relay size limit")
                        chunks.append(chunk)
                    ctype = response.headers.get("content-type", "application/octet-stream").split(";", 1)[0].strip().lower()
                    if not re.fullmatch(r"[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+", ctype):
                        ctype = "application/octet-stream"
                    return b"".join(chunks), ctype, current
            except HTTPException:
                raise
            except httpx.TimeoutException:
                raise HTTPException(status_code=502, detail="file host timed out")
            except Exception:
                raise HTTPException(status_code=502, detail="file host unreachable")
    raise HTTPException(status_code=502, detail="file fetch failed")


@app.post("/v1/file")
async def file_proxy(request: Request):
    """Rate-limited, bounded binary transport for previews and downloads."""
    _tier_auth(request, "file", "pubfile", 40, PUB_FILE_BYTES_LIMIT)
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")
    url = str(data.get("url", ""))
    if not url or len(url) > 4000:
        raise HTTPException(status_code=400, detail="url is required")
    content, ctype, final_url = await _safe_file_bytes(url)
    filename = re.sub(r"[^A-Za-z0-9._ -]+", "_", unquote(urlparse(final_url).path.rsplit("/", 1)[-1]))[:180] or "download"
    mode = "attachment" if data.get("download") is True else "inline"
    headers = {"Content-Disposition": f'{mode}; filename="{filename}"',
               "X-Content-Type-Options": "nosniff", "Cache-Control": "private, max-age=60"}
    return Response(content=content, media_type=ctype, headers=headers)


# --------------------------------------------------------------------------- #
# accounts: email verification, signup, password reset
#
# The trust boundary lives here. The first version of this flow let the
# browser call supabase.auth.signUp() directly, which returned a session
# immediately, and only afterwards asked the relay to check a code. The
# check answered {"ok": true} to the same browser that asked and nothing
# consumed the answer, so skipping the code produced a confirmed, fully
# authenticated account. Verified against the live project.
#
# Now: public signup is off in the Supabase dashboard, the service role key
# lives only in this process, and an account can only be created by the
# handler below, after a code delivered to that address has been checked
# server side. The browser cannot mint a session it did not earn, because
# the only code path that creates one runs here.
#
# These endpoints sit in front of authentication, so they cannot require
# CONTROL_KEY. What protects them instead:
#   - per-IP and per-address rate limits, the address limit being the one
#     that stops an attacker rotating IPs to flood one inbox
#   - codes hashed with a pepper, single use, attempt capped
#   - responses that never reveal whether an address has an account
# --------------------------------------------------------------------------- #


# Addresses that exist to be thrown away. A disposable signup takes a
# handle, can post, and is unreachable the moment it is abused: there is no
# account to warn, suspend or email. The list is the common providers plus
# the ones already seen on this project; it is not exhaustive and is not
# meant to be. A determined person will get past it, which is fine. The
# purpose is to stop casual throwaway signups, not to win an arms race.
#
# example.com and friends are RFC 2606 reserved names that can never
# receive mail, so a signup using one can never be verified.
_BLOCKED_EMAIL_DOMAINS = {
    "example.com", "example.org", "example.net", "example.edu",
    "test.com", "invalid", "localhost", "loadtest.invalid",
    "mailinator.com", "tempmail.com", "temp-mail.org", "guerrillamail.com",
    "10minutemail.com", "throwawaymail.com", "yopmail.com", "trashmail.com",
    "sharklasers.com", "getnada.com", "dispostable.com", "maildrop.cc",
    "fakeinbox.com", "mailnesia.com", "spamgourmet.com", "mintemail.com",
    "tempinbox.com", "emailondeck.com", "moakt.com", "mohmal.com",
}

_BLOCKED_EMAIL_PREFIXES = ("mailinator.", "yopmail.")


def _local_part_is_spammy(local: str) -> bool:
    """Keyboard mash and generated junk, caught by shape rather than judgement.

    Signup derives the display name and handle from the local part, and an
    account that cannot be named, warned, or reached is only good for spam.
    The rules mirror the database's text_is_spammy exactly, so a string one
    boundary refuses is refused by the other:

      (.)\\1{4}    the same character five or more times in a row
      (..)\\1\\1   a two-character block repeated three times in a row
      (...)\\1\\1  a three-character block repeated three times in a row
      letters >= 6 with no vowel: letter soup

    Deliberately narrow: real names and real addresses always pass these,
    so a false positive costs nothing but a retry with the address the
    person actually owns.
    """
    value = str(local or "")
    if re.search(r"(.)\1{4}", value):
        return True
    if re.search(r"(..)\1\1", value) or re.search(r"(...)\1\1", value):
        return True
    letters = re.sub(r"[^A-Za-z]", "", value)
    if len(letters) >= 6 and not re.search(r"[aeiouAEIOU]", letters):
        return True
    return False


def _otp_email(data: dict) -> str:
    email = str(data.get("email", "")).strip().lower()

    # Shape first, so a malformed address never reaches the domain rules.
    if not email or len(email) > 254 or not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise HTTPException(status_code=400, detail="Enter a valid email address.")

    local, _, domain = email.rpartition("@")

    # A leading or trailing dot in the local part, or two in a row, is
    # invalid per RFC 5322 and is a common way to slip past naive checks.
    if local.startswith(".") or local.endswith(".") or ".." in local:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")

    # RFC 5321 caps the local part at 64. An address past that cannot be a
    # mailbox, only an input probing how much we swallow.
    if len(local) > 64:
        raise HTTPException(status_code=400, detail="Enter a valid email address.")

    if domain in _BLOCKED_EMAIL_DOMAINS or domain.startswith(_BLOCKED_EMAIL_PREFIXES):
        raise HTTPException(
            status_code=400,
            detail="That email provider is not accepted. Use an address you can receive mail at.",
        )

    return email


def _signup_email(data: dict) -> str:
    """The signup-only layer of address validation.

    Reset and other flows reuse an address an account already carries, so
    the shape rules apply to everyone but the quality rules apply only
    here: a legacy account with an odd address must still be able to
    recover, while a new account must not be minted from one.
    """
    email = _otp_email(data)
    local = email.rpartition("@")[0]
    if _local_part_is_spammy(local):
        raise HTTPException(
            status_code=400,
            detail="That address looks made up. Use an email you can receive mail at.",
        )
    return email


def _otp_password(data: dict) -> str:
    """Validated here as well as in the browser.

    The client checks this to give fast feedback; this check is the one
    that counts, because a request does not have to come from our page.
    """
    password = str(data.get("password", ""))

    # The same rule the signup form states. It was only checking length, so
    # a request that skipped the form, or the password reset flow which has
    # its own weaker client check, could set a password the product had
    # already told the user was not allowed. The strength rule now lives in
    # one place and that place is the server.
    if len(password) < 8:
        raise HTTPException(status_code=400, detail="Use at least 8 characters.")
    if len(password) > 200:
        raise HTTPException(status_code=400, detail="That password is too long.")
    if not re.search(r"\d", password):
        raise HTTPException(status_code=400, detail="Include at least one number.")
    if not re.search(r"[^A-Za-z0-9]", password):
        raise HTTPException(status_code=400, detail="Include at least one special character.")
    return password


def _issued_code() -> str:
    return "".join(secrets.choice("0123456789") for _ in range(otp_store.CODE_LENGTH))


@app.post("/v1/auth/otp/request")
async def otp_request(request: Request):
    ip = _client_ip(request)
    if _rate_hit("otpip", ip, 12, 3600.0):
        raise HTTPException(status_code=429, detail="too many code requests; try again later")
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")

    email = _otp_email(data)
    try:
        purpose = otp_store.normalize_purpose(data.get("purpose"))
    except otp_store.OtpError as exc:
        raise HTTPException(status_code=400, detail=exc.message)

    if _rate_hit("otpaddr", email, 6, 3600.0):
        raise HTTPException(status_code=429, detail="too many codes sent to this address; try again later")

    if not supabase_admin.configured():
        raise HTTPException(status_code=503, detail="accounts are not configured on the server")

    if purpose == "reset":
        # An address with no account gets an identical answer and no email.
        # Sending a code anyway turned this endpoint into a mail relay for
        # arbitrary inboxes: twelve requests an hour per IP, six per
        # address, each one a real send from our provider to a stranger.
        # The response shape is deliberately indistinguishable from the
        # known-address path, so this cannot be probed for enumeration.
        if not await supabase_admin.find_user_by_email(email):
            return {
                "ok": True,
                "resend_in": otp_store.RESEND_COOLDOWN_SECONDS,
                "expires_in": otp_store.CODE_TTL_SECONDS,
                "delivery": "email" if mailer_configured() else "console",
            }

    pending_user_id = None
    if purpose == "signup":
        # The quality rules on top of the shape rules apply only to new
        # accounts: a legacy address must still be able to reset.
        email = _signup_email(data)
        password = _otp_password(data)
        existing = await supabase_admin.find_user_by_email(email)
        if existing:
            if existing.get("email_confirmed_at"):
                raise HTTPException(
                    status_code=409,
                    detail="That address already has an account. Try signing in.",
                )
            # An unconfirmed row is an abandoned or retried signup, not a
            # real account. Replace it so a half-finished attempt cannot
            # squat an address, and so the password in Supabase matches the
            # one just typed.
            await supabase_admin.delete_user(existing["id"])

        # Created disabled. Supabase hashes the password on arrival, which
        # is why nothing here has to keep it: the old design encrypted it
        # into the codes table for ten minutes, making OTP_PEPPER a key
        # whose loss was a breach.
        try:
            created = await supabase_admin.create_pending_user(email, password)
        except supabase_admin.AdminError as exc:
            print(f"[auth] could not stage signup for {email}: {exc.detail}")
            raise HTTPException(status_code=exc.status, detail=exc.safe)
        pending_user_id = created.get("id")

    code = _issued_code()
    try:
        issued = await otp_store.issue(email, purpose, code, pending_user_id)
    except otp_store.OtpError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message)

    if not issued["reused"]:
        try:
            await send_code(email, code, purpose, otp_store.CODE_TTL_SECONDS)
        except MailFailed as exc:
            print(f"[otp] delivery failed for {email}: {exc}")
            # No code can arrive, so the staged account would block the
            # address on every retry. Remove it rather than leave a ghost.
            if pending_user_id:
                await supabase_admin.delete_user(pending_user_id)
            # The code row has to go too. Left behind, it holds the resend
            # cooldown open, so the next attempt is told a live code exists
            # and no second email is sent: one delivery failure locked the
            # address out for the full ten minutes.
            await otp_store.forget(email, purpose)
            raise HTTPException(status_code=502, detail="could not send the email just now; try again shortly")

    return {
        "ok": True,
        "resend_in": issued["resend_in"],
        "expires_in": otp_store.CODE_TTL_SECONDS,
        "delivery": "email" if mailer_configured() else "console",
    }


@app.post("/v1/auth/otp/verify")
async def otp_verify(request: Request):
    """Verify a code and act on it.

    This endpoint does the thing the old one only claimed to do. On signup
    it creates the confirmed account and returns a real Supabase session;
    on reset it returns a short-lived ticket that the reset endpoint below
    requires. Either way the browser leaves with something it could not
    have produced on its own.
    """
    ip = _client_ip(request)
    if _rate_hit("otpverifyip", ip, 40, 3600.0):
        raise HTTPException(status_code=429, detail="too many attempts; try again later")
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")

    email = _otp_email(data)
    try:
        purpose = otp_store.normalize_purpose(data.get("purpose"))
        row = await otp_store.verify(email, purpose, data.get("code"))
    except otp_store.OtpError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message)

    if purpose == "reset":
        # Proof of inbox control, good for ten minutes and one password
        # change. Not a session: it cannot read or write anything. Stored
        # hashed in the database rather than a process dict, so a restart
        # or a second instance does not silently invalidate it.
        ticket = secrets.token_urlsafe(32)
        try:
            await otp_store.issue_ticket(email, ticket, row.get("user_id"))
        except otp_store.OtpError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message)
        return {"ok": True, "email": email, "purpose": purpose, "ticket": ticket}

    # Signup. The account already exists, disabled, created when the code
    # was requested. Verification flips the one flag that makes it usable,
    # so nothing had to remember the password.
    user_id = row.get("user_id")
    if not user_id:
        raise HTTPException(status_code=410, detail="That signup expired. Start again.")

    try:
        await supabase_admin.confirm_user(user_id)
    except supabase_admin.AdminError as exc:
        print(f"[auth] confirm failed for {email}: {exc.detail}")
        raise HTTPException(status_code=exc.status, detail=exc.safe)

    # The browser gets a session by signing in normally. The relay does not
    # mint tokens: Supabase stays the authority on what a valid session is.
    return {"ok": True, "email": email, "purpose": purpose, "confirmed": True}


@app.post("/v1/auth/password/reset")
async def password_reset(request: Request):
    """Set a new password, but only for a browser holding a fresh ticket."""
    ip = _client_ip(request)
    if _rate_hit("pwreset", ip, 20, 3600.0):
        raise HTTPException(status_code=429, detail="too many attempts; try again later")
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")

    ticket = str(data.get("ticket", ""))
    password = _otp_password(data)

    if not supabase_admin.configured():
        raise HTTPException(status_code=503, detail="accounts are not configured on the server")

    try:
        held = await otp_store.redeem_ticket(ticket)
    except otp_store.OtpError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message)
    if not held:
        raise HTTPException(status_code=403, detail="That reset expired. Request a new code.")

    try:
        user_id = held.get("user_id")
        if not user_id:
            user = await supabase_admin.find_user_by_email(held["email"])
            if not user:
                # Only said now, after a code proved the caller owns the
                # inbox, so this cannot be used to enumerate addresses.
                raise HTTPException(status_code=404, detail="That address has no account.")
            user_id = user["id"]
        await supabase_admin.set_password(user_id, password)
    except supabase_admin.AdminError as exc:
        print(f"[auth] reset failed: {exc.detail}")
        raise HTTPException(status_code=exc.status, detail=exc.safe)

    return {"ok": True}


@app.post("/v1/fetch")
async def fetch_proxy(request: Request):
    _authed(request)
    if _rate_hit("fetch", _client_ip(request), 60, 60.0):
        raise HTTPException(status_code=429, detail="fetch rate limit reached; wait a minute")
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")
    method = str(data.get("method", "")).upper()
    if method not in ("GET", "POST"):
        raise HTTPException(status_code=400, detail="method must be GET or POST")
    url = str(data.get("url", ""))
    try:
        parts = urlparse(url)
        scheme, user, host = parts.scheme, parts.username, parts.hostname
    except Exception:
        raise HTTPException(status_code=400, detail="bad URL")
    if scheme not in ("http", "https") or user or not host:
        raise HTTPException(status_code=400, detail="URL must be http(s) with no credentials")
    ips = _resolve_public_ips(host)
    if not ips:
        raise HTTPException(status_code=400, detail="private or unresolvable host")
    fwd = {}
    for k, v in (data.get("headers") or {}).items():
        if str(k).lower() in ("host", "content-length", "connection", "cookie",
                               "transfer-encoding", "upgrade"):
            continue
        fwd[str(k)] = str(v)
    body = data.get("body")
    content = str(body)[:1000000].encode("utf-8", "replace") if body is not None else None
    t0 = time.time()

    # Dial the IP we validated, not the name: a DNS rebinding answer between
    # the check and the connect would otherwise still reach an inside
    # address. SNI and Host keep pointing at the real name so TLS and
    # virtual hosts stay intact. Never fall back to a fresh hostname lookup.
    ip = ips[0]
    pinned_netloc = f"[{ip}]" if ":" in ip else ip
    if parts.port:
        pinned_netloc += f":{parts.port}"
    pinned_url = urlunparse(parts._replace(netloc=pinned_netloc))
    pinned_headers = dict(fwd)
    pinned_headers["Host"] = parts.netloc
    ext = {"sni_hostname": host} if parts.scheme == "https" else {}
    r = None
    try:
        async with httpx.AsyncClient(timeout=60.0, follow_redirects=False) as client:
            r = await client.request(method, pinned_url, headers=pinned_headers,
                                     content=content, extensions=ext)
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=502, detail="target timed out")
    except Exception:
        raise HTTPException(status_code=502, detail="target unreachable")
    if len(r.content) > _FETCH_BODY_CAP:
        raise HTTPException(status_code=502, detail="target response too large")
    ms = int((time.time() - t0) * 1000)
    print(f"[relay] fetch {method} {host} -> {r.status_code} ({ms}ms)", flush=True)
    return {"status": r.status_code,
            "headers": {"content-type": r.headers.get("content-type", "")},
            "body": r.text}


# --------------------------------------------------------------------------- #
# page reader: turn a URL into plain text the agent can reason over
# --------------------------------------------------------------------------- #

_IGNORE_TAGS = ("script", "style", "noscript", "template", "svg", "iframe")

_JUNK_CLASS = re.compile(
    r"(^|[-_ ])(nav|navbar|menu|sidebar|side-bar|footer|cookie|consent|gdpr|"
    r"promo|subscribe|newsletter|share|sharing|social|related|recommend|"
    r"comment|advert|ads?[-_ ]|banner|breadcrumb|pagination|pager|toc|"
    r"infobox|reflist|navbox|metadata|sistersitebox|mw-)( |$|[-_])", re.I)

_CONTENT_SEL = "article, main, [role=main], #content, .content"


def _absolutize(url: str, base: str) -> str:
    try:
        from urllib.parse import urljoin
        out = urljoin(base or "", url or "")
        return out if out.startswith(("http://", "https://")) else ""
    except Exception:
        return ""


def _parse_srcset(ss: str) -> str:
    """'a.jpg 480w, b.jpg 800w' -> the widest candidate."""
    best, best_w = "", -1
    for part in (ss or "").split(","):
        bits = part.strip().split()
        if not bits:
            continue
        w = 0
        if len(bits) > 1 and bits[1].rstrip("w").isdigit():
            w = int(bits[1].rstrip("w"))
        elif len(bits) == 1:
            w = 1  # bare url: still a candidate
        if w > best_w:
            best, best_w = bits[0], w
    return best


def _pick_container(soup):
    """The content node: article-like first, body only as a fallback."""
    for sel in ("article", "main", "[role=main]"):
        node = soup.select_one(sel)
        if node and len(node.get_text(" ", strip=True)) >= 200:
            return node
    body = soup.body or soup
    best, best_len = body, len(body.get_text(" ", strip=True))
    for node in body.find_all(True, recursive=False):
        n = len(node.get_text(" ", strip=True))
        if n > best_len:
            best, best_len = node, n
    return best


def _prune(soup, container):
    """Fit-style noise pruning: chrome out, content in. Two passes - junk
    nodes by role/class, then menu-like link-farm blocks inside the
    container. Conservative on purpose: cutting a real paragraph costs
    more than keeping a stray aside."""
    for tag in soup.find_all(_IGNORE_TAGS):
        tag.decompose()
    for tag in soup.find_all(["nav", "footer", "aside", "form", "button",
                              "select", "noscript"]):
        tag.decompose()
    for tag in soup.find_all(attrs={"role": ["navigation", "banner",
                                             "contentinfo", "complementary",
                                             "menubar"]}):
        tag.decompose()
    for tag in soup.find_all(class_=_JUNK_CLASS):
        if tag.name in ("html", "body", "head"):
            continue  # a feature-flag class must not take the document down
        tag.decompose()
    for tag in soup.find_all(id=_JUNK_CLASS):
        if tag.name in ("html", "body", "head"):
            continue
        tag.decompose()
    if container is not None:
        for block in list(container.find_all(["div", "section", "ul", "table"])):
            txt = block.get_text(" ", strip=True)
            if not txt:
                continue
            link_txt = " ".join(a.get_text(" ", strip=True) for a in block.find_all("a"))
            if len(link_txt) > len(txt) * 0.6 and len(txt) < 400:
                block.decompose()


def _collect_images(container, base, meta):
    """og:image first, then content images (srcset aware, lazy-load aware)."""
    out, seen = [], set()
    def add(u, alt="", thumb=""):
        u = _absolutize(u, base)
        if not u or u in seen:
            return
        low = u.rsplit("?", 1)[0].lower()
        if low.endswith((".svg", ".ico")) or any(w in low for w in ("sprite", "logo", "icon", "pixel", "blank.gif", "1x1")):
            return
        seen.add(u)
        out.append({"image": u, "thumb": _absolutize(thumb, base) or u,
                    "title": (alt or "").strip()[:160], "page": base,
                    "source": urlparse(base).hostname or ""})
    if meta.get("image"):
        add(meta["image"], "cover")
    if container is not None:
        for img in container.find_all("img"):
            u = img.get("src") or img.get("data-src") or img.get("data-lazy-src") or ""
            srcset = img.get("srcset") or img.get("data-srcset") or ""
            if srcset:
                u = _parse_srcset(srcset) or u
            try:
                w = int(img.get("width") or 0)
            except Exception:
                w = 0
            if not u or (w and w < 120):
                continue
            add(u, img.get("alt") or "")
    return out[:12]


def _collect_refs(container, base, cap=20):
    """Numbered references: the page's own links, absolute and deduped."""
    out, seen = [], set()
    if container is None:
        return out
    for a in container.find_all("a", href=True):
        u = _absolutize(a["href"], base)
        if not u or u in seen or u.rstrip("/") == base.rstrip("/"):
            continue
        title = " ".join(a.get_text(" ", strip=True).split())
        if not title and a.get("title"):
            title = a["title"]
        if not title:
            continue
        seen.add(u)
        out.append({"title": title[:160], "url": u})
        if len(out) >= cap:
            break
    return out


def _collect_meta(soup):
    meta = {}
    def put(k, v):
        v = " ".join(str(v or "").split())
        if v:
            meta.setdefault(k, v[:300])
    for prop, key in (("og:site_name", "site"), ("og:image", "image"),
                      ("og:description", "description"),
                      ("article:published_time", "date"),
                      ("article:author", "author")):
        tag = soup.find("meta", attrs={"property": prop})
        if tag:
            put(key, tag.get("content"))
    tag = soup.find("meta", attrs={"name": re.compile("^author$", re.I)})
    if tag:
        put("author", tag.get("content"))
    tag = soup.find("meta", attrs={"name": re.compile("^description$", re.I)})
    if tag:
        put("description", tag.get("content"))
    tag = soup.find("link", attrs={"rel": "canonical"})
    if tag:
        put("canonical", tag.get("href"))
    tag = soup.find("time", attrs={"datetime": True})
    if tag:
        put("date", tag.get("datetime"))
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except Exception:
            continue
        if isinstance(data, list):
            data = data[0] if data else {}
        if not isinstance(data, dict):
            continue
        put("date", data.get("datePublished"))
        author = data.get("author")
        if isinstance(author, dict):
            put("author", author.get("name"))
        elif isinstance(author, str):
            put("author", author)
    return meta


def html_to_text(html: str, cap: int = 12000, base_url: str = "") -> dict:
    """HTML to fit text: scripts, styles and page chrome out, main content
    in, links kept as numbered references, metadata and content images
    extracted. Pure function so it is easy to test."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html or "", "html.parser")
    title = " ".join(soup.title.string.split()) if (soup.title and soup.title.string) else ""
    meta = _collect_meta(soup)
    if not title and meta.get("og:title"):
        title = meta["og:title"]
    container = _pick_container(soup)
    _prune(soup, container)
    where = container if container is not None else (soup.body or soup)
    refs = _collect_refs(where, base_url or meta.get("canonical", ""))
    images = _collect_images(where, base_url, meta)
    for block in where.find_all(["p", "div", "section", "article", "li", "tr",
                                 "h1", "h2", "h3", "h4", "h5", "h6", "br"]):
        block.append("\n")
    text = where.get_text(" ")
    lines = []
    for line in text.splitlines():
        line = " ".join(line.split())
        if line:
            lines.append(line)
        elif lines and lines[-1] != "":
            lines.append("")
    out = "\n".join(lines).strip()
    if len(out) > cap:
        out = out[:cap] + "\n..."
    return {"title": title[:300], "text": out, "meta": meta,
            "refs": refs, "images": images}


@app.post("/v1/read")
async def read_proxy(request: Request):
    """Fetch a page (same SSRF rules as /v1/fetch) and return its text so
    the research agent can read a cited source, not just its snippet."""
    _authed(request)
    if _rate_hit("read", _client_ip(request), 60, 60.0):
        raise HTTPException(status_code=429, detail="read rate limit reached; wait a minute")
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")
    url = str(data.get("url", ""))
    try:
        parts = urlparse(url)
        scheme, user, host = parts.scheme, parts.username, parts.hostname
    except Exception:
        raise HTTPException(status_code=400, detail="bad URL")
    if scheme not in ("http", "https") or user or not host:
        raise HTTPException(status_code=400, detail="URL must be http(s) with no credentials")
    cached = _cache_get("read", url)
    if cached is not None:
        return cached
    ips = _resolve_public_ips(host)
    if not ips:
        raise HTTPException(status_code=400, detail="private or unresolvable host")
    # Manual redirect hops: every hop is SSRF checked again. Auto follow
    # would let a public page bounce us straight at an inside address.
    r = None
    current_url = url
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=False) as client:
            for _hop in range(4):
                infos = _resolve_public_ips(host)
                if not infos:
                    raise HTTPException(status_code=400, detail="redirect landed on a private host")
                ip = infos[0]
                pinned_netloc = f"[{ip}]" if ":" in ip else ip
                if parts.port:
                    pinned_netloc += f":{parts.port}"
                pinned_url = urlunparse(parts._replace(netloc=pinned_netloc))
                r = await client.get(pinned_url, headers={"Host": parts.netloc,
                                                          "User-Agent": "Mozilla/5.0 (compatible; ImposeAgent/1.0)"},
                                     extensions={"sni_hostname": host} if parts.scheme == "https" else {})
                if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
                    current_url = urljoin(current_url, r.headers["location"])
                    parts = urlparse(current_url)
                    scheme, user, host = parts.scheme, parts.username, parts.hostname
                    if scheme not in ("http", "https") or user or not host:
                        raise HTTPException(status_code=400, detail="redirect to a bad URL")
                    continue
                break
            else:
                raise HTTPException(status_code=502, detail="too many redirects")
    except HTTPException:
        raise
    except httpx.TimeoutException:
        raise HTTPException(status_code=502, detail="target timed out")
    except Exception:
        raise HTTPException(status_code=502, detail="target unreachable")
    ctype = r.headers.get("content-type", "")
    if len(r.content) > _FETCH_BODY_CAP:
        raise HTTPException(status_code=502, detail="target response too large")
    if "html" not in ctype and "text" not in ctype and ctype:
        return {"url": current_url, "status": r.status_code, "title": "", "text": "",
                "note": "the page is not text (" + ctype.split(";")[0] + ")"}
    page = html_to_text(r.text, base_url=current_url)
    out = {"url": current_url, "status": r.status_code, "title": page["title"],
           "text": page["text"], "meta": page["meta"], "refs": page["refs"],
           "images": page["images"]}
    _cache_put("read", url, out, 300.0)
    return out


def _status_note(gateway_up: bool, snap: dict, missing: list[str]) -> str:
    if gateway_up:
        if snap.get("llm_up") is False:
            return "The gateway is online but its model process is not ready."
        return ""
    if not GATEWAY_URL:
        return "Set LLM_GATEWAY_URL to the Lightning gateway root (without /v1)."
    if not WAKE_STUDIO:
        return "Set WAKE_STUDIO=1 and add the Lightning credentials to enable automatic wake."
    if missing:
        return "Missing wake configuration: " + ", ".join(missing) + "."
    if snap.get("error"):
        return "Gateway probe failed: " + str(snap["error"])
    return "The configured gateway did not answer."


@app.get("/admin/accounts")
async def admin_accounts(request: Request):
    """Why is signup failing? Answers it without reading the host's logs.

    Every dependency of the account flow, checked for real rather than
    reported from config. Two outages so far looked identical from the
    outside, a 502 with a deliberately vague message, and both took a
    round trip through Render's log viewer to tell apart: one was a
    missing EXECUTE grant, the other a Sendlib rejection. This endpoint
    distinguishes them in one call.

    Behind CONTROL_KEY, because it names infrastructure. It reports whether
    each credential is present and whether each dependency answers, never
    the credentials themselves.
    """
    _authed(request)

    out = {
        "supabase_url": bool(os.environ.get("SUPABASE_URL", "").strip()),
        "supabase_service_key": bool(os.environ.get("SUPABASE_SERVICE_KEY", "").strip()),
        "otp_pepper": bool(os.environ.get("OTP_PEPPER", "").strip()),
        "sendlib_key": bool(os.environ.get("SENDLIB_API_KEY", "").strip()),
        "sendlib_from": bool(os.environ.get("SENDLIB_FROM", "").strip()),
    }

    # Can the relay actually call the code store? A grant can be missing
    # while every variable is set, which is exactly what happened.
    try:
        await otp_store.peek_probe()
        out["auth_codes_rpc"] = "ok"
    except Exception as exc:
        out["auth_codes_rpc"] = str(exc)[:200]

    # Can it reach the mail provider, and what does the provider say?
    if out["sendlib_key"] and out["sendlib_from"]:
        try:
            out["sendlib"] = await mailer_probe()
        except Exception as exc:
            out["sendlib"] = str(exc)[:200]
    else:
        out["sendlib"] = "not configured; codes go to this log"

    out["ready"] = all([out["supabase_url"], out["supabase_service_key"],
                        out["otp_pepper"], out["auth_codes_rpc"] == "ok"])
    return out


@app.get("/admin/reports")
async def admin_reports(request: Request, status: str = "pending", limit: int = 50):
    """The moderation queue, readable only with the CONTROL_KEY.

    Reports are how a reader flags abuse, but the reports table has no
    client policies, so nothing short of the service key can read it.
    The relay holds that key, so this endpoint is the operator's single
    URL for "what was flagged." Newest first; the reporter's handle is
    embedded so the operator sees who flagged what without a second
    lookup. Reading never mutates: acting on a report (reviewed/
    actioned/dismissed) is done in the database by the operator.
    """
    _authed(request)
    try:
        rows = await reports_store.fetch(status=status, limit=limit)
    except reports_store.ReportsError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))
    return {"count": len(rows), "reports": rows}


@app.get("/admin/status")
def admin_status(request: Request):
    _authed(request)
    gateway_up = gateway_reachable(force=True)
    snap = _gateway_snapshot()
    missing = _wake_missing()
    return {"gateway_up": gateway_up,
            "llm_up": snap.get("llm_up") if gateway_up else False,
            "gateway_configured": bool(GATEWAY_URL),
            "gateway_http_status": snap.get("status"),
            "gateway_error": snap.get("error"),
            "idle_minutes": round(idle_minutes(), 1),
            "idle_stop_minutes": IDLE_STOP_MINUTES,
            "idle_monitor": IDLE_MONITOR and WAKE_STUDIO,
            "wake_on_chat": WAKE_ON_CHAT,
            "wake_studio": WAKE_STUDIO,
            "wake_configured": WAKE_STUDIO and not missing,
            "waking": _waking,
            "note": _status_note(gateway_up, snap, missing),
            "uptime_seconds": round(time.time() - STARTED_AT, 1)}


@app.post("/admin/wake-llm")
def admin_wake(request: Request, background: bool = False):
    """Wake the LLM chain on demand. Safe to call anytime. With
    `?background=1` it returns immediately and the wake continues server-side."""
    _authed(request)
    if gateway_reachable():
        snap = _gateway_snapshot()
        if snap.get("llm_up") is False:
            if background:
                _start_gateway_llm_in_background()
                return Response(
                    content=json.dumps({"llm_up": False, "woke": True,
                                        "state": "starting-model"}),
                    media_type="application/json", status_code=202)
            ok = _start_gateway_llm()
            if not ok:
                raise HTTPException(status_code=503,
                                    detail="The gateway is online but its model failed to start.")
            return {"llm_up": True, "woke": True}
        return {"llm_up": True, "woke": False,
                "note": "gateway and model are already online"}
    if not WAKE_STUDIO:
        raise HTTPException(
            status_code=409,
            detail="Automatic wake is disabled. Set WAKE_STUDIO=1 and add the Lightning credentials.")
    missing = _wake_missing()
    if missing:
        raise HTTPException(status_code=409,
                            detail="Missing wake configuration: " + ", ".join(missing))
    if background:
        _wake_in_background()
        return Response(
            content=json.dumps({"llm_up": False, "woke": True, "state": "waking"}),
            media_type="application/json", status_code=202)
    ok = wake_studio()
    if not ok:
        raise HTTPException(status_code=503, detail="The Studio wake attempt failed. Check the relay logs.")
    return {"llm_up": True, "woke": True}


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #


def main() -> None:
    print(f"[relay] starting on 0.0.0.0:{PORT}", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
