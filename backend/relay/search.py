"""Keyless web search for the agent: SearXNG JSON, then Bing and DDG Lite.

No API keys, no browser. httpx plus BeautifulSoup with the stdlib parser.
SearXNG instances are env-overridable (SEARXNG_URLS, comma separated).

Providers race concurrently inside each tier, and no result set wins
without validation: the SearXNG query echo must match, and at least one
result must share significant terms with the query. A tier that answers
with nothing relevant yields empty results so the agent can fail closed;
SearchFailed is reserved for a true outage where nobody answered at all.
"""
import asyncio
import base64
import os
import re
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
    def __init__(self, message, answered=False):
        super().__init__(message)
        self.answered = answered


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


def _is_external_source(url):
    """Reject search-engine navigation URLs, including decoded Bing targets."""
    if not _is_http(url):
        return False
    try:
        host = (urllib.parse.urlsplit(url).hostname or "").lower()
    except Exception:
        return False
    return host != "bing.com" and not host.endswith(".bing.com")


def parse_searxng(data):
    out = []
    for r in (data or {}).get("results", []) or []:
        url = r.get("url", "")
        if not _is_external_source(url):
            continue
        out.append({"title": _clean(r.get("title", ""), 200) or url,
                    "url": url,
                    "snippet": _clean(r.get("content", "")),
                    "source": _clean(r.get("engine", ""), 60),
                    "publishedAt": r.get("publishedDate") or None})
    return out


_STOP = set("""
about after again all also an and any are as at been before between both but
by can could define definition did do does doing each explained few for from
further had has have here how into is more most online other over own same
should some such than that the their then there these this those through too
under very was were what whats when where which who whom whose why will with
would versus vs best top review reviews price buy cheap free near new
""".split())


def _significant(query):
    toks = re.findall(r"[a-z0-9]{4,}|[一-鿿]{2,}", str(query or "").lower())
    return [t for t in toks if t not in _STOP]


def _relevance_url(url):
    """URL host/path may be topical; a search query string is never evidence."""
    try:
        parts = urllib.parse.urlsplit(str(url or ""))
        return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    except Exception:
        return ""


def _filter_relevant(results, query):
    """Keep only individually relevant results, not a whole noisy result set.

    Multiple-word searches need at least two distinct query terms. This stops
    one generic word in a navigation-page snippet from making every result
    look relevant.
    """
    toks = list(dict.fromkeys(_significant(query)))
    if not toks:
        return list(results or [])
    required = 1 if len(toks) == 1 else 2
    out = []
    for result in results or []:
        blob = " ".join([result.get("title", ""), result.get("snippet", ""),
                         _relevance_url(result.get("url", ""))]).lower()
        matches = sum(bool(re.search(r"\b" + re.escape(token) + r"\b", blob))
                      for token in toks)
        if matches >= required:
            out.append(result)
    return out


def _relevant(results, query):
    return bool(_filter_relevant(results, query))


def _norm_q(s):
    return " ".join(str(s or "").lower().split())


def select_searxng(data, query):
    """Validate one SearXNG JSON payload: a mismatched query echo means
    the instance answered somebody else's search."""
    echo = (data or {}).get("query")
    if echo and _norm_q(echo) != _norm_q(query):
        raise AttemptFail("answered a different query", answered=True)
    results = parse_searxng(data)
    if not results:
        raise AttemptFail("no results", answered=True)
    return results


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
            if _is_external_source(target):
                return target
        except Exception:
            pass
    if href.startswith("http") and _is_external_source(href):
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


def _ddg_target(href):
    href = str(href or "")
    if href.startswith("//"):
        href = "https:" + href
    try:
        params = urllib.parse.parse_qs(urllib.parse.urlsplit(href).query)
    except Exception:
        params = {}
    target = (params.get("uddg") or [""])[0] or href
    return target if _is_external_source(target) else None


def parse_ddg(html):
    """Parse both DuckDuckGo's full HTML and its lighter, more reliable UI."""
    soup = BeautifulSoup(html or "", "html.parser")
    out = []
    full = soup.select(".result")
    if full:
        nodes = [(div.select_one("a.result__a[href]") or div.select_one("a[href]"),
                  div.select_one(".result__snippet"), None) for div in full]
    else:
        nodes = []
        for anchor in soup.select("a.result-link[href]"):
            row = anchor.find_parent("tr")
            snippet_row = row.find_next_sibling("tr") if row else None
            snippet = snippet_row.select_one(".result-snippet") if snippet_row else None
            stamp_row = snippet_row.find_next_sibling("tr") if snippet_row else None
            stamp = stamp_row.select_one(".timestamp") if stamp_row else None
            nodes.append((anchor, snippet, stamp))
    for anchor, snippet, stamp in nodes:
        if not anchor:
            continue
        url = _ddg_target(anchor.get("href", ""))
        if not url:
            continue
        out.append({"title": _clean(anchor.get_text(" ", strip=True), 200) or url,
                    "url": url,
                    "snippet": _clean(snippet.get_text(" ", strip=True) if snippet else ""),
                    "source": "duckduckgo",
                    "publishedAt": _clean(stamp.get_text(" ", strip=True), 60) if stamp else None})
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
        r = await client.get(base + "/search", params=params, timeout=8.0)
    except httpx.TimeoutException:
        raise AttemptFail("timed out")
    except Exception:
        raise AttemptFail("unreachable")
    if r.status_code == 429:
        raise AttemptFail("rate limited (429)")
    if r.status_code != 200:
        raise AttemptFail("http " + str(r.status_code))
    try:
        results = select_searxng(r.json(), query)
    except AttemptFail:
        raise
    except Exception:
        raise AttemptFail("not JSON (bot wall?)")
    results = _filter_relevant(results, query)
    if not results:
        raise AttemptFail("off topic results", answered=True)
    return results[:limit]


async def _bing(client, query, limit):
    try:
        r = await client.get("https://www.bing.com/search",
                             params={"q": query, "count": min(limit, 20)},
                             timeout=10.0)
    except httpx.TimeoutException:
        raise AttemptFail("timed out")
    except Exception:
        raise AttemptFail("unreachable")
    if r.status_code != 200:
        raise AttemptFail("http " + str(r.status_code))
    results = parse_bing(r.text)
    if not results:
        raise AttemptFail("no results parsed", answered=True)
    results = _filter_relevant(results, query)
    if not results:
        raise AttemptFail("off topic results", answered=True)
    return results[:limit]


async def _ddg(client, query, limit):
    try:
        # The lite endpoint is server-rendered, quick, and substantially less
        # prone to bot-wall timeouts than html.duckduckgo.com.
        r = await client.get("https://lite.duckduckgo.com/lite/",
                             params={"q": query}, timeout=8.0)
    except httpx.TimeoutException:
        raise AttemptFail("timed out")
    except Exception:
        raise AttemptFail("unreachable")
    if r.status_code != 200:
        raise AttemptFail("http " + str(r.status_code))
    results = parse_ddg(r.text)
    if not results:
        raise AttemptFail("no results parsed", answered=True)
    results = _filter_relevant(results, query)
    if not results:
        raise AttemptFail("off topic results", answered=True)
    return results[:limit]


async def _run_job(name, job):
    start = time.time()
    try:
        results = await job()
    except AttemptFail as e:
        return {"provider": name, "results": None, "error": str(e),
                "answered": e.answered,
                "ms": int((time.time() - start) * 1000)}
    except Exception as e:
        return {"provider": name, "results": None,
                "error": "error: " + str(e)[:100], "answered": False,
                "ms": int((time.time() - start) * 1000)}
    ms = int((time.time() - start) * 1000)
    if not results:
        return {"provider": name, "results": None, "error": "no results",
                "answered": True, "ms": ms}
    return {"provider": name, "results": results, "error": None,
            "answered": False, "ms": ms}


async def engine_search(query, limit=8, domains=None, freshness=None,
                        language="en", region=None):
    t0 = time.time()
    attempts = []
    answered_any = False
    async with httpx.AsyncClient(headers=UA, follow_redirects=True,
                                 max_redirects=3) as client:
        tiers = [
            [("searxng:" + base.split("://", 1)[-1],
              partial(_searxng, client, base, query, limit,
                      language, freshness))
             for base in SEARXNG_URLS],
            [("bing-html", partial(_bing, client, query, limit)),
             ("ddg-lite", partial(_ddg, client, query, limit))],
        ]
        for tier in tiers:
            runs = await asyncio.gather(*[_run_job(n, j) for n, j in tier])
            for run in runs:
                if run["answered"]:
                    answered_any = True
                if run["error"]:
                    attempts.append({"provider": run["provider"], "ok": False,
                                     "ms": run["ms"], "error": run["error"]})
            for run in runs:
                if run["error"]:
                    continue
                results = _by_domains(_dedup(run["results"]), domains)[:limit]
                if not results:
                    attempts.append({"provider": run["provider"], "ok": False,
                                     "ms": run["ms"], "error": "filtered out"})
                    answered_any = True
                    continue
                total = int((time.time() - t0) * 1000)
                print("[relay] search '%s' via %s -> %d (%dms)"
                      % (query[:60], run["provider"], len(results), total),
                      flush=True)
                return {"results": results, "provider": run["provider"],
                        "attempts": attempts, "query": query,
                        "count": len(results), "ms": total}
    if answered_any:
        total = int((time.time() - t0) * 1000)
        print("[relay] search '%s' -> nothing relevant (%dms)"
              % (query[:60], total), flush=True)
        return {"results": [], "provider": "", "attempts": attempts,
                "query": query, "count": 0, "ms": total}
    raise SearchFailed("all search providers failed: " + "; ".join(
        a["provider"] + "=" + a["error"] for a in attempts), attempts)
