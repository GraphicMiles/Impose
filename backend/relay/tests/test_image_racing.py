"""Deterministic lifecycle tests for concurrent image-provider search."""
import asyncio
import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2]))
os.environ.setdefault("CONTROL_KEY", "test123")

from relay import images  # noqa: E402
from relay.search import AttemptFail  # noqa: E402


def _provider(job):
    return lambda client, query, limit: job


@pytest.fixture(autouse=True)
def _no_live_specialist_network(monkeypatch):
    async def unavailable():
        raise AttemptFail("unavailable")
    monkeypatch.setattr(images, "partial_iconify", _provider(unavailable))
    monkeypatch.setattr(images, "partial_svg_repo", _provider(unavailable))
    monkeypatch.setattr(images, "partial_simple_icons", _provider(unavailable))


def test_brand_catalog_matches_semantic_name_and_returns_attributed_svg(monkeypatch):
    class Response:
        status_code = 200
        headers = {"content-type": "application/json"}
        content = b""
        def json(self): return [{"title": "Google", "hex": "4285F4", "source": "https://about.google/brand-resource-center/"},
                                {"title": "Google Cloud", "hex": "4285F4", "source": "https://cloud.google.com"}]
    class Artifact:
        status_code = 200
        headers = {"content-type": "image/svg+xml"}
        content = b"<svg xmlns='http://www.w3.org/2000/svg'></svg>"
    class Client:
        async def get(self, url, **kwargs): return Artifact() if url.endswith("/icons/google.svg") else Response()
    monkeypatch.setitem(images._simple_icons_cache, "rows", [])
    rows = asyncio.run(images._simple_icons(Client(), ["official Google logo icon"], 4))
    assert rows[0]["title"] == "Google brand icon"
    assert rows[0]["format"] == "svg"
    assert rows[0]["page"].startswith("https://about.google/")
    assert rows[0]["image"].endswith("/simple-icons@latest/icons/google.svg")


def test_source_rank_beats_fastest_response(monkeypatch):
    async def fast_result():
        await asyncio.sleep(0.01)
        return [{"title": "Lagos", "image": "https://example.test/lagos.jpg"}]

    async def slow_result():
        await asyncio.sleep(0.03)
        return [{"title": "Lagos archive", "image": "https://example.test/late.jpg",
                 "page": "https://commons.example/lagos", "license": "CC BY", "w": 1200, "h": 800}]

    monkeypatch.setattr(images, "partial_open", _provider(fast_result))
    monkeypatch.setattr(images, "partial_wiki", _provider(slow_result))
    monkeypatch.setattr(images, "partial_bing", _provider(slow_result))
    monkeypatch.setattr(images, "partial_ddg", _provider(slow_result))

    result = asyncio.run(images.engine_images("Lagos skyline", limit=4))

    assert result["provider"] == "wikimedia"
    assert result["count"] == 1
    assert result["sourcePlan"]["selectedProviders"] == ["wikimedia"]
    assert result["sourcePlan"]["candidates"][0]["score"] >= result["sourcePlan"]["candidates"][1]["score"]


def test_poor_specialist_results_escalate_to_compatible_provider(monkeypatch):
    async def wrong_format():
        return [{"title": "subject", "image": "https://example.test/subject.jpg"}]
    async def compatible():
        return [{"title": "subject", "image": "https://example.test/subject.png",
                 "page": "https://source.test/subject", "w": 900, "h": 900}]
    async def failed():
        raise AttemptFail("unavailable")
    monkeypatch.setattr(images, "partial_open", _provider(wrong_format))
    monkeypatch.setattr(images, "partial_wiki", _provider(wrong_format))
    monkeypatch.setattr(images, "partial_bing", _provider(compatible))
    monkeypatch.setattr(images, "partial_ddg", _provider(failed))
    result = asyncio.run(images.engine_images("subject", limit=4, requirements={
        "artifactType": "image", "formats": ["png"], "retrievalQuery": "subject"}))
    assert result["provider"] == "bing-images"
    assert all(row["format"] == "png" for row in result["results"])
    assert result["sourcePlan"]["fallbackDecisions"][0]["decision"] == "broaden"


def test_image_provider_failures_keep_actionable_diagnostics(monkeypatch):
    def failed(message):
        async def job():
            raise AttemptFail(message)
        return job

    monkeypatch.setattr(images, "partial_open", _provider(failed("http 403")))
    monkeypatch.setattr(images, "partial_wiki", _provider(failed("no results")))
    monkeypatch.setattr(images, "partial_bing", _provider(failed("challenge")))
    monkeypatch.setattr(images, "partial_ddg", _provider(failed("timed out")))

    try:
        asyncio.run(images.engine_images("missing subject", limit=4))
    except images.ImagesFailed as error:
        detail = str(error)
    else:
        raise AssertionError("all-provider failure should be explicit")

    assert "openverse=http 403" in detail
    assert "wikimedia=no results" in detail
    assert "bing-images=challenge" in detail
    assert "ddg-images=timed out" in detail


def test_image_search_has_one_global_deadline(monkeypatch):
    async def stalled():
        await asyncio.sleep(1)
        return []

    monkeypatch.setattr(images, "IMAGE_SEARCH_TIMEOUT_SECONDS", 0.02)
    monkeypatch.setattr(images, "partial_open", _provider(stalled))
    monkeypatch.setattr(images, "partial_wiki", _provider(stalled))
    monkeypatch.setattr(images, "partial_bing", _provider(stalled))
    monkeypatch.setattr(images, "partial_ddg", _provider(stalled))

    try:
        asyncio.run(images.engine_images("slow subject", limit=4))
    except images.ImagesFailed as error:
        detail = str(error)
    else:
        raise AssertionError("deadline should fail explicitly")

    assert "overall=deadline exceeded" in detail
