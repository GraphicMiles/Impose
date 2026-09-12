"""Relay image search tests. Parsers are hard gates; the live engine run at
the end is informational (sandbox IPs are often walled).

Run from the repo root:  python3 backend/relay/tests/test_images.py
"""
import asyncio
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2]))
os.environ.setdefault("CONTROL_KEY", "test123")

from relay.images import (  # noqa: E402
    parse_bing_images, parse_ddg_images, parse_openverse, engine_images,
)
import relay.images as images_mod  # noqa: E402


def check(name, cond, extra=""):
    print(("PASS: " if cond else "FAIL: ") + name
          + (" " + str(extra) if extra != "" else ""))
    if not cond:
        raise SystemExit("FAILED: " + name)


BING_HTML = """
<div>
<a class="iusc" m="{&quot;murl&quot;:&quot;https://pics.test/cat.jpg&quot;,&quot;turl&quot;:&quot;https://thb.test/cat_t.jpg&quot;,&quot;purl&quot;:&quot;https://pages.test/cats&quot;,&quot;t&quot;:&quot;a tabby cat&quot;,&quot;mw&quot;:800,&quot;mh&quot;:600}" href="#"><div class="img"></div></a>
<a class="iusc" m="not json at all" href="#"></a>
<a class="iusc" m="{&quot;murl&quot;:&quot;javascript:alert(1)&quot;}" href="#"></a>
<a class="iusc" m="{&quot;murl&quot;:&quot;https://pics.test/dog.png&quot;}" href="#"></a>
</div>
"""

DDG_JSON = {"results": [
    {"image": "https://pics.test/one.jpg", "thumbnail": "https://thb.test/one.jpg",
     "url": "https://pages.test/one", "title": "one", "width": 640, "height": 480},
    {"image": "ftp://bad/x.jpg", "title": "bad scheme"},
    {"image": "https://pics.test/two.jpg", "title": "two"},
]}

OPENVERSE_JSON = {"results": [
    {"title": "wiki cat", "url": "https://upload.wikimedia.org/cat.jpg",
     "thumbnail": "https://api.openverse.org/v1/images/abc/thumb/",
     "foreign_landing_url": "https://commons.wikimedia.org/page", "source": "wikimedia",
     "width": 900, "height": 700},
]}


def main():
    bing = parse_bing_images(BING_HTML)
    check("bing parses 2 rows", len(bing) == 2, len(bing))
    check("bing full fields", bing[0]["image"] == "https://pics.test/cat.jpg"
          and bing[0]["thumb"] == "https://thb.test/cat_t.jpg"
          and bing[0]["page"] == "https://pages.test/cats"
          and bing[0]["w"] == 800 and bing[0]["h"] == 600, bing[0])
    check("bing domain", bing[0]["source"] == "pages.test", bing[0]["source"])
    check("bing bad scheme dropped", all(r["image"].startswith("https://") for r in bing))

    ddg = parse_ddg_images(DDG_JSON)
    check("ddg drops bad scheme", len(ddg) == 2, len(ddg))
    check("ddg dims", ddg[0]["w"] == 640 and ddg[0]["h"] == 480)

    ov = parse_openverse(OPENVERSE_JSON)
    check("openverse row", len(ov) == 1 and ov[0]["source"] == "wikimedia", ov)
    check("openverse thumb", ov[0]["thumb"].startswith("https://api.openverse.org/"))

    # live engine run: informational only, sandbox IPs are often challenged
    async def live():
        try:
            out = await engine_images("mark rober", limit=4)
            print("INFO live images:", out["provider"], out["count"], "results")
        except Exception as e:
            print("INFO live images unavailable (fine here):", str(e)[:90])
    asyncio.get_event_loop().run_until_complete(live()) if sys.version_info < (3, 10) \
        else asyncio.run(live())

    print("image parser tests passed")


if __name__ == "__main__":
    main()
