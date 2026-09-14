"""Tests for the public demo tier: keyless search + images for visitors,
tight per-IP limits, everything expensive stays behind the control key.
Run: cd backend/relay && python3 -m pytest tests/test_public.py -q
"""
import asyncio
import io
import os
import sys

from PIL import Image

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
    async def fake_videos(*a, **k):
        return {"results": [{"title": "v", "url": "https://www.youtube.com/watch?v=gTKS8SAwUzE",
                             "platform": "youtube", "kind": "youtube-video", "id": "gTKS8SAwUzE"}],
                "provider": "test", "query": "q", "count": 1}
    monkeypatch.setattr(server, "engine_search", fake_search)
    monkeypatch.setattr(server, "engine_images", fake_images)
    monkeypatch.setattr(server, "engine_videos", fake_videos)


def test_public_search_needs_no_key(monkeypatch):
    _patch_engines(monkeypatch)
    r = client.post("/v1/search", json={"query": "test"})
    assert r.status_code == 200, r.text
    assert r.json()["results"][0]["url"] == "https://a.io/"


def test_public_images_needs_no_key(monkeypatch):
    _patch_engines(monkeypatch)
    r = client.post("/v1/images", json={"query": "test"})
    assert r.status_code == 200, r.text


def test_public_videos_need_no_key(monkeypatch):
    _patch_engines(monkeypatch)
    r = client.post("/v1/videos", json={"query": "latest MrBeast video"})
    assert r.status_code == 200, r.text
    assert r.json()["results"][0]["kind"] == "youtube-video"


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


def test_health_does_not_wait_for_optional_gateway(monkeypatch):
    def should_not_probe(*args, **kwargs):
        raise AssertionError("relay health must not probe the optional gateway")

    monkeypatch.setattr(server, "gateway_reachable", should_not_probe)
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["service"] == "impose-relay"
    assert r.headers["access-control-allow-origin"] == "*"
    assert r.headers["cache-control"] == "no-store"


def test_health_is_cors_readable_from_local_and_portable_clients():
    r = client.get("/health", headers={"Origin": "http://127.0.0.1:4173"})
    assert r.status_code == 200
    assert r.headers["access-control-allow-origin"] == "*"


def test_admin_status_explains_missing_gateway_and_disabled_wake(monkeypatch):
    monkeypatch.setattr(server, "GATEWAY_URL", "")
    monkeypatch.setattr(server, "WAKE_STUDIO", False)
    r = client.get("/admin/status", headers=H)
    assert r.status_code == 200
    data = r.json()
    assert data["gateway_up"] is False
    assert data["gateway_configured"] is False
    assert data["wake_configured"] is False
    assert "LLM_GATEWAY_URL" in data["note"]


def test_manual_wake_is_an_error_when_disabled(monkeypatch):
    monkeypatch.setattr(server, "GATEWAY_URL", "https://gateway.test")
    monkeypatch.setattr(server, "WAKE_STUDIO", False)
    monkeypatch.setattr(server, "gateway_reachable", lambda force=False: False)
    r = client.post("/admin/wake-llm?background=1", headers=H)
    assert r.status_code == 409
    assert "disabled" in r.json()["detail"].lower()


def test_gateway_probe_rejects_unrelated_http_pages(monkeypatch):
    class FakeResponse:
        status_code = 200
        def json(self):
            return {"ok": True, "service": "not-the-gateway"}

    monkeypatch.setattr(server, "GATEWAY_URL", "https://gateway.test")
    monkeypatch.setattr(server.httpx, "get", lambda *a, **k: FakeResponse())
    assert server.gateway_reachable(force=True) is False
    assert "unexpected" in server._gateway_snapshot()["error"]


def test_source_catalog_exposes_provider_metadata_without_secrets():
    response = client.get("/v1/source/catalog", headers=H)
    assert response.status_code == 200
    providers = response.json()["providers"]
    assert any(row["id"] == "wikimedia" and row["metrics"]["trust"] > 0 for row in providers)
    assert all("apiKey" not in row for row in providers)


def test_file_discovery_endpoint_returns_typed_artifacts(monkeypatch):
    async def fake_files(query, limit, extensions, platforms, requirements):
        return {"query": query, "provider": "fixture", "results": [{"name": "guide.md",
            "sourceUrl": "https://github.com/a/b/blob/main/guide.md",
            "previewUrl": "https://raw.githubusercontent.com/a/b/main/guide.md",
            "downloadUrl": "https://raw.githubusercontent.com/a/b/main/guide.md", "kind": "text"}]}
    monkeypatch.setattr(server, "discover_files", fake_files)
    server._CACHE.clear()
    response = client.post("/v1/files", headers=H, json={"query": "a guide", "extensions": ["md"]})
    assert response.status_code == 200
    assert response.json()["results"][0]["name"] == "guide.md"


def test_file_transport_preserves_bytes_and_forces_download(monkeypatch):
    async def fake_bytes(url):
        return b"hello", "text/plain", "https://files.example/guide.txt"
    monkeypatch.setattr(server, "_safe_file_bytes", fake_bytes)
    response = client.post("/v1/file", headers=H, json={"url": "https://files.example/guide.txt", "download": True})
    assert response.status_code == 200
    assert response.content == b"hello"
    assert response.headers["content-disposition"] == 'attachment; filename="guide.txt"'
    assert response.headers["x-content-type-options"] == "nosniff"


def test_requested_png_transparency_is_verified_from_bytes(monkeypatch):
    def png(alpha):
        stream = io.BytesIO()
        Image.new("RGBA", (3, 3), (10, 20, 30, alpha)).save(stream, format="PNG")
        return stream.getvalue()
    payloads = {"https://assets.test/clear.png": png(0), "https://assets.test/solid.png": png(255)}
    async def fake_bytes(url, cap):
        return payloads[url], "image/png", url
    monkeypatch.setattr(server, "_safe_file_bytes", fake_bytes)
    rows = [{"title": "clear", "image": "https://assets.test/clear.png"},
            {"title": "solid", "image": "https://assets.test/solid.png"}]
    verified, rejected = asyncio.run(server._verify_image_constraints(rows, {
        "formats": ["png"], "characteristics": ["transparent_background"]}))
    assert [row["title"] for row in verified] == ["clear"]
    assert verified[0]["verifiedClaims"] == ["format", "transparent_background"]
    assert "transparent pixels" in rejected[0]["reason"]


def test_svg_specialist_result_is_converted_and_verified_as_real_png(monkeypatch):
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="6" fill="black"/></svg>'
    async def fake_bytes(url, cap):
        return svg, "image/svg+xml", url
    monkeypatch.setattr(server, "_safe_file_bytes", fake_bytes)
    verified, rejected = asyncio.run(server._verify_image_constraints([
        {"title": "service professional", "image": "https://icons.test/waiter.svg", "format": "svg", "convertibleTo": ["png"]}],
        {"formats": ["png"], "characteristics": ["transparent_background"]}, "https://relay.test"))
    assert not rejected
    assert verified[0]["format"] == "png"
    assert verified[0]["transformedFrom"] == "svg"
    assert "converted_to_png" in verified[0]["verifiedClaims"]
    assert verified[0]["image"].startswith("https://relay.test/v1/image-convert?")


def test_signed_conversion_route_survives_without_ephemeral_artifact_state(monkeypatch):
    svg = b'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><rect width="6" height="6"/></svg>'
    async def fake_bytes(url, cap):
        return svg, "image/svg+xml", url
    monkeypatch.setattr(server, "_safe_file_bytes", fake_bytes)
    source = "https://icons.test/stable.svg"
    response = client.get("/v1/image-convert", params={"source": source, "sig": server._conversion_signature(source)}, headers=H)
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/png"
    assert response.content.startswith(b"\x89PNG")


def test_gateway_probe_records_model_state(monkeypatch):
    class FakeResponse:
        status_code = 200
        def json(self):
            return {"ok": True, "service": "impose-control-plane", "llm_up": False}

    monkeypatch.setattr(server, "GATEWAY_URL", "https://gateway.test")
    monkeypatch.setattr(server.httpx, "get", lambda *a, **k: FakeResponse())
    assert server.gateway_reachable(force=True) is True
    assert server._gateway_snapshot()["llm_up"] is False


def test_search_cache_varies_by_language_freshness_and_region(monkeypatch):
    calls = []

    async def fake_search(query, **kwargs):
        calls.append((query, kwargs))
        return {"query": query, "provider": "fake", "results": []}

    monkeypatch.setattr(server, "engine_search", fake_search)
    server._CACHE.clear()
    base = {"query": "same query", "limit": 2}
    assert client.post("/v1/search", headers=H, json={**base, "language": "en"}).status_code == 200
    assert client.post("/v1/search", headers=H, json={**base, "language": "fr"}).status_code == 200
    assert client.post("/v1/search", headers=H, json={**base, "language": "fr", "freshness": "week"}).status_code == 200
    assert client.post("/v1/search", headers=H, json={**base, "language": "fr", "freshness": "week", "region": "FR"}).status_code == 200
    assert len(calls) == 4
