"""Deterministic lifecycle tests for concurrent image-provider search."""
import asyncio
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2]))
os.environ.setdefault("CONTROL_KEY", "test123")

from relay import images  # noqa: E402
from relay.search import AttemptFail  # noqa: E402


def _provider(job):
    return lambda client, query, limit: job


def test_first_image_provider_wins_and_slower_work_is_cancelled(monkeypatch):
    cancelled = []

    async def fast_result():
        await asyncio.sleep(0.01)
        return [{"title": "Lagos", "image": "https://example.test/lagos.jpg"}]

    async def slow_result():
        try:
            await asyncio.sleep(1)
            return [{"title": "late", "image": "https://example.test/late.jpg"}]
        finally:
            cancelled.append(True)

    monkeypatch.setattr(images, "partial_open", _provider(fast_result))
    monkeypatch.setattr(images, "partial_wiki", _provider(slow_result))
    monkeypatch.setattr(images, "partial_bing", _provider(slow_result))
    monkeypatch.setattr(images, "partial_ddg", _provider(slow_result))

    result = asyncio.run(images.engine_images("Lagos skyline", limit=4))

    assert result["provider"] == "openverse"
    assert result["count"] == 1
    assert len(cancelled) == 3


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
