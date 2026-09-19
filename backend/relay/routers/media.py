"""Media and retrieval routes: models, chat, search, images, videos,
files, fetch, read, and the signed image-convert artifact path.

Cut from the monolithic relay.server (modularisation pass). Route
bodies are verbatim; only the registration object changed from
``app`` to a local ``APIRouter`` that relay.server mounts.
"""
from fastapi import APIRouter

import asyncio
import hmac
import json
import re
import secrets
import time
from urllib.parse import unquote, urljoin, urlparse, urlunparse

import httpx
try:
    import cairosvg
except ImportError:  # dependency is installed by backend/requirements.txt in production
    cairosvg = None
from fastapi import HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response, StreamingResponse

from relay.files import discover_files
from relay.images import ImagesFailed, engine_images
from relay.search import SearchFailed, engine_search
from relay.settings import CONTROL_KEY, GATEWAY_KEY, GATEWAY_URL, PUB_SEARCH_LIMIT
from relay.shared import (
    PUB_FILES_LIMIT, PUB_FILE_BYTES_LIMIT, PUB_IMAGES_LIMIT, PUB_VIDEO_LIMIT,
    _IMAGE_VERIFY_CAP,
)
from relay.videos import VideosFailed, engine_videos
from relay.shared import (
    _authed, _authed_member, _bounded_mapping, _bounded_strings,
    _cache_get, _cache_put, _client_ip, _conversion_signature,
    _gateway_headers, _need_wake, _rate_hit, _resolve_public_ips,
    _safe_file_bytes, _semantic_bool, _tier_auth,
    _verify_image_constraints, gateway_reachable, html_to_text,
    mark_gateway_down, touch_activity,
)
from relay.source_intelligence import CATALOG



router = APIRouter()

@router.get("/v1/models")
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


@router.post("/v1/chat/completions")
async def chat(request: Request):
    # B-01: members authenticate with their own Supabase session (grant-
    # checked server side), so the CONTROL_KEY never has to live in a
    # member's browser. /admin/* keeps requiring the key itself.
    await _authed_member(request)
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


@router.get("/v1/source/catalog")
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


@router.api_route("/v1/search", methods=["GET", "POST"])
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


@router.get("/v1/image-convert")
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


@router.api_route("/v1/images", methods=["GET", "POST"])
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


@router.api_route("/v1/videos", methods=["GET", "POST"])
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


@router.api_route("/v1/files", methods=["GET", "POST"])
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


_FETCH_BODY_CAP = 8 * 1024 * 1024
@router.post("/v1/file")
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


@router.post("/v1/fetch")
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


@router.post("/v1/read")
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


