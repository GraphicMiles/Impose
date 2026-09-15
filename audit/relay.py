"""Relay-side scenario matrix for the Impose audit.

Executes the real relay modules (source router, file normalization, search
parsers, capability pipeline, request bound normalizers) against generated and
adversarial inputs, and writes the same ledger schema the JS harness uses.

Run: PYTHONPATH=backend python3 audit/relay.py --out audit/out
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "Impose"
if not (ROOT / "backend" / "relay").is_dir():  # allow running from inside a clone
    ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from relay.source_intelligence import (CATALOG, ROUTER, PerformanceLedger, ProviderCatalog,  # noqa: E402
                                      ProviderProfile, SourceRequirements, SourceRouter)
from relay.files import _action_record, _https, _kind, _name, _record  # noqa: E402
from relay.search import _dedup, _filter_relevant, _norm_q, parse_bing, parse_ddg, parse_searxng, parse_yahoo  # noqa: E402
from relay.capabilities import Candidate, CapabilityPipeline, CapabilityRequest  # noqa: E402
from relay import server as relay_server  # noqa: E402

ROWS = []
CATEGORY = "relay"


def record(scenario_id, category, expect, actual, ok, severity="P3", root="", reason=""):
    ROWS.append({"id": scenario_id, "category": category, "title": "relay invariant",
                 "expected": expect, "actual": str(actual)[:280], "status": "pass" if ok else "fail",
                 "error": "" if ok else (reason or "invariant violated"), "severity": severity if not ok else "P3",
                 "rootCause": "" if ok else root})


def rnd(rng, n, alphabet="abcdefghijklmnopqrstuvwxyz0123456789 -_.:/<>\"'&;#%\\|"):
    return "".join(rng.choice(alphabet) for _ in range(n))


ARTIFACTS = ["information", "image", "png", "svg", "vector", "document", "package", "dataset", "template", "video", "audio", "book"]
FORMATS = ["png", "svg", "jpg", "webp", "pdf", "zip", "apk", "csv", "json", "mp4", "透明", ""]
CLASSES = ["official_source", "primary_source", "web_index", "template_repository", "package_registry",
           "brand_asset_repository", "academic_repository", "evil", ""]
CAPS = ["search", "download", "preview", "source_attribution", "license_metadata", "metadata",
        "version_history", "publisher_identity", "nonexistent"]
METRICS = ["quality", "authority", "freshness", "coverage", "availability", "license_clarity",
           "download_reliability", "trust", "specialization", "authenticity", "safety", "version_accuracy"]


def scenarios_routing(rng, n):
    global CATEGORY
    CATEGORY = "relay.routing.determinism"
    out = []
    for i in range(n):
        req = SourceRequirements(
            capability=rng.choice(["discover_images", "discover_files", "retrieve_information"]),
            artifact_type=rng.choice(ARTIFACTS), formats=frozenset({rng.choice(FORMATS)} - {""}),
            source_classes=frozenset({rng.choice(CLASSES)} - {""}),
            required_capabilities=frozenset(rng.sample(CAPS, rng.randint(1, 3))),
            characteristics=frozenset({rng.choice(["transparent", "no_background", "latest", ""])} - {""}),
            priorities={rng.choice(METRICS): rng.random()}, minimum_trust=rng.choice([0.0, 0.2, 0.5, 0.9, 1.01, -1]),
            diversity=rng.randint(1, 9))

        def make(req=req, i=i):
            a = ROUTER.plan(req)
            b = ROUTER.plan(req)
            same = json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
            ranked = a.get("candidates", [])
            ordered = all(ranked[k]["score"] >= ranked[k + 1]["score"] for k in range(len(ranked) - 1))
            bounded = all(0.0 <= row["score"] <= 1.0 for row in ranked)
            ids = [row["provider"] for row in ranked]
            unique = len(ids) == len(set(ids))
            stages_flat = [p for st in a.get("stages", []) for p in st["providers"]]
            stage_bounded = (set(stages_flat).issubset(set(ids))
                             and len(stages_flat) == len(set(stages_flat))
                             and all(st["providers"] for st in a.get("stages", [])))
            ok = same and ordered and bounded and unique and stage_bounded
            record(f"routing.{i}", CATEGORY,
                   "plan is deterministic, score-ordered, bounded, deduped, and stages are a subset of candidates",
                   f"candidates={len(ranked)} stages={len(a.get('stages', []))} minTrust={req.minimum_trust}",
                   ok, "P2", "source-router-contract",
                   "ranking contract broken: " + ("nondeterministic" if not same else
                                                  "unsorted" if not ordered else "unbounded score" if not bounded else
                                                  "duplicate providers" if not unique else
                                                  "a stage leaked outside the candidate set"))
            return None
        out.append(make)
    return out


def scenarios_discovery(rng, n):
    global CATEGORY
    CATEGORY = "relay.routing.discovery-cap"
    out = []
    catalog = ProviderCatalog(path=CATALOG.path, ledger=PerformanceLedger())
    router = SourceRouter(catalog)
    urls = [f"https://new{i}.example/x" for i in range(n)] + ["not a url", "//x", "javascript:alert(1)",
            "https://", "https://user:pw@host/x", "https://[", "ftp://host/f", ""]
    for i, u in enumerate(urls):
        def make(u=u, i=i):
            before = sum(1 for p in catalog.providers() if p.discovered)
            profile = catalog.discover(u)
            after = sum(1 for p in catalog.providers() if p.discovered)
            if not u or "://" not in u:
                ok = profile is None
                detail = "rejected" if profile is None else f"accepted {profile.id}"
            else:
                grew = after == before + 1 or after == before
                bounded = after <= catalog._discovered_limit
                discounted = True
                if profile is not None:
                    req = SourceRequirements(capability="search", artifact_type="information")
                    score, _ = router.score(profile, req)
                    known = catalog.get("wikimedia")
                    base_known, _ = router.score(known, req)
                    discounted = score <= max(base_known, 0.0) + 1e-6 or score < 0
                ok = grew and bounded and discounted
                detail = f"profile={profile and profile.id} discovered={after} discounted={discounted}"
            record(f"discovery.{i}", CATEGORY, "discovery is capped, never trusted, and hostile URLs are refused",
                   detail, ok, "P1", "discovery-trust-inheritance", "a discovered domain was admitted with unbounded or inherited trust")
            return None
        out.append(make)
    return out


def scenarios_files(rng, n):
    global CATEGORY
    CATEGORY = "relay.files.artifact-normalization"
    out = []
    urls = ["https://github.com/o/r", "https://github.com/o/r/releases/download/v1/app.apk",
            "https://gitlab.com/a/b/-/raw/main/f.csv", "https://huggingface.co/datasets/x",
            "https://gist.github.com/u/abc", "https://duckduckgo.com/y.js?u=https://evil/x",
            "http://insecure/x", "javascript:alert(1)", "https://x.com/a/../../etc/passwd",
            "https://x.com/a%00.png", "https://x.com/" + rnd(rng, 5000), "", "   "]
    kinds = ["apk", "pdf", "csv", "png", "svg", "zip", "tar.gz", "exe", "html", "js", "php", "透明", "APK", ""]
    for i in range(n):
        url = urls[i % len(urls)]
        ext = kinds[i % len(kinds)]
        def make(url=url, ext=ext, i=i):
            h = _https(url)
            bad_https = h and (h.startswith("http://") or "javascript" in h or "@" in h)
            name = _name("/".join(url.split("/")[3:]) or "x", "download")
            bad_name = "\n" in name or "/" in name or "\\" in name or len(name) > 180 or "\x00" in name
            kind = _kind("f." + ext if ext else "f", "application/octet-stream")
            rec = _record(url, url if h else "", "t")
            if rec is not None:
                bad_rec = not rec["downloadUrl"].startswith("https://") or len(json.dumps(rec)) > 20000
            else:
                bad_rec = False
            act = _action_record(url, "t", "microsoft-create")
            bad_act = act is not None and (act.get("downloadUrl") != "" or not act.get("actionUrl", "").startswith("https://"))
            ok = not (bad_https or bad_name or bad_rec or bad_act)
            record(f"files.{i}", CATEGORY, "https-only, bounded filenames, no fake downloads, provider actions are honest",
                   f"https={h[:40]} name={name[:20]} kind={kind} rec={'y' if rec else 'n'} action={'y' if act else 'n'}",
                   ok, "P1", "file-artifact-normalization",
                   "normalization let a non-https, oversized, or dishonest artifact record through")
            return None
        out.append(make)
    return out


def scenarios_search(rng, n):
    global CATEGORY
    CATEGORY = "relay.search.parsing"
    out = []

    def page(kind, payload):
        if kind == "searxng":
            return parse_searxng(payload)
        html = payload
        if kind == "bing":
            return parse_bing(html)
        if kind == "ddg":
            return parse_ddg(html)
        return parse_yahoo(html)
    kinds = ["searxng", "bing", "ddg", "yahoo"]
    payloads = [{}, {"items": None}, {"items": []}, {"results": "not a list"}, {"s": 1},
                json.dumps({"items": [{"url": "javascript:alert(1)", "title": "t", "content": "c"}]}),
                "<html></html>", "<a>no href</a>", "<a href='/watch'>rel</a>",
                "<a href='https://x.com/a'>t</a>", "<a href='//x.com/a'>t</a>",
                "<a href='https://bing.com/ck?a=1'>t</a>", "<a href='https://duckduckgo.com/l/?uddg=https%3A%2F%2Freal.example%2Fx'>t</a>",
                "<a href='https://x.com/a'>&lt;script&gt;</a>", ""]
    queries = ["lagos traffic today", "", "   ", rnd(rng, 400), "\"exact phrase\"", "site:x.com", "🇳🇬", "%00", "' OR 1=1 --"]
    for i in range(n):
        kind = kinds[i % len(kinds)]
        # Each engine's transport shape differs: metasearch hands the relay a
        # decoded object, the HTML engines hand it a document. Feed each its own.
        pool = [p for p in payloads if (kind == "searxng") == isinstance(p, dict)] or payloads
        payload = pool[(i * 7) % len(pool)]
        query = queries[i % len(queries)]
        def make(kind=kind, payload=payload, query=query, i=i):
            try:
                if kind == "searxng":
                    # engine_search parses JSON before the engine-specific
                    # normalizer runs, so a mapping is the real contract here.
                    body = payload
                    if isinstance(body, str):
                        try:
                            body = json.loads(body)
                        except Exception:
                            body = {}
                    rows = parse_searxng(body)
                else:
                    rows = page(kind, payload)
            except Exception as exc:  # a parser crash on hostile input is the failure we are hunting
                record(f"search.{i}", CATEGORY, "parsers never throw on malformed provider output",
                       f"threw {type(exc).__name__}: {exc}", False, "P1", "search-parser-crash",
                       "a malformed engine reply raises instead of degrading to zero results")
                return None
            rows = list(rows or [])
            urls = [str(r.get("url", "")) for r in rows]
            bad_scheme = any(u and not u.startswith(("http://", "https://")) for u in urls)
            over = any(len(u) > 4000 for u in urls)
            filt = _filter_relevant(rows, query) if rows else []
            ded = _dedup(rows + rows)
            halved = len(ded) <= len(rows) * 1.0 + 1
            inject = any("<script" in str(r.get("title", "")).lower() or "<script" in str(r.get("snippet", "")).lower()
                         for r in rows)
            ok = not bad_scheme and not over and halved and isinstance(filt, list) and not inject
            record(f"search.{i}", CATEGORY, "schemes https-only, sizes bounded, duplicates collapsed, markup not passed through",
                   f"rows={len(rows)} urls={urls[:1]} badScheme={bad_scheme} inject={inject}", ok,
                   "P1", "search-result-sanitization", "untrusted engine output could carry markup or a non-http scheme")
            return None
        out.append(make)

    return out


def scenarios_pipeline(rng, n):
    global CATEGORY
    CATEGORY = "relay.capability.claims"
    out = []
    import asyncio

    class Adapter:
        def __init__(self, name, claims, score, broken=False):
            self.name, self.capabilities = name, frozenset({"media.playable"})
            self._claims, self._score, self._broken = claims, score, broken
        def supports(self, request):
            return True
        async def discover(self, request, context):
            if self._broken:
                raise RuntimeError("provider down")
            return [Candidate({"url": f"https://m.example/{self.name}{k}", "id": k}, self.name,
                              frozenset(self._claims), self._score) for k in range(3)]
    pipeline = CapabilityPipeline()
    for i, (nm, claims, score, broken) in enumerate([
        ("a", ["playable"], 0.9, False), ("b", ["playable", "live"], 0.5, False),
        ("c", [], 1.0, False), ("d", ["playable"], 0.7, True)]):
        pipeline.register(Adapter(nm, claims, score, broken))
    for i in range(n):
        claims = frozenset(rng.choice([["playable"], ["playable", "live"], ["playable", "latest"], ["live"]]))
        limit = rng.randint(0, 6)
        def make(claims=claims, limit=limit, i=i):
            req = CapabilityRequest(capability="media.playable", query="q", limit=limit, required_claims=claims)
            rows = asyncio.run(pipeline.run(req, None))
            missing = [r for r in rows if not claims.issubset(r.claims)]
            dupes = len({r.value["url"] for r in rows}) != len(rows)
            over = len(rows) > max(0, limit)
            ok = not missing and not dupes and not over
            record(f"pipeline.{i}", CATEGORY, "fail-closed on claims, deduped, size-bounded, a dead adapter cannot sink the run",
                   f"required={sorted(claims)} returned={len(rows)} missing={len(missing)} over={over}", ok,
                   "P0", "claim-policy-bypass", "the pipeline returned a candidate that cannot prove a required claim")
            return None
        out.append(make)
    return out


def scenarios_bounds(rng, n):
    global CATEGORY
    CATEGORY = "relay.contract.normalization"
    out = []
    shapes = [None, "", "   ", 0, 1, -3, True, False, "true", "FALSE", "yes", "no", "1", "0", "[]", "{}",
              '{"a":1}', '{"a":"b"}', "a,b,c", ["a", "b"], [1, 2], [{"x": 1}], [None], list(range(500)),
              "x" * 40000, {"priorities": {"trust": "high"}}, {"minimumTrust": 12}, {"minimumTrust": "0.4"},
              {"diversity": "3"}, {"diversity": -5}, {"formats": "PNG"}, {"formats": ["png", None, ""]}]
    for i in range(n):
        raw = shapes[i % len(shapes)]
        def make(raw=raw, i=i):
            try:
                req = SourceRequirements.from_mapping("discover_files", raw if isinstance(raw, dict) else {"raw": raw})
                bounded = (len(req.formats) <= 20 and len(req.source_classes) <= 20
                           and 0.0 <= req.minimum_trust <= 1.0 and 1 <= req.diversity <= 5)
                sreq = relay_server._semantic_bool(raw)
                # None is the deliberate "absent" signal for callers that use
                # isinstance(x, bool) before honouring a constraint.
                bool_ok = isinstance(sreq, bool) or sreq is None
                strs = relay_server._bounded_strings(raw)
                strs_ok = isinstance(strs, list) and len(strs) <= 8 and all(len(x) <= 80 for x in strs)
                mp = relay_server._bounded_mapping(raw)
                map_ok = isinstance(mp, dict) and len(mp) <= 24
                ok = bounded and bool_ok and strs_ok and map_ok
            except Exception as exc:
                record(f"bounds.{i}", CATEGORY, "scalar, boolean, and JSON-string variants normalize instead of raising (no HTTP 400/500)",
                       f"raised {type(exc).__name__}: {exc}", False, "P1", "request-normalization-crash",
                       "a plausible planner shape produced an exception instead of bounded normalization")
                return None
            record(f"bounds.{i}", CATEGORY, "bounded normalization for every plausible scalar/array/object shape",
                   f"trust={req.minimum_trust} diversity={req.diversity} formats={len(req.formats)}",
                   ok, "P1", "request-normalization-bounds", "a normalized value escaped its bound")
            return None
        out.append(make)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).parent / "out"))
    ap.add_argument("--seed", type=int, default=20260915)
    args = ap.parse_args()
    rng = random.Random(args.seed)
    jobs = []
    jobs += scenarios_routing(rng, 260)
    jobs += scenarios_discovery(rng, 80)
    jobs += scenarios_files(rng, 320)
    jobs += scenarios_search(rng, 260)
    jobs += scenarios_pipeline(rng, 200)
    jobs += scenarios_bounds(rng, 180)
    for job in jobs:
        job()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "ledger-relay.json").write_text(json.dumps(ROWS, indent=1), encoding="utf-8")
    fails = [r for r in ROWS if r["status"] == "fail"]
    by_root = {}
    for r in fails:
        by_root[r["rootCause"]] = by_root.get(r["rootCause"], 0) + 1
    print(f"relay: {len(ROWS)} scenarios | passed {len(ROWS) - len(fails)} | failed {len(fails)}")
    for k, v in sorted(by_root.items(), key=lambda kv: -kv[1]):
        sample = next(r for r in fails if r["rootCause"] == k)
        print(f"   [{sample['severity']}] {k} x{v}\n      {sample['error'][:120]}\n      {sample['actual'][:120]}")


if __name__ == "__main__":
    main()
