"""Tests for the /v1/read page reader: extraction is pure, endpoint is guarded.
Run: cd backend/relay && python3 -m pytest tests/test_read.py -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))  # backend/
os.environ.setdefault("CONTROL_KEY", "test123")

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
