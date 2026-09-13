"""Tests for the /v1/read page reader: extraction is pure, endpoint is guarded.
Run: cd backend/relay && python3 -m pytest tests/test_read.py -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))  # backend/
os.environ.setdefault("CONTROL_KEY", "test123")

from relay import server  # noqa: E402
from relay.server import app, html_to_text  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app)
H = {"Authorization": "Bearer test123"}

PAGE = """<html><head><title>Best Jollof Guide</title>
<style>.x{color:red}</style><script>var tracker = 1;</script></head>
<body><nav>Menu Menu Menu</nav>
<article><h1>Jollof</h1><p>Smoke first, then rice.</p>
<p>Second paragraph with <b>bold</b> words.</p></article>
<footer>Unsubscribe</footer></body></html>"""


def test_html_to_text_extracts_readable_text():
    out = html_to_text(PAGE)
    assert out["title"] == "Best Jollof Guide"
    assert "Smoke first, then rice." in out["text"]
    assert "Second paragraph with bold words." in out["text"]
    # scripts and styles are gone
    assert "tracker" not in out["text"]
    assert "color:red" not in out["text"]


def test_html_to_text_caps_length():
    blob = "<html><body><p>" + ("word " * 20000) + "</p></body></html>"
    out = html_to_text(blob, cap=500)
    assert len(out["text"]) <= 510
    assert out["text"].endswith("...")


def test_html_to_text_prunes_chrome_keeps_article():
    out = html_to_text(PAGE)
    assert "Menu" not in out["text"]          # nav gone
    assert "Unsubscribe" not in out["text"]   # footer gone
    assert "Jollof" in out["text"]


def test_html_to_text_refs_meta_images():
    page = """<html><head><title>T</title>
    <meta property="og:image" content="https://c.test/cover.jpg">
    <meta property="article:published_time" content="2026-01-05T10:00:00Z">
    <meta name="author" content="A. Writer">
    <script type="application/ld+json">{"author":{"name":"LD Author"},"datePublished":"2026-02-02"}</script>
    </head><body><nav class="menu"><a href="/m">Menu link</a></nav>
    <article><p>Real content lives here with plenty of words to pass the floor threshold easily.</p>
    <a href="/related">A related story</a>
    <a href="https://ext.test/page">External page</a>
    <img src="/img/inline.jpg" alt="an inline photo" width="640">
    <img srcset="/small.jpg 300w, /big.jpg 1200w" alt="responsive">
    <img src="/x/icon.png" alt="junk icon">
    <img src="data:image/gif;base64,R0=">
    </article><footer>foot</footer></body></html>"""
    out = html_to_text(page, base_url="https://c.test/post/1")
    assert "Menu link" not in out["text"] and "foot" not in out["text"]
    assert "Real content" in out["text"]
    titles = [r["title"] for r in out["refs"]]
    assert "A related story" in titles and "External page" in titles
    assert out["refs"][0]["url"].startswith("https://c.test/")
    assert out["meta"]["author"] in ("A. Writer", "LD Author")
    assert out["meta"]["date"].startswith(("2026-01-05", "2026-02-02"))
    urls = [i["image"] for i in out["images"]]
    assert any(u.endswith("cover.jpg") for u in urls)
    assert any(u.endswith("inline.jpg") for u in urls)
    assert any(u.endswith("big.jpg") for u in urls)      # srcset picked the widest
    assert not any("icon" in u for u in urls)
    assert not any(u.startswith("data:") for u in urls)


def test_html_to_text_never_loses_document_to_feature_flags():
    page = """<html class="client-nojs vector-feature-main-menu-pinned-disabled">
    <body><article><p>Survivor text about a subject with enough words here.</p></article></body></html>"""
    out = html_to_text(page)
    assert "Survivor text" in out["text"]


def test_read_response_shape():
    class FakeResp:
        status_code = 200
        headers = {"content-type": "text/html"}
        text = PAGE
        content = PAGE.encode()
    # pure-function shape is what the endpoint spreads out
    out = html_to_text(PAGE)
    assert set(out) == {"title", "text", "meta", "refs", "images"}


def test_read_requires_auth():
    assert client.post("/v1/read", json={"url": "https://example.com/"}).status_code == 401


def test_read_validates_url():
    assert client.post("/v1/read", headers=H, json={"url": "ftp://x/"}).status_code == 400
    assert client.post("/v1/read", headers=H, json={"url": "not a url"}).status_code == 400
    r = client.post("/v1/read", headers=H, json={"url": "http://127.0.0.1:9000/secret"})
    assert r.status_code == 400
    assert "private" in r.json()["detail"]


def test_read_requires_url_key():
    r = client.post("/v1/read", headers=H, json={})
    assert r.status_code == 400


def test_read_bad_json_is_400():
    r = client.post("/v1/read", headers=H, content=b"{nope")
    assert r.status_code == 400


def test_read_follows_relative_redirects_and_uses_cache(monkeypatch):
    page = ("<html><head><title>Final</title></head><body><article>"
            "<p>Enough final page content to extract normally after a relative redirect.</p>"
            "<a href='child'>Child page</a></article></body></html>")

    class FakeResponse:
        def __init__(self, status, headers, text=""):
            self.status_code = status
            self.headers = headers
            self.text = text
            self.content = text.encode()

    responses = [
        FakeResponse(302, {"location": "/new/final", "content-type": "text/html"}),
        FakeResponse(200, {"content-type": "text/html"}, page),
    ]

    class FakeClient:
        def __init__(self, *args, **kwargs):
            self.calls = []
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            return False
        async def get(self, url, **kwargs):
            self.calls.append(url)
            return responses.pop(0)

    fake = FakeClient()
    resolved = []
    def resolve(host):
        resolved.append(host)
        return ["203.0.113.9"]
    monkeypatch.setattr(server, "_resolve_public_ips", resolve)
    monkeypatch.setattr(server.httpx, "AsyncClient", lambda *a, **k: fake)
    server._CACHE.clear()
    requested = "https://example.com/old/start"

    r = client.post("/v1/read", headers=H, json={"url": requested})
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["url"] == "https://example.com/new/final"
    assert data["refs"][0]["url"] == "https://example.com/new/child"
    assert len(fake.calls) == 2
    resolved_before_cache = len(resolved)

    # A second read must return the memo before DNS or network access.
    r2 = client.post("/v1/read", headers=H, json={"url": requested})
    assert r2.status_code == 200
    assert len(fake.calls) == 2
    assert len(resolved) == resolved_before_cache
