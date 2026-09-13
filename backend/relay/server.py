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
import ipaddress
import json
import os
import re
import socket
import threading
import time
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import httpx
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from relay.search import SearchFailed, engine_search
from relay.images import ImagesFailed, engine_images

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

# Gateway state is a cache, not a question we ask the network on every
# request: an 8 second health round trip per chat completion made every
# message slower and stampeded the box under load. Transport errors mark it
# down at once; any successful probe marks it up.
_GW_TTL = 10.0
_gateway_state = {"up": None, "at": 0.0}
_state_lock = threading.Lock()

# --- auth + proxy rate limiting (per client IP, in memory) ---
_RATE_BUCKETS = {}
_rate_lock = threading.Lock()


def _client_ip(request: Request) -> str:
    try:
        return request.client.host if request.client else "?"
    except Exception:
        return "?"


def _rate_hit(bucket: str, key: str, limit: int, window: float) -> bool:
    """Record one event; True when the caller is over the limit."""
    now = time.time()
    with _rate_lock:
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


def _gateway_headers() -> dict:
    headers = {"Content-Type": "application/json"}
    if GATEWAY_KEY:
        headers["Authorization"] = "Bearer " + GATEWAY_KEY
    return headers


# --------------------------------------------------------------------------- #
# gateway reachability + wake + idle
# --------------------------------------------------------------------------- #


def gateway_reachable(force: bool = False) -> bool:
    """Whether the box gateway answers at all. Only a transport error (DNS,
    connect, timeout) means it is down; any HTTP answer proves it is up.
    Cached for a few seconds so every request is not a health poll."""
    if not GATEWAY_URL:
        return False
    now = time.time()
    with _state_lock:
        if not force and _gateway_state["up"] is not None and now - _gateway_state["at"] < _GW_TTL:
            return bool(_gateway_state["up"])
    try:
        httpx.get(f"{GATEWAY_URL}/health", timeout=8.0)
        up = True
    except Exception:
        up = False
    with _state_lock:
        _gateway_state["up"] = up
        _gateway_state["at"] = now
    return up


def mark_gateway_down() -> None:
    with _state_lock:
        _gateway_state["up"] = False
        _gateway_state["at"] = time.time()


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
            "gateway_up": gateway_reachable(force=True),
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
    client = httpx.AsyncClient(timeout=None)
    try:
        resp = await client.send(req, stream=True)
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
    else:
        q = request.query_params
        query = str(q.get("query", "") or q.get("q", ""))
        limit = q.get("limit", 8)
        raw_domains = q.get("domains")
        domains = raw_domains.split(",") if raw_domains else None
        freshness = q.get("freshness")
        language = q.get("language", "en")
        region = q.get("region")
    query = query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    if len(query) > 500:
        raise HTTPException(status_code=400, detail="query is too long (max 500 chars)")
    try:
        limit = max(1, min(20, int(limit)))
    except Exception:
        raise HTTPException(status_code=400, detail="limit must be 1..20")
    if domains is not None and not isinstance(domains, list):
        raise HTTPException(status_code=400, detail="domains must be a list")
    ckey = query.lower() + "|" + str(limit) + "|" + ",".join(sorted(domains or []))
    cached = _cache_get("search", ckey)
    if cached is not None:
        return cached
    try:
        out = await engine_search(query, limit=limit, domains=domains,
                                   freshness=freshness,
                                   language=str(language or "en"),
                                   region=region)
    except SearchFailed as e:
        raise HTTPException(status_code=502, detail=str(e))
    _cache_put("search", ckey, out, 120.0)
    return out


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
    else:
        q = request.query_params
        query = str(q.get("query", "") or q.get("q", ""))
        limit = q.get("limit", 8)
    query = query.strip()
    if not query:
        raise HTTPException(status_code=400, detail="query is required")
    if len(query) > 500:
        raise HTTPException(status_code=400, detail="query is too long (max 500 chars)")
    try:
        limit = max(1, min(20, int(limit)))
    except Exception:
        raise HTTPException(status_code=400, detail="limit must be 1..20")
    ckey = query.lower() + "|" + str(limit)
    cached = _cache_get("images", ckey)
    if cached is not None:
        return cached
    try:
        out = await engine_images(query, limit=limit)
    except ImagesFailed as e:
        raise HTTPException(status_code=502, detail=str(e))
    _cache_put("images", ckey, out, 180.0)
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
    """Every address `host` resolves to that is not on the block list. Empty
    means unresolvable or private: both are refused."""
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
            continue
        if any(ip in block for block in _SSRF_BLOCKS):
            continue
        ips.append(str(ip))
    return ips


def _public_host(host: str) -> bool:
    return bool(_resolve_public_ips(host))


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
    # virtual hosts stay intact. If the pinned dial cannot be done on this
    # httpx/httpcore, fall back to the name (re-checked) with redirects off.
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
            try:
                r = await client.request(method, pinned_url, headers=pinned_headers,
                                         content=content, extensions=ext)
            except Exception:
                if not _public_host(host):
                    raise HTTPException(status_code=400, detail="private or unresolvable host")
                r = await client.request(method, url, headers=fwd, content=content)
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
    ips = _resolve_public_ips(host)
    if not ips:
        raise HTTPException(status_code=400, detail="private or unresolvable host")
    # Manual redirect hops: every hop is SSRF checked again. Auto follow
    # would let a public page bounce us straight at an inside address.
    r = None
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
                    parts = urlparse(r.headers["location"])
                    scheme, user, host = parts.scheme, parts.username, parts.hostname
                    if scheme not in ("http", "https") or user or not host:
                        raise HTTPException(status_code=400, detail="redirect to a bad URL")
                    continue
                break
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
        return {"url": url, "status": r.status_code, "title": "", "text": "",
                "note": "the page is not text (" + ctype.split(";")[0] + ")"}
    cached = _cache_get("read", url)
    if cached is not None:
        return cached
    page = html_to_text(r.text, base_url=url)
    out = {"url": url, "status": r.status_code, "title": page["title"],
           "text": page["text"], "meta": page["meta"], "refs": page["refs"],
           "images": page["images"]}
    _cache_put("read", url, out, 300.0)
    return out


@app.get("/admin/status")
def admin_status(request: Request):
    _authed(request)
    return {"gateway_up": gateway_reachable(force=True),
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
