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
    "https://duckduckgo.com/y.js?ad_domain=example.com",
    "https://www.bing.com/aclick?target=https://example.com/file.pdf",
])
def test_normalizer_rejects_unsafe_or_non_file_candidates(url):
    assert files.normalize_candidate(url) is None


def test_template_catalog_page_is_typed_as_action_not_fake_download():
    row = files._catalog_page_candidate("https://create.microsoft.com/en-us/templates/resumes", "Free resume templates")
    assert row["providerId"] == "microsoft-create"
    assert row["accessMode"] == "open"
    assert row["actionLabel"] == "Open template"
    assert row["actionUrl"].startswith("https://create.microsoft.com/")
    assert row["downloadUrl"] == ""


def test_artifact_words_are_not_misread_as_file_extensions(monkeypatch):
    calls = []
    async def fake_search(query, limit=8):
        calls.append(query)
        return {"provider": "fixture", "results": [{"title": "CV templates", "url": "https://create.microsoft.com/en-us/templates/resumes"}]}
    async def no_github(*args, **kwargs): return []
    monkeypatch.setattr(files, "engine_search", fake_search)
    monkeypatch.setattr(files, "_github_repository_search", no_github)
    out = asyncio.run(files.discover_files("CV template", extensions="template", requirements={"formats": ["template"], "artifactType": "template"}))
    assert not any("filetype:template" in query for query in calls)
    assert out["results"][0]["accessMode"] == "open"


def test_template_discovery_uses_ranked_provider_domains_and_returns_action(monkeypatch):
    calls = []
    async def fake_search(query, limit=8):
        calls.append(query)
        rows = ([{"title": "Professional CV templates", "url": "https://www.canva.com/resumes/templates/?utm_source=x&msockid=y"}]
                if "site:canva.com" in query else [])
        return {"provider": "fixture", "results": rows}
    async def no_github(*args, **kwargs): return []
    monkeypatch.setattr(files, "engine_search", fake_search)
    monkeypatch.setattr(files, "_github_repository_search", no_github)
    out = asyncio.run(files.discover_files("CV resume template", requirements={
        "artifactType": "template", "sourceClasses": ["template_repository"],
        "requiredCapabilities": ["search", "preview", "download"]}))
    assert any("site:canva.com" in query for query in calls)
    assert out["results"][0]["accessMode"] == "open"
    assert out["results"][0]["actionUrl"] == "https://www.canva.com/resumes/templates/"
    assert out["sourcePlan"]["resultEvaluation"]["actionable"] == 1


def test_discovery_expands_from_typed_extension_without_request_rules(monkeypatch):
    calls = []
    async def fake_search(query, limit=8):
        calls.append(query)
        result = []
        if "filetype:md" in query:
            result = [{"title": "Unrelated bundle", "url": "https://example.com/archive.zip"},
                      {"title": "Skill", "url": "https://github.com/acme/design/blob/main/SKILL.md"}]
        return {"provider": "fixture", "results": result}
    monkeypatch.setattr(files, "engine_search", fake_search)
    out = asyncio.run(files.discover_files("frontend design agent skill", extensions=["md"]))
    assert any("filetype:md" in query for query in calls)
    assert out["results"][0]["name"] == "SKILL.md"
    assert all(row["extension"] == "md" for row in out["results"])
    assert out["results"][0]["downloadUrl"].startswith("https://raw.githubusercontent.com/")
