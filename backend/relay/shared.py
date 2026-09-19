"""Shared request machinery for the relay routers.

Split of the monolithic relay.server: the helpers every router leans on
(client ip, rate buckets, gateway/member caches, CONTROL_KEY and member
auth, safe-fetch primitives, html reading tools, wake scaffolding) live
here exactly once. Mutables live in relay.settings so tests replacing a
container replace the very object these functions look up at call time.
"""
import asyncio
import base64
import hashlib
import hmac
import ipaddress
import io
import json
import os
import re
import secrets
import socket
import threading
import time
from urllib.parse import quote, unquote, urljoin, urlparse, urlunparse

import httpx
from PIL import Image, UnidentifiedImageError
try:
    import cairosvg
except ImportError:  # dependency is installed by backend/requirements.txt in production
    cairosvg = None
from fastapi import HTTPException, Request

from relay import otp_store, supabase_admin
from relay.settings import (
    CONTROL_KEY, GATEWAY_URL, GATEWAY_KEY, WAKE_STUDIO, WAKE_ON_CHAT,
    IDLE_MONITOR, IDLE_STOP_MINUTES, IDLE_CHECK_MINUTES, PUB_SEARCH_LIMIT,
    PUBLIC_TIER, PUB_IMAGES_LIMIT, PUB_VIDEO_LIMIT, PUB_FILES_LIMIT,
    PUB_FILE_BYTES_LIMIT, RESTART_SCRIPT,
    _GW_TTL, _cache_lock, _member_cache_lock, _rate_lock, _state_lock,
    _wake_lock,
)
import relay.settings as _settings

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
    if now - _settings._rate_pruned_at < 60.0:
        return
    _settings._rate_pruned_at = now
    cutoff = now - 3600.0
    stale = [key for key, events in _settings._RATE_BUCKETS.items()
             if not events or events[-1] < cutoff]
    for key in stale:
        _settings._RATE_BUCKETS.pop(key, None)


def _rate_hit(bucket: str, key: str, limit: int, window: float) -> bool:
    """Record one event; True when the caller is over the limit."""
    now = time.time()
    with _rate_lock:
        _rate_prune(now)
        events = _settings._RATE_BUCKETS.setdefault(f"{bucket}:{key}", [])
        cutoff = now - window
        while events and events[0] < cutoff:
            events.pop(0)
        events.append(now)
        return len(events) > limit



def _cache_get(kind: str, key: str):
    with _cache_lock:
        hit = _settings._CACHE.get((kind, key))
        if not hit:
            return None
        expires, value = hit
        if expires < time.time():
            _settings._CACHE.pop((kind, key), None)
            return None
        return value


def _cache_put(kind: str, key: str, value, ttl: float):
    with _cache_lock:
        if len(_settings._CACHE) > 256:
            for stale, _ in sorted(_settings._CACHE.items(), key=lambda kv: kv[1][0])[:64]:
                _settings._CACHE.pop(stale, None)
        _settings._CACHE[(kind, key)] = (time.time() + ttl, value)


def _rate_over(bucket: str, key: str, limit: int, window: float) -> bool:
    now = time.time()
    with _rate_lock:
        events = _settings._RATE_BUCKETS.get(f"{bucket}:{key}", [])
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
PUB_WINDOW = 60.0


# --- member sessions, for endpoints members legitimately call --------------
#
# Closure audit B-01: the CONTROL_KEY alone used to stand between a chat
# request and the LLM, which meant the chat credential and the /admin/*
# credential were the same browser-held string. Chat now also accepts the
# caller's own Supabase session, proven by GoTrue and gated by the same
# workspace grant the database enforces. Verdicts are cached briefly per
# token so a streaming chat does not pay two round trips per request;
# revocation bites within the cache window, which is the documented
# tradeoff (60 seconds, not the old forever).

_settings._MEMBER_CACHE: dict = {}
_MEMBER_CACHE_TTL = 60.0


def _member_cache_get(key: str):
    entry = _settings._MEMBER_CACHE.get(key)
    if entry and entry[0] > time.monotonic():
        return entry[1]
    _settings._MEMBER_CACHE.pop(key, None)
    return None


def _member_cache_put(key: str, value) -> None:
    stale = [k for k, (at, _) in _settings._MEMBER_CACHE.items()
             if at <= time.monotonic() - _MEMBER_CACHE_TTL]
    for k in stale:
        _settings._MEMBER_CACHE.pop(k, None)
    if len(_settings._MEMBER_CACHE) > 2048:
        _settings._MEMBER_CACHE.pop(next(iter(_settings._MEMBER_CACHE)))
    _settings._MEMBER_CACHE[key] = (time.monotonic() + _MEMBER_CACHE_TTL, value)


async def _authed_member(request: Request) -> dict:
    """Chat is a member privilege, not an operator one.

    Either the CONTROL_KEY (operator tooling, still accepted) or a valid
    Supabase session whose account holds a workspace grant. Anything else
    gets the same refusal, and wrong guesses count against the same failure
    budget as _authed so this cannot become the softer brute-force path.
    """
    supplied = request.headers.get("Authorization", "")
    if CONTROL_KEY and hmac.compare_digest(supplied, "Bearer " + CONTROL_KEY):
        return {"role": "owner"}
    ip = _client_ip(request)
    if _rate_over("authfail", ip, 15, 60.0):
        raise HTTPException(status_code=429, detail="too many attempts; wait a minute")
    token = supplied[7:].strip() if supplied.lower().startswith("bearer ") else ""
    if not token:
        _rate_hit("authfail", ip, 15, 60.0)
        raise HTTPException(status_code=401, detail="invalid or missing session")
    cached = _member_cache_get("m:" + token)
    if cached is None:
        caller = await supabase_admin.verify_session(token)
        granted = False
        if caller and caller.get("id"):
            granted = await supabase_admin.has_workspace_grant(caller["id"])
        cached = {"user_id": caller.get("id"), "granted": bool(granted)} if caller else False
        _member_cache_put("m:" + token, cached)
    if not cached:
        _rate_hit("authfail", ip, 15, 60.0)
        raise HTTPException(status_code=401, detail="invalid or missing session")
    if not cached.get("granted"):
        raise HTTPException(status_code=403, detail="the workspace is not open to this account yet")
    return {"role": "member", "user_id": cached.get("user_id")}


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
        return dict(_settings._gateway_state)


def gateway_reachable(force: bool = False) -> bool:
    """Whether the real box gateway health endpoint answers correctly.

    A CDN error page or an unrelated HTTP service is not a healthy gateway.
    Cache probes briefly so concurrent chat requests do not stampede the box.
    """
    if not GATEWAY_URL:
        with _state_lock:
            _settings._gateway_state.update(up=False, llm_up=None, at=time.time(),
                                  status=None, error="LLM_GATEWAY_URL is not set")
        return False
    now = time.time()
    with _state_lock:
        if (not force and _settings._gateway_state["up"] is not None
                and now - _settings._gateway_state["at"] < _GW_TTL):
            return bool(_settings._gateway_state["up"])
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
        _settings._gateway_state.update(up=up, llm_up=llm_up, at=time.time(),
                              status=status, error=error)
    return up


def mark_gateway_down() -> None:
    with _state_lock:
        _settings._gateway_state.update(up=False, llm_up=None, at=time.time(),
                              error="gateway proxy request failed")


def touch_activity() -> None:
    _settings._last_activity = time.time()


def idle_minutes() -> float:
    return (time.time() - _settings._last_activity) / 60.0


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
    with _wake_lock:
        if _settings._waking:
            print("[wake] already waking, skipping duplicate", flush=True)
            return gateway_reachable()
        _settings._waking = True
    try:
        return _wake_studio_once()
    finally:
        with _wake_lock:
            _settings._waking = False


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
        _settings._gateway_state["llm_up"] = ok
        _settings._gateway_state["at"] = time.time()
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




_IMAGE_VERIFY_CAP = 8 * 1024 * 1024
_image_conversion_key = (CONTROL_KEY.encode("utf-8") if CONTROL_KEY else secrets.token_bytes(32))



def _conversion_signature(source: str) -> str:
    return hmac.new(_image_conversion_key, source.encode("utf-8"), hashlib.sha256).hexdigest()




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




_SSRF_BLOCKS = [ipaddress.ip_network(c) for c in (
    "127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16",
    "169.254.0.0/16", "0.0.0.0/8", "::1/128", "fc00::/7", "fe80::/10")]

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





# --------------------------------------------------------------------------- #
# email validation
# --------------------------------------------------------------------------- #

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
