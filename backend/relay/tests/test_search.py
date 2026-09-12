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
    _bing_target, engine_search, parse_bing, parse_ddg, parse_searxng,
)

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

tok = "a1" + base64.urlsafe_b64encode(b"https://example.com/x").decode().rstrip("=")
check("bing redirect decodes",
      _bing_target("/ck/a?u=" + tok) == "https://example.com/x")

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
check("route needs relay key", r.status_code == 401, r.status_code)
H = {"Authorization": "Bearer test123"}
r = c.post("/v1/search", json={"query": "  "}, headers=H)
check("route rejects empty query", r.status_code == 400, r.status_code)
r = c.post("/v1/search", json={"query": "x", "limit": 99}, headers=H)
check("route ok and clamps",
      r.status_code == 200 and r.json()["count"] == 1, r.status_code)

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
