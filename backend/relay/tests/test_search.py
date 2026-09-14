"""Relay search tests. Parse and route tests are hard gates; the live
engine run at the end is informational (sandbox IPs are often walled).

Run from anywhere:  python3 backend/relay/tests/test_search.py
"""
import asyncio
import base64
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2]))
os.environ.setdefault("CONTROL_KEY", "test123")

from relay.search import (  # noqa: E402
    _bing_target, _filter_relevant, _relevant, AttemptFail, engine_search, parse_bing,
    parse_ddg, parse_searxng, SearchFailed, select_searxng,
)
import relay.search as search_mod  # noqa: E402

FIX = HERE.parent / "fixtures"


def check(name, cond, extra=""):
    print(("PASS: " if cond else "FAIL: ") + name
          + (" " + str(extra) if extra != "" else ""))
    if not cond:
        raise SystemExit("FAILED: " + name)


b = parse_bing((FIX / "bing.html").read_text(encoding="utf-8", errors="ignore"))
check("bing parses results", len(b) >= 5, len(b))
check("bing urls are http", all(x["url"].startswith("http") for x in b))
check("bing titles present", all(x["title"] for x in b))

s = parse_searxng(json.loads((FIX / "searxng.json").read_text()))
check("searxng parses", len(s) == 2 and s[0]["source"] == "google", len(s))

d = parse_ddg((FIX / "ddg.html").read_text())
check("ddg parses and unwraps uddg",
      len(d) == 2 and d[0]["url"] == "https://example.com/phones", len(d))
lite = parse_ddg('''<table><tr><td><a class="result-link"
 href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fiphone">Best iPhone</a></td></tr>
 <tr><td class="result-snippet">Current prices in Nigeria</td></tr>
 <tr><td><span class="timestamp">2026-09-01</span></td></tr></table>''')
check("ddg lite parses results, snippets, and dates",
      len(lite) == 1 and lite[0]["url"] == "https://example.com/iphone"
      and lite[0]["publishedAt"] == "2026-09-01", lite)

tok = "a1" + base64.urlsafe_b64encode(b"https://example.com/x").decode().rstrip("=")
check("bing redirect decodes",
      _bing_target("/ck/a?u=" + tok) == "https://example.com/x")
internal_tok = "a1" + base64.urlsafe_b64encode(
    b"https://www.bing.com/search?q=Iceking+Ochacho").decode().rstrip("=")
check("decoded bing navigation target is rejected",
      _bing_target("/ck/a?u=" + internal_tok) is None)
noisy = [
    {"title": "Bing Homepage Quiz",
     "url": "https://bingquiz.example/?q=Iceking+Ochacho+No+Competition",
     "snippet": "Play music trivia and daily quizzes"},
    {"title": "Iceking Ochacho No Competition", "url": "https://music.example/no-competition",
     "snippet": "Iceking Ochacho single"},
]
filtered = _filter_relevant(noisy, "Iceking Ochacho No Competition")
check("relevance removes individual navigation noise",
      len(filtered) == 1 and filtered[0]["url"].startswith("https://music.example"))

from fastapi.testclient import TestClient  # noqa: E402
import relay.server as srv  # noqa: E402


async def fake_search(query, limit=8, domains=None, freshness=None,
                      language="en", region=None):
    return {"results": [{"title": "T", "url": "https://example.com/",
                         "snippet": "S", "source": "fake",
                         "publishedAt": None}],
            "provider": "fake", "attempts": [], "query": query,
            "count": 1, "ms": 1}


srv.engine_search = fake_search
c = TestClient(srv.app)
r = c.post("/v1/search", json={"query": "x"})
check("keyless search serves the public tier", r.status_code == 200, r.status_code)
H = {"Authorization": "Bearer test123"}
r = c.post("/v1/search", json={"query": "  "}, headers=H)
check("route rejects empty query", r.status_code == 400, r.status_code)
r = c.post("/v1/search", json={"query": "x", "limit": 99}, headers=H)
check("route ok and clamps",
      r.status_code == 200 and r.json()["count"] == 1, r.status_code)

mma = [{"title": "Method of moving asymptotes - Wikipedia",
        "url": "https://en.wikipedia.org/wiki/MMA",
        "snippet": "an optimization algorithm"}]
check("relevance gates wrong-query sets",
      _relevant(mma, "kortyeo identity and biography") is False)
check("relevance passes topical sets",
      _relevant([{"title": "Korty EO Biography",
                  "url": "https://kortyeo.com/about-me",
                  "snippet": "youtuber and filmmaker"}],
                "kortyeo identity and biography") is True)
check("relevance skips judgeless queries",
      _relevant(mma, "a b c") is True)

try:
    select_searxng({"query": "method of moving asymptotes",
                    "results": [{"url": "https://x.io/", "title": "t"}]},
                   "kortyeo identity and biography")
    check("echo mismatch rejected", False)
except AttemptFail as e:
    check("echo mismatch rejected", "different query" in str(e))
ok = select_searxng(
    {"query": "kortyeo identity and biography",
     "results": [{"url": "https://x.io/", "title": "t",
                  "content": "c", "engine": "e"}]},
    "kortyeo identity and biography")
check("echo match parsed", len(ok) == 1 and ok[0]["source"] == "e")


async def _sx_gated(client, base, query, limit, language, freshness):
    raise AttemptFail("off topic results", answered=True)


async def _sx_empty(client, base, query, limit, language, freshness):
    raise AttemptFail("no results", answered=True)


async def _sx_down(client, base, query, limit, language, freshness):
    raise AttemptFail("timed out")


async def _bing_good(client, query, limit):
    return [{"title": "Korty EO", "url": "https://kortyeo.com/",
             "snippet": "s", "source": "bing", "publishedAt": None}]


async def _scrape_empty(client, query, limit):
    raise AttemptFail("no results parsed", answered=True)


async def _scrape_down(client, query, limit):
    raise AttemptFail("unreachable")


_real = (search_mod._searxng, search_mod._bing, search_mod._ddg,
         search_mod.SEARXNG_URLS)
search_mod.SEARXNG_URLS = ["https://one.example", "https://two.example"]
search_mod._searxng, search_mod._bing, search_mod._ddg = (
    _sx_gated, _bing_good, _scrape_down)
out = asyncio.run(engine_search("kortyeo", limit=5))
check("failover skips gated tier", out["provider"] == "bing-html",
      out["provider"])
check("failover keeps attempts",
      any(not a["ok"] for a in out["attempts"]))
search_mod._searxng, search_mod._bing, search_mod._ddg = (
    _sx_empty, _scrape_empty, _scrape_empty)
out = asyncio.run(engine_search("kortyeo", limit=5))
check("answered misses return empty, not error",
      out["results"] == [] and out["provider"] == "")
search_mod._searxng, search_mod._bing, search_mod._ddg = (
    _sx_down, _scrape_down, _scrape_down)
try:
    asyncio.run(engine_search("kortyeo", limit=5))
    check("true outage still raises", False)
except SearchFailed:
    check("true outage still raises", True)
(search_mod._searxng, search_mod._bing, search_mod._ddg,
 search_mod.SEARXNG_URLS) = _real

if os.environ.get("RUN_LIVE", "1") == "1":
    try:
        out = asyncio.run(engine_search("best gaming phones under 300000 naira",
                                        limit=5))
        print("LIVE: provider=%s count=%s ms=%s"
              % (out["provider"], out["count"], out["ms"]))
        for x in out["results"][:3]:
            print("LIVE: -", x["title"][:70], "|", x["url"][:60])
    except Exception as e:
        print("LIVE FAIL (informational):", str(e)[:300])
print("ALL SEARCH TESTS PASS")
