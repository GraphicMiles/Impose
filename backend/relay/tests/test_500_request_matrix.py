"""Deterministic randomized contract stress test for 500 agent retrieval calls.

The matrix varies subjects, phrasing, limits, and structured requirement shapes.
Provider I/O is stubbed: this test targets the agent-to-relay boundary, schema
normalization, typed outputs, and the historical failure mode where reasonable
model-generated file inputs produced HTTP 400.
"""
import os, random, sys
from pathlib import Path

HERE = Path(__file__).resolve(); sys.path.insert(0, str(HERE.parents[2]))
os.environ.setdefault("CONTROL_KEY", "test123")
from fastapi.testclient import TestClient
from relay import files, server

client = TestClient(server.app)

SUBJECTS = [
    "Lagos weather", "Nigeria inflation", "Python release notes", "solar panel prices",
    "Google logo", "transparent calendar icon", "Ada Lovelace portrait", "office illustration",
    "CV template", "invoice spreadsheet", "research paper PDF", "budget CSV", "pitch deck template",
    "open source Android app", "machine learning dataset", "npm package documentation",
    "live coding stream", "official music video", "latest product launch", "conference recording",
]
PHRASES = ["find", "show me", "locate a reliable", "get me", "I need", "please discover"]


def test_500_randomized_retrieval_requests_never_reject_valid_semantic_shapes(monkeypatch):
    rng = random.Random(20260915)
    monkeypatch.setattr(server, "_tier_auth", lambda *args, **kwargs: None)

    async def fake_search(query, limit=8, domains=None, freshness=None, language="en", region=None, requirements=None):
        return {"query": query, "retrievalQuery": (requirements or {}).get("retrievalQuery", query),
                "provider": "fixture-search", "count": 1,
                "results": [{"title": query, "url": "https://example.org/source/" + str(abs(hash(query))), "snippet": "verified fixture", "source": "fixture"}],
                "sourcePlan": {"selectedProviders": ["fixture-search"], "resultEvaluation": {"accepted": 1, "constraintsSatisfied": True}}}

    async def fake_images(query, limit=8, requirements=None):
        return {"query": query, "provider": "fixture-images", "count": 1,
                "results": [{"title": query, "image": "https://images.example.org/item.svg", "thumb": "https://images.example.org/item.svg", "page": "https://example.org/assets", "format": "svg"}],
                "sourcePlan": {"selectedProviders": ["fixture-images"], "resultEvaluation": {"accepted": 1, "constraintsSatisfied": True}}}

    async def fake_file_search(query, limit=8, **kwargs):
        match = __import__('re').search(r"filetype:([a-z0-9.+_-]+)", query)
        if match:
            ext = match.group(1)
            rows = [{"title": "Typed artifact", "url": "https://files.example.org/artifact." + ext}]
        elif "site:" in query or "template" in query.lower():
            rows = [{"title": "Professional template", "url": "https://create.microsoft.com/en-us/templates/resumes"}]
        else:
            rows = [{"title": "Artifact", "url": "https://github.com/example/project/blob/main/artifact.pdf"}]
        return {"provider": "fixture-file-search", "results": rows}

    async def no_repository_fallback(*args, **kwargs): return []

    async def fake_videos(query, limit=4, constraints=None):
        return {"query": query, "provider": "fixture-video", "count": 1,
                "results": [{"title": query, "url": "https://www.youtube.com/watch?v=abcdefghijk", "provider": "youtube", "kind": "youtube-video", "videoId": "abcdefghijk", "verifiedClaims": ["playable"]}]}

    monkeypatch.setattr(server, "engine_search", fake_search)
    monkeypatch.setattr(server, "engine_images", fake_images)
    monkeypatch.setattr(server, "_verify_image_constraints", lambda rows, requirements, artifact_base_url="": __import__('asyncio').sleep(0, result=(rows, [])))
    monkeypatch.setattr(files, "engine_search", fake_file_search)
    monkeypatch.setattr(files, "_github_repository_search", no_repository_fallback)
    monkeypatch.setattr(server, "engine_videos", fake_videos)

    counts = {"search": 0, "images": 0, "files": 0, "videos": 0}
    for index in range(500):
        kind = ("search", "images", "files", "videos")[index % 4]
        subject = rng.choice(SUBJECTS)
        query = f"{rng.choice(PHRASES)} {subject} case {index}"
        if kind == "search":
            req = {"artifactType": "information", "diversity": rng.randint(1, 5), "retrievalQuery": subject,
                   "sourceClasses": rng.choice([["official_source"], ["primary_source", "news"], []])}
            if index % 9 == 0: req = __import__("json").dumps(req)
            payload = {"query": query, "limit": rng.randint(1, 30),
                       "domains": rng.choice([None, [], "example.org", ["example.org", "docs.example.org"]]),
                       "requirements": req}
            response = client.post("/v1/search", json=payload)
        elif kind == "images":
            req = {"artifactType": "image", "formats": rng.choice([[], ["png"], ["svg"]]),
                   "characteristics": rng.choice([["transparent_background"], ["brand_icon"], []]), "retrievalQuery": subject}
            if index % 13 == 0: req = __import__("json").dumps(req)
            payload = {"query": query, "limit": rng.randint(1, 16), "requirements": req}
            response = client.post("/v1/images", json=payload)
        elif kind == "files":
            # Exercise both canonical arrays and plausible model/client scalar forms.
            ext = rng.choice(["pdf", "docx", "xlsx", "csv", "zip"])
            extensions = rng.choice([[ext], ext, ext + ",pdf", None])
            platforms = rng.choice([[], ["GitHub"], "Microsoft Create", None])
            requirements = rng.choice([
                {"artifactType": "document", "formats": [ext], "requiredCapabilities": ["search", "preview", "download"]},
                '{"artifactType":"template","sourceClasses":["template_repository"]}',
                None,
            ])
            payload = {"query": query, "limit": rng.randint(1, 16), "extensions": extensions,
                       "platforms": platforms, "requirements": requirements}
            response = client.post("/v1/files", json=payload)
        else:
            payload = {"query": query, "limit": rng.randint(1, 14), "constraints": {
                "latest": "true" if index % 3 == 0 else False, "live": 1 if index % 11 == 0 else 0,
                "subject": subject, "platforms": rng.choice(["youtube", ["youtube"], []])}}
            response = client.post("/v1/videos", json=payload)
        assert response.status_code == 200, (index, kind, response.status_code, response.text)
        data = response.json()
        assert data.get("results"), (index, kind, data)
        counts[kind] += 1
    assert counts == {"search": 125, "images": 125, "files": 125, "videos": 125}
