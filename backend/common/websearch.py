"""Web search with a keyless default and optional keyed providers.

SEARCH_PROVIDERS lists backends in try order. The first configured backend
that returns results wins:

  tavily      needs TAVILY_API_KEY. AI focused, best snippets.
  brave       needs BRAVE_API_KEY. General web index.
  serper      needs SERPER_API_KEY. Google results as JSON.
  duckduckgo  no key. Best effort HTML parsing, can be rate limited.
  wikipedia   no key. Reliable fallback for factual queries.

Both servers return this shape verbatim:
  {"query": ..., "provider": ..., "results": [{"title", "url", "snippet"}]}

provider is "" when nothing answered. count is clamped to 1..10.
"""

import html as _html
import os
import re
from html.parser import HTMLParser
from urllib.parse import parse_qs, quote, urlparse

import httpx

UA = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}

BACKENDS = ("tavily", "brave", "serper", "duckduckgo", "wikipedia")


def _clip(text, n=300):
    text = re.sub(r"\s+", " ", str(text or "")).strip()
    return text if len(text) <= n else text[:n].rstrip() + "..."


class _DDGParser(HTMLParser):
    """Pairs result__a titles with result__snippet bodies, in order."""

    def __init__(self):
        super().__init__()
        self.titles = []  # (href, text)
        self.snippets = []
        self._capture = None
        self._href = ""
        self._buf = []

    def handle_starttag(self, tag, attrs):
        if tag != "a":
            return
        cls, href = "", ""
        for k, v in attrs:
            if k == "class":
                cls = v or ""
            elif k == "href":
                href = v or ""
        if "result__a" in cls:
            self._capture = "title"
            self._href = href
            self._buf = []
        elif "result__snippet" in cls:
            self._capture = "snippet"
            self._buf = []

    def handle_data(self, data):
        if self._capture:
            self._buf.append(data)

    def handle_endtag(self, tag):
        if tag != "a" or not self._capture:
            return
        text = _html.unescape("".join(self._buf)).strip()
        if self._capture == "title":
            self.titles.append((self._href, text))
        else:
            self.snippets.append(text)
        self._capture = None


def _unwrap_ddg(href):
    try:
        if href.startswith("//"):
            href = "https:" + href
        if "duckduckgo.com/l/" in href:
            q = parse_qs(urlparse(href).query)
            if q.get("uddg"):
                return q["uddg"][0]
        return href
    except Exception:
        return href


def _search_duckduckgo(query, count):
    r = httpx.get("https://html.duckduckgo.com/html/", params={"q": query},
                  headers=UA, timeout=12.0, follow_redirects=True)
    if r.status_code != 200:
        return []
    p = _DDGParser()
    p.feed(r.text)
    out = []
    for i, (href, title) in enumerate(p.titles):
        url = _unwrap_ddg(href)
        if not title or not url.startswith("http"):
            continue
        snippet = p.snippets[i] if i < len(p.snippets) else ""
        out.append({"title": _clip(title, 160), "url": url, "snippet": _clip(snippet)})
        if len(out) >= count:
            break
    return out


def _search_wikipedia(query, count):
    r = httpx.get("https://en.wikipedia.org/w/api.php", params={
        "action": "query", "list": "search", "srsearch": query,
        "srlimit": count, "format": "json",
    }, headers=UA, timeout=12.0)
    if r.status_code != 200:
        return []
    out = []
    for hit in r.json().get("query", {}).get("search", [])[:count]:
        title = hit.get("title", "")
        if not title:
            continue
        snippet = re.sub(r"<[^>]+>", "", hit.get("snippet", ""))
        out.append({
            "title": title,
            "url": "https://en.wikipedia.org/wiki/" + quote(title.replace(" ", "_")),
            "snippet": _clip(snippet),
        })
    return out


def _search_tavily(query, count, key):
    r = httpx.post("https://api.tavily.com/search", json={
        "api_key": key, "query": query,
        "max_results": max(1, min(count, 10)),
        "include_answer": False, "include_raw_content": False,
    }, timeout=20.0)
    if r.status_code != 200:
        return []
    out = []
    for item in r.json().get("results", [])[:count]:
        if not item.get("url"):
            continue
        out.append({
            "title": _clip(item.get("title", ""), 160) or item["url"],
            "url": item["url"],
            "snippet": _clip(item.get("content", "")),
        })
    return out


def _search_brave(query, count, key):
    r = httpx.get("https://api.search.brave.com/res/v1/web/search",
                  params={"q": query, "count": max(1, min(count, 10))},
                  headers={"X-Subscription-Token": key, "Accept": "application/json"},
                  timeout=15.0)
    if r.status_code != 200:
        return []
    out = []
    for item in (r.json().get("web", {}).get("results", []) or [])[:count]:
        if not item.get("url"):
            continue
        out.append({
            "title": _clip(item.get("title", ""), 160) or item["url"],
            "url": item["url"],
            "snippet": _clip(item.get("description", "")),
        })
    return out


def _search_serper(query, count, key):
    r = httpx.post("https://google.serper.dev/search",
                   json={"q": query, "num": max(1, min(count, 10))},
                   headers={"X-API-KEY": key, "Content-Type": "application/json"},
                   timeout=15.0)
    if r.status_code != 200:
        return []
    out = []
    for item in r.json().get("organic", [])[:count]:
        if not item.get("link"):
            continue
        out.append({
            "title": _clip(item.get("title", ""), 160) or item["link"],
            "url": item["link"],
            "snippet": _clip(item.get("snippet", "")),
        })
    return out


KEYED = {
    "tavily": ("TAVILY_API_KEY", _search_tavily),
    "brave": ("BRAVE_API_KEY", _search_brave),
    "serper": ("SERPER_API_KEY", _search_serper),
}
FREE = {
    "duckduckgo": _search_duckduckgo,
    "wikipedia": _search_wikipedia,
}


def configured_chain(env=None):
    raw = ((env or os.environ).get("SEARCH_PROVIDERS") or "duckduckgo,wikipedia").lower()
    chain = [p.strip() for p in raw.split(",") if p.strip() in BACKENDS]
    return chain or ["duckduckgo", "wikipedia"]


def web_search(query, count=5, env=None):
    """Returns (provider_name, results). provider_name is "" when nothing answered."""
    env = env or os.environ
    try:
        count = max(1, min(int(count or 5), 10))
    except (TypeError, ValueError):
        count = 5
    query = str(query or "").strip()
    if not query:
        return "", []
    for name in configured_chain(env):
        try:
            if name in KEYED:
                key_env, fn = KEYED[name]
                key = (env.get(key_env) or "").strip()
                if not key:
                    continue
                results = fn(query, count, key)
            else:
                results = FREE[name](query, count)
        except Exception:
            continue
        if results:
            return name, results
    return "", []
