import asyncio

import pytest

from relay import files


def test_github_blob_normalizes_to_raw_download():
    row = files.normalize_candidate("https://github.com/acme/repo/blob/main/docs/guide.md", "Guide")
    assert row["sourceUrl"].endswith("/blob/main/docs/guide.md")
    assert row["downloadUrl"] == "https://raw.githubusercontent.com/acme/repo/main/docs/guide.md"
    assert row["kind"] == "text"
    assert row["platform"] == "GitHub"


def test_platform_adapters_and_arbitrary_binary_fallback():
    gitlab = files.normalize_candidate("https://gitlab.com/a/b/-/blob/dev/manual.pdf")
    assert gitlab["downloadUrl"].endswith("/-/raw/dev/manual.pdf")
    assert gitlab["kind"] == "pdf"
    model = files.normalize_candidate("https://huggingface.co/a/b/blob/main/model.safetensors")
    assert model["downloadUrl"].endswith("/resolve/main/model.safetensors")
    assert model["kind"] == "binary"


@pytest.mark.parametrize("url", [
    "http://github.com/a/b/blob/main/x.md",
    "https://user:pass@github.com/a/b/blob/main/x.md",
    "javascript:alert(1)",
    "https://example.com/no-file-page",
])
def test_normalizer_rejects_unsafe_or_non_file_candidates(url):
    assert files.normalize_candidate(url) is None


def test_discovery_expands_from_typed_extension_without_request_rules(monkeypatch):
    calls = []
    async def fake_search(query, limit=8):
        calls.append(query)
        result = []
        if "filename.md" in query:
            result = [{"title": "Unrelated bundle", "url": "https://example.com/archive.zip"},
                      {"title": "Skill", "url": "https://github.com/acme/design/blob/main/SKILL.md"}]
        return {"provider": "fixture", "results": result}
    monkeypatch.setattr(files, "engine_search", fake_search)
    out = asyncio.run(files.discover_files("frontend design agent skill", extensions=["md"]))
    assert any("filename.md" in query for query in calls)
    assert out["results"][0]["name"] == "SKILL.md"
    assert all(row["extension"] == "md" for row in out["results"])
    assert out["results"][0]["downloadUrl"].startswith("https://raw.githubusercontent.com/")
