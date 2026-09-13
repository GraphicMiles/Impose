"""Tests for the public demo tier: keyless search + images for visitors,
tight per-IP limits, everything expensive stays behind the control key.
Run: cd backend/relay && python3 -m pytest tests/test_public.py -q
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))  # backend/
os.environ.setdefault("CONTROL_KEY", "test123")
os.environ.setdefault("PUB_SEARCH_LIMIT", "2")

from relay import server  # noqa: E402
from relay.server import app  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

client = TestClient(app)
H = {"Authorization": "Bearer test123"}

FAKE = {"results": [{"title": "t", "url": "https://a.io/", "snippet": "s"}],
        "provider": "test", "query": "q", "count": 1, "ms": 1, "attempts": []}


def _patch_engines(monkeypatch):
    async def fake_search(*a, **k):
        return dict(FAKE)
    async def fake_images(*a, **k):
        return dict(FAKE)
    monkeypatch.setattr(server, "engine_search", fake_search)
    monkeypatch.setattr(server, "engine_images", fake_images)


def test_public_search_needs_no_key(monkeypatch):
    _patch_engines(monkeypatch)
    r = client.post("/v1/search", json={"query": "test"})
    assert r.status_code == 200, r.text
    assert r.json()["results"][0]["url"] == "https://a.io/"


def test_public_images_needs_no_key(monkeypatch):
    _patch_engines(monkeypatch)
    r = client.post("/v1/images", json={"query": "test"})
    assert r.status_code == 200, r.text


def test_owner_key_still_works_and_has_own_bucket(monkeypatch):
    _patch_engines(monkeypatch)
    # the public bucket for this IP is already spent by the tests above;
    # the owner key must not be affected by it
    r = client.post("/v1/search", json={"query": "test"}, headers=H)
    assert r.status_code == 200, r.text


def test_public_limit_is_tight(monkeypatch):
    _patch_engines(monkeypatch)
    # PUB_SEARCH_LIMIT=2 per window; two unauthed calls already happened,
    # so the next unauthed one is over the line (auth failures excluded)
    codes = []
    for _ in range(2):
        codes.append(client.post("/v1/search", json={"query": "test"}).status_code)
    assert 429 in codes


def test_public_tier_can_be_disabled(monkeypatch):
    _patch_engines(monkeypatch)
    monkeypatch.setattr(server, "PUBLIC_TIER", False)
    r = client.post("/v1/search", json={"query": "test"})
    assert r.status_code == 401
    r2 = client.post("/v1/search", json={"query": "test"}, headers=H)
    assert r2.status_code == 200  # the owner is never locked out


def test_private_endpoints_stay_key_only():
    assert client.post("/v1/read", json={"url": "https://x.io/"}).status_code == 401
    assert client.post("/v1/fetch", json={}).status_code == 401
    assert client.get("/admin/status").status_code == 401
