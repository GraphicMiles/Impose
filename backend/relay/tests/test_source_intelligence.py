import json
from pathlib import Path

from relay.source_intelligence import PerformanceLedger, ProviderCatalog, SourceRequirements, SourceRouter


def router():
    return SourceRouter(ProviderCatalog(ledger=PerformanceLedger()))


def test_specialist_sources_outrank_generic_search_for_licensed_image():
    req = SourceRequirements.from_mapping("discover_images", {
        "artifactType": "image", "formats": ["png"],
        "sourceClasses": ["public_media_repository", "creative_repository"],
        "requiredCapabilities": ["search", "preview", "source_attribution"],
        "priorities": {"license_clarity": 1, "download_reliability": 0.9},
    })
    ranked = router().rank(req, ["wikimedia", "openverse", "bing-images", "ddg-images"])
    assert ranked[0]["provider"] in {"wikimedia", "openverse"}
    assert ranked[-1]["provider"] in {"bing-images", "ddg-images"}
    assert ranked[0]["score"] > ranked[-1]["score"]
    assert ranked[0]["reasons"]


def test_provider_rank_depends_on_task_requirements_not_universal_popularity():
    r = router()
    image = SourceRequirements.from_mapping("discover", {"artifactType": "image", "formats": ["png"],
        "requiredCapabilities": ["search", "preview"]})
    code = SourceRequirements.from_mapping("discover", {"artifactType": "source_code",
        "sourceClasses": ["developer_repository"], "requiredCapabilities": ["search", "download"]})
    assert r.rank(image)[0]["provider"] != r.rank(code)[0]["provider"]
    assert r.rank(code)[0]["provider"] in {"github-public", "gitlab-public", "huggingface-public"}


def test_progressive_plan_starts_narrow_and_has_bounded_fallbacks():
    req = SourceRequirements.from_mapping("discover_images", {"artifactType": "image",
        "requiredCapabilities": ["search", "preview", "source_attribution"]})
    plan = router().plan(req, ["wikimedia", "openverse", "bing-images", "ddg-images"])
    assert plan["stages"][0]["strategy"] == "best-fit"
    assert len(plan["stages"][0]["providers"]) <= 2
    assert plan["stages"][-1]["stage"] <= 3
    assert plan["candidates"][0]["score"] >= plan["candidates"][-1]["score"]


def test_observed_result_quality_can_change_future_provider_order():
    r = router()
    req = SourceRequirements.from_mapping("discover_images", {"artifactType": "image",
        "requiredCapabilities": ["search", "preview", "source_attribution"]})
    before = [row["provider"] for row in r.rank(req, ["wikimedia", "openverse"])]
    for _ in range(8):
        r.observe("wikimedia", success=False, result_quality=0, valid_ratio=0, latency_ms=9000)
        r.observe("openverse", success=True, result_quality=1, valid_ratio=1, latency_ms=300)
    after = [row["provider"] for row in r.rank(req, ["wikimedia", "openverse"])]
    assert before[0] == "wikimedia"
    assert after[0] == "openverse"


def test_discovered_provider_starts_with_conservative_trust():
    r = router()
    found = r.catalog.discover("https://new-specialist.example/assets/item.png",
                               artifact_types=["image"], source_classes=["specialist_repository"])
    assert found.discovered is True
    assert found.metrics["trust"] == 0.25
    strict = SourceRequirements.from_mapping("discover", {"artifactType": "image", "minimumTrust": 0.7})
    assert all(row["provider"] != found.id for row in r.rank(strict))


def test_android_sources_rank_for_authenticity_and_safety_not_mod_popularity():
    r = router()
    req = SourceRequirements.from_mapping("discover_software", {"artifactType": "android_app",
        "formats": ["apk"], "priorities": {"authenticity": 1, "safety": 1, "version_accuracy": 1}})
    ids = [row["provider"] for row in r.rank(req, ["google-play", "f-droid", "apkmirror"])]
    assert ids[0] == "google-play"
    assert "f-droid" in ids and "apkmirror" in ids
    assert all("mod" not in provider for provider in ids)


def test_catalog_is_data_extensible_without_router_branch(tmp_path: Path):
    catalog = {"version": 3, "providers": [{"id": "new-source", "mechanism": "api",
        "source_classes": ["specialist_repository"], "artifact_types": ["dataset"],
        "formats": ["csv"], "capabilities": ["search", "download"],
        "quality": .8, "authority": .8, "freshness": .7, "coverage": .6,
        "availability": .9, "license_clarity": .9, "download_reliability": .9,
        "trust": .8, "specialization": .95}]}
    path = tmp_path / "catalog.json"; path.write_text(json.dumps(catalog))
    r = SourceRouter(ProviderCatalog(path))
    req = SourceRequirements.from_mapping("discover", {"artifactType": "dataset", "formats": ["csv"],
        "requiredCapabilities": ["search", "download"]})
    assert r.rank(req)[0]["provider"] == "new-source"
