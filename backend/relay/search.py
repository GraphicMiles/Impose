"""Keyless web search for the agent: SearXNG JSON, then Bing HTML, then DDG HTML.

No API keys, no browser. httpx plus BeautifulSoup with the stdlib parser.
SearXNG instances are env-overridable (SEARXNG_URLS, comma separated).
"""
import base64
import os
import time
import urllib.parse
from functools import partial

import httpx
from bs4 import BeautifulSoup

UA = {"User-Agent": ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                     "Chrome/120 Safari/537.36")}

SEARXNG_URLS = [u.strip().rstrip("/") for u in os.environ.get(
    "SEARXNG_URLS",
    "https://search.sethforprivacy.com,https://searx.be,"
    "https://search.inetol.net,https://sx.catgirl.cloud,"
    "https://opnxng.com,https://searx.tiekoetter.com").split(",") if u.strip()]

_FRESH = {"day": "day", "week": "week", "month": "month", "year": "year"}


class AttemptFail(Exception):
    pass


class SearchFailed(Exception):
    def __init__(self, message, attempts):
        super().__init__(message)
        self.attempts = attempts


def _clean(s, cap=300):
    s = " ".join(str(s or "").split())
    return s[:cap]


def _is_http(url):
    try:
        return urllib.parse.urlsplit(url).scheme in ("http", "https")
    except Exception:
        return False


def parse_searxng(data):
    out = []
    for r in (data or {}).get("results", []) or []:
        url = r.get("url", "")
        if not _is_http(url):
            continue
        out.append({"title": _clean(r.get("title", ""), 200) or url,
                    "url": url,
                    "snippet": _clean(r.get("content", "")),
                    "source": _clean(r.get("engine", ""), 60),
                    "publishedAt": r.get("publishedDate") or None})
    return out


def _bing_target(href):
    href = href or ""
    if not href:
        return None
    try:
        parts = urllib.parse.urlsplit(href if "://" in href else "https://x" + href)
    except Exception:
        return None
    q = urllib.parse.parse_qs(parts.query)
    u = (q.get("u") or [""])[0]
    if u.startswith("a1"):
        try:
            pad = "=" * (-len(u[2:]) % 4)
            target = base64.urlsafe_b64decode(u[2:] + pad).decode("utf-8", "ignore")
            if _is_http(target):
                return target
        except Exception:
            pass
    if href.startswith("http") and "bing.com" not in parts.netloc:
        return href
    return None


def parse_bing(html):
    soup = BeautifulSoup(html or "", "html.parser")
    out = []
    for li in soup.select("li.b_algo"):
        a = li.select_one("h2 a[href]")
        if not a:
            continue
        url = _bing_target(a.get("href", ""))
        if not url:
            continue
        title = _clean(a.get_text(" ", strip=True), 200)
        cap = li.select_one(".b_caption p") or li.select_one("p")
        out.append({"title": title or url,
                    "url": url,
                    "snippet": _clean(cap.get_text(" ", strip=True) if cap else ""),
                    "source": "bing",
                    "publishedAt": None})
    return out


def parse_ddg(html):
    soup = BeautifulSoup(html or "", "html.parser")
    out = []
    for div in soup.select(".result"):
        a = div.select_one("a.result__a[href]") or div.select_one("a[href]")
        if not a:
            continue
        href = a.get("href", "")
        if href.startswith("//"):
            href = "https:" + href
        try:
            m = urllib.parse.parse_qs(urllib.parse.urlsplit(href).query)
        except Exception:
            m = {}
        url = None
        if "uddg" in m and m["uddg"]:
            url = m["uddg"][0]
        elif _is_http(href):
            url = href
        if not url or not _is_http(url):
            continue
        snip = div.select_one(".result__snippet")
        out.append({"title": _clean(a.get_text(" ", strip=True), 200) or url,
                    "url": url,
                    "snippet": _clean(snip.get_text(" ", strip=True) if snip else ""),
                    "source": "duckduckgo",
                    "publishedAt": None})
    return out


def _dedup(results):
    seen, out = set(), []
    for r in results:
        key = r["url"].rstrip("/").lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _by_domains(results, domains):
    if not domains:
        return results
    want = [d.strip().lower().lstrip(".") for d in domains if str(d).strip()]
    out = []
    for r in results:
        try:
            host = urllib.parse.urlsplit(r["url"]).netloc.lower()
        except Exception:
            continue
        if any(host == w or host.endswith("." + w) for w in want):
            out.append(r)
    return out


async def _searxng(client, base, query, limit, language, freshness):
    params = {"q": query, "format": "json", "language": language or "en"}
    if freshness in _FRESH:
        params["time_range"] = _FRESH[freshness]
    try:
        r = await client.get(base + "/search", params=params, timeout=10.0)
    except httpx.TimeoutException:
        raise AttemptFail("timed out")
    except Exception:
        raise AttemptFail("unreachable")
    if r.status_code == 429:
        raise AttemptFail("rate limited (429)")
    if r.status_code != 200:
        raise AttemptFail("http " + str(r.status_code))
    try:
        results = parse_searxng(r.json())
    except Exception:
        raise AttemptFail("not JSON (bot wall?)")
    if not results:
        raise AttemptFail("no results")
    return results[:limit]


async def _bing(client, query, limit):
    try:
        r = await client.get("https://www.bing.com/search",
                             params={"q": query, "count": min(limit, 20)},
                             timeout=12.0)
    except httpx.TimeoutException:
        raise AttemptFail("timed out")
    except Exception:
        raise AttemptFail("unreachable")
    if r.status_code != 200:
        raise AttemptFail("http " + str(r.status_code))
    results = parse_bing(r.text)
    if not results:
        raise AttemptFail("no results parsed")
    return results[:limit]


async def _ddg(client, query, limit):
    try:
        r = await client.get("https://html.duckduckgo.com/html/",
                             params={"q": query}, timeout=12.0)
    except httpx.TimeoutException:
        raise AttemptFail("timed out")
    except Exception:
        raise AttemptFail("unreachable")
    if r.status_code != 200:
        raise AttemptFail("http " + str(r.status_code))
    results = parse_ddg(r.text)
    if not results:
        raise AttemptFail("no results parsed")
    return results[:limit]


async def engine_search(query, limit=8, domains=None, freshness=None,
                        language="en", region=None):
    t0 = time.time()
    attempts = []
    async with httpx.AsyncClient(headers=UA, follow_redirects=True,
                                 max_redirects=3) as client:
        jobs = []
        for base in SEARXNG_URLS:
            jobs.append(("searxng:" + base.split("://", 1)[-1],
                         partial(_searxng, client, base, query, limit,
                                 language, freshness)))
        jobs.append(("bing-html", partial(_bing, client, query, limit)))
        jobs.append(("ddg-html", partial(_ddg, client, query, limit)))
        for name, job in jobs:
            start = time.time()
            try:
                results = await job()
                err = "no results" if not results else None
            except AttemptFail as e:
                results, err = None, str(e)
            except Exception as e:
                results, err = None, "error: " + str(e)[:100]
            ms = int((time.time() - start) * 1000)
            if err:
                attempts.append({"provider": name, "ok": False,
                                 "ms": ms, "error": err})
                continue
            results = _by_domains(_dedup(results), domains)[:limit]
            if not results:
                attempts.append({"provider": name, "ok": False,
                                 "ms": ms, "error": "filtered out"})
                continue
            total = int((time.time() - t0) * 1000)
            print("[relay] search '%s' via %s -> %d (%dms)"
                  % (query[:60], name, len(results), total), flush=True)
            return {"results": results, "provider": name,
                    "attempts": attempts, "query": query,
                    "count": len(results), "ms": total}
    raise SearchFailed("all search providers failed: " + "; ".join(
        a["provider"] + "=" + a["error"] for a in attempts), attempts)
