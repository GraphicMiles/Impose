"""Keyless image search for the agent: Bing Images HTML, DDG Images, Openverse.

Same contract as search.py: parsers are pure functions tested against
fixtures, fetchers raise AttemptFail, tiers race inside the tier and the
first provider that answers with results wins. Openverse is the last tier
on purpose: it is a real API (no scraping) so it survives when the HTML
engines challenge datacenter IPs.

Each result: {title, image (full res), thumb (small), page (source page),
source (domain), w, h}. Only http(s) URLs are ever returned.
"""
import asyncio
import html as html_mod
import json
import re
import time
from urllib.parse import urlparse

import httpx

from relay.search import AttemptFail, UA

OPENVERSE = "https://api.openverse.org/v1/images/"


def _http_ok(url):
    return bool(url) and urlparse(url).scheme in ("http", "https")


def domain_of(url):
    try:
        host = urlparse(url).hostname or ""
    except Exception:
        return ""
    return host[4:] if host.startswith("www.") else host


def parse_bing_images(page):
    """Bing Images HTML: <a class="iusc" m="{&quot;murl&quot;:...}"> JSON blobs."""
    out = []
    for blob in re.findall(r'class="iusc"[^>]*? m="([^"]+)"', page):
        try:
            meta = json.loads(html_mod.unescape(blob))
        except Exception:
            continue
        img = meta.get("murl") or ""
        if not _http_ok(img):
            continue
        out.append({
            "title": (meta.get("t") or meta.get("purl") or "image").strip()[:160],
            "image": img,
            "thumb": meta.get("turl") if _http_ok(meta.get("turl")) else img,
            "page": meta.get("purl") if _http_ok(meta.get("purl")) else "",
            "source": domain_of(meta.get("purl") or img),
            "w": int(meta.get("mw") or 0) or None,
            "h": int(meta.get("mh") or 0) or None,
        })
    return out


def parse_ddg_images(data):
    """DDG i.js JSON: {results: [{image, thumbnail, width, height, title, url}]}."""
    out = []
    for r in (data.get("results") or []):
        img = r.get("image") or ""
        if not _http_ok(img):
            continue
        out.append({
            "title": (r.get("title") or "image").strip()[:160],
            "image": img,
            "thumb": r.get("thumbnail") if _http_ok(r.get("thumbnail")) else img,
            "page": r.get("url") if _http_ok(r.get("url")) else "",
            "source": domain_of(r.get("url") or img),
            "w": r.get("width") or None,
            "h": r.get("height") or None,
        })
    return out


def parse_openverse(data):
    out = []
    for r in (data.get("results") or []):
        img = r.get("url") or ""
        if not _http_ok(img):
            continue
        out.append({
            "title": (r.get("title") or "image").strip()[:160],
            "image": img,
            "thumb": r.get("thumbnail") if _http_ok(r.get("thumbnail")) else img,
            "page": r.get("foreign_landing_url") or "",
            "source": r.get("source") or domain_of(r.get("foreign_landing_url") or img),
            "w": r.get("width") or None,
            "h": r.get("height") or None,
        })
    return out


async def _bing_images(client, query, limit):
    try:
        r = await client.get("https://www.bing.com/images/search",
                             params={"q": query, "form": "HDRSC2", "count": min(limit * 2, 35)},
                             timeout=10.0)
    except httpx.TimeoutException:
        raise AttemptFail("timed out")
    except Exception:
        raise AttemptFail("unreachable")
    if r.status_code != 200:
        raise AttemptFail("http " + str(r.status_code))
    results = parse_bing_images(r.text)
    if not results:
        raise AttemptFail("no results parsed")
    return results[:limit]


async def _ddg_vqd(client, query):
    try:
        r = await client.get("https://duckduckgo.com/",
                             params={"q": query, "iax": "images", "ia": "images"}, timeout=10.0)
    except Exception:
        raise AttemptFail("vqd unreachable")
    m = re.search(r'vqd=["\']?([\d-]+)["\']?', r.text)
    if not m:
        raise AttemptFail("no vqd token")
    return m.group(1)


async def _ddg_images(client, query, limit):
    vqd = await _ddg_vqd(client, query)
    try:
        r = await client.get("https://duckduckgo.com/i.js",
                             params={"l": "us-en", "o": "json", "q": query,
                                     "vqd": vqd, "f": ",,,", "p": "1"},
                             headers={"Referer": "https://duckduckgo.com/"}, timeout=10.0)
    except httpx.TimeoutException:
        raise AttemptFail("timed out")
    except Exception:
        raise AttemptFail("unreachable")
    if r.status_code != 200:
        raise AttemptFail("http " + str(r.status_code))
    try:
        data = r.json()
    except Exception:
        raise AttemptFail("bad json")
    results = parse_ddg_images(data)
    if not results:
        raise AttemptFail("no results parsed")
    return results[:limit]


async def _openverse(client, query, limit):
    try:
        r = await client.get(OPENVERSE, params={"q": query, "page_size": min(limit, 20)},
                             timeout=12.0)
    except httpx.TimeoutException:
        raise AttemptFail("timed out")
    except Exception:
        raise AttemptFail("unreachable")
    if r.status_code != 200:
        raise AttemptFail("http " + str(r.status_code))
    try:
        results = parse_openverse(r.json())
    except Exception:
        raise AttemptFail("bad json")
    if not results:
        raise AttemptFail("no results parsed")
    return results[:limit]


class ImagesFailed(Exception):
    pass


async def engine_images(query, limit=8):
    t0 = time.time()
    attempts = []
    async with httpx.AsyncClient(headers=UA, follow_redirects=True, max_redirects=3) as client:
        tiers = [
            [("bing-images", partial_bing(client, query, limit)),
             ("ddg-images", partial_ddg(client, query, limit))],
            [("openverse", partial_open(client, query, limit))],
        ]
        for tier in tiers:
            runs = await asyncio.gather(*[_run(name, job) for name, job in tier])
            for name, ok, err, ms in runs:
                if not ok:
                    attempts.append({"provider": name, "ok": False, "error": err, "ms": ms})
            for name, ok, results, ms in runs:
                if ok and results:
                    total = int((time.time() - t0) * 1000)
                    print("[relay] images '%s' via %s -> %d (%dms)"
                          % (query[:60], name, len(results), total), flush=True)
                    return {"results": results, "provider": name,
                            "query": query, "count": len(results), "ms": total}
    raise ImagesFailed("all image providers failed: " + "; ".join(
        a["provider"] + "=" + a["error"] for a in attempts))


def partial_bing(client, query, limit):
    async def job():
        return await _bing_images(client, query, limit)
    return job


def partial_ddg(client, query, limit):
    async def job():
        return await _ddg_images(client, query, limit)
    return job


def partial_open(client, query, limit):
    async def job():
        return await _openverse(client, query, limit)
    return job


async def _run(name, job):
    start = time.time()
    try:
        results = await job()
    except AttemptFail as e:
        return (name, False, str(e), int((time.time() - start) * 1000))
    except Exception as e:
        return (name, False, "error: " + str(e)[:100], int((time.time() - start) * 1000))
    return (name, True, results, int((time.time() - start) * 1000))
