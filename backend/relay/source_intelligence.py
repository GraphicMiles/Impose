"""Intent-aware source selection, ranking, escalation, and observations.

Tools answer *how* work is done; this module answers *where* a capability
should look. It consumes structured requirements produced by semantic goal
decomposition and never routes by matching phrases in the user's request.
Provider profiles are data in provider_catalog.json, so adding a source does
not add a planner branch.
"""
from __future__ import annotations

import json
import math
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping
from urllib.parse import urlparse

_METRICS = ("quality", "authority", "freshness", "coverage", "availability",
            "license_clarity", "download_reliability", "trust", "specialization",
            "authenticity", "safety", "version_accuracy")


def _bounded(value: Any, fallback: float = 0.0) -> float:
    try: return max(0.0, min(1.0, float(value)))
    except Exception: return fallback


def _strings(value: Any, limit: int = 20) -> frozenset[str]:
    rows = list(value) if isinstance(value, (list, tuple, set, frozenset)) else ([value] if value else [])
    return frozenset(str(row).strip().lower()[:80] for row in rows[:limit] if str(row).strip())


@dataclass(frozen=True)
class SourceRequirements:
    capability: str
    artifact_type: str = "information"
    formats: frozenset[str] = frozenset()
    source_classes: frozenset[str] = frozenset()
    required_capabilities: frozenset[str] = frozenset({"search"})
    characteristics: frozenset[str] = frozenset()
    priorities: Mapping[str, float] = field(default_factory=dict)
    minimum_trust: float = 0.0
    diversity: int = 1

    @classmethod
    def from_mapping(cls, capability: str, raw: Mapping[str, Any] | None):
        raw = raw if isinstance(raw, Mapping) else {}
        priorities = raw.get("priorities") if isinstance(raw.get("priorities"), Mapping) else {}
        priorities = {str(k): _bounded(v) for k, v in priorities.items() if str(k) in _METRICS}
        return cls(
            capability=str(capability or "search")[:120],
            artifact_type=str(raw.get("artifactType") or raw.get("artifact_type") or "information").lower()[:80],
            formats=_strings(raw.get("formats") or raw.get("format")),
            source_classes=_strings(raw.get("sourceClasses") or raw.get("source_classes")),
            required_capabilities=_strings(raw.get("requiredCapabilities") or raw.get("required_capabilities") or ["search"]),
            characteristics=_strings(raw.get("characteristics")), priorities=priorities,
            minimum_trust=_bounded(raw.get("minimumTrust") or raw.get("minimum_trust")),
            diversity=max(1, min(5, int(raw.get("diversity") or 1))),
        )


@dataclass(frozen=True)
class ProviderProfile:
    id: str
    mechanism: str
    source_classes: frozenset[str]
    artifact_types: frozenset[str]
    formats: frozenset[str]
    capabilities: frozenset[str]
    domains: frozenset[str]
    metrics: Mapping[str, float]
    discovered: bool = False


class PerformanceLedger:
    """Thread-safe EWMA performance observations. Unknown providers begin
    cautiously and can earn rank through verified results, not popularity."""
    def __init__(self):
        self._lock = threading.Lock()
        self._rows: dict[str, dict[str, float]] = {}

    def observe(self, provider: str, *, success: bool, result_quality: float,
                valid_ratio: float = 0.0, latency_ms: int = 0) -> dict[str, float]:
        sample = (0.45 * (1.0 if success else 0.0) + 0.4 * _bounded(result_quality)
                  + 0.15 * _bounded(valid_ratio))
        with self._lock:
            old = self._rows.get(provider, {"performance": 0.5, "observations": 0.0, "latency_ms": 0.0})
            alpha = 0.28 if old["observations"] else 1.0
            row = {"performance": old["performance"] * (1 - alpha) + sample * alpha,
                   "observations": old["observations"] + 1,
                   "latency_ms": old["latency_ms"] * (1 - alpha) + max(0, latency_ms) * alpha}
            self._rows[provider] = row
            return dict(row)

    def get(self, provider: str) -> dict[str, float]:
        with self._lock: return dict(self._rows.get(provider, {}))

    def snapshot(self) -> dict[str, dict[str, float]]:
        with self._lock: return {key: dict(value) for key, value in self._rows.items()}


class ProviderCatalog:
    def __init__(self, path: Path | None = None, ledger: PerformanceLedger | None = None):
        self.path = path or Path(__file__).with_name("provider_catalog.json")
        self.ledger = ledger or PerformanceLedger()
        self.version = 1
        self._providers: dict[str, ProviderProfile] = {}
        self._lock = threading.Lock()
        self._discovered_limit = 500
        self.reload()

    def reload(self):
        data = json.loads(self.path.read_text(encoding="utf-8"))
        rows = data.get("providers") if isinstance(data, dict) else []
        providers = {}
        for raw in rows or []:
            if not isinstance(raw, dict) or not raw.get("id"): continue
            provider = ProviderProfile(
                id=str(raw["id"])[:120], mechanism=str(raw.get("mechanism") or "adapter")[:80],
                source_classes=_strings(raw.get("source_classes")), artifact_types=_strings(raw.get("artifact_types")),
                formats=_strings(raw.get("formats")), capabilities=_strings(raw.get("capabilities")),
                domains=_strings(raw.get("domains")),
                metrics={key: _bounded(raw.get(key), 0.5) for key in _METRICS}, discovered=bool(raw.get("discovered")))
            providers[provider.id] = provider
        with self._lock:
            self._providers, self.version = providers, int(data.get("version") or 1)

    def providers(self) -> tuple[ProviderProfile, ...]:
        with self._lock: return tuple(self._providers.values())
    def get(self, provider: str) -> ProviderProfile | None:
        with self._lock: return self._providers.get(provider)

    def discover(self, url: str, *, artifact_types=(), source_classes=()) -> ProviderProfile | None:
        """Register an encountered domain conservatively. Discovery provides
        coverage, never inherited trust; observations must raise its score."""
        try:
            parsed = urlparse(url)
            host = (parsed.hostname or "").lower().removeprefix("www.")
        except Exception: return None
        # Discovery consumes URLs that came out of an engine. A protocol-relative
        # or scheme-less string still parses to a hostname, which would register a
        # provider nobody asked for, so require an absolute http(s) URL.
        if not host or parsed.scheme.lower() not in ("http", "https"): return None
        pid = "discovered:" + host
        with self._lock:
            if pid not in self._providers:
                discovered_count = sum(profile.discovered for profile in self._providers.values())
                if discovered_count >= self._discovered_limit: return None
                neutral = {key: 0.35 for key in _METRICS}
                neutral.update({"availability": 0.45, "trust": 0.25, "specialization": 0.4})
                self._providers[pid] = ProviderProfile(pid, "discovered_web_source", _strings(source_classes),
                    _strings(artifact_types), frozenset(), frozenset({"search", "source_attribution"}),
                    frozenset({host}), neutral, True)
            return self._providers[pid]


class SourceRouter:
    def __init__(self, catalog: ProviderCatalog | None = None): self.catalog = catalog or ProviderCatalog()

    def score(self, provider: ProviderProfile, request: SourceRequirements) -> tuple[float, list[str]]:
        if request.required_capabilities - provider.capabilities: return -1.0, ["missing required source capability"]
        if provider.metrics.get("trust", 0) < request.minimum_trust: return -1.0, ["below minimum trust"]
        artifact = 1.0 if request.artifact_type in provider.artifact_types else (0.58 if "file" in provider.artifact_types else 0.0)
        if artifact == 0: return -1.0, ["artifact type mismatch"]
        format_fit = 1.0 if not request.formats else (1.0 if request.formats & provider.formats else (0.45 if not provider.formats else 0.0))
        class_fit = 0.72 if not request.source_classes else len(request.source_classes & provider.source_classes) / len(request.source_classes)
        weights = {key: 0.35 for key in _METRICS}
        weights.update({key: 0.35 + 1.65 * value for key, value in request.priorities.items()})
        denom = sum(weights.values()) or 1.0
        metric_score = sum(provider.metrics.get(key, 0.5) * weight for key, weight in weights.items()) / denom
        capability_fit = len(request.required_capabilities & provider.capabilities) / max(1, len(request.required_capabilities))
        base = 0.45 * metric_score + 0.22 * artifact + 0.14 * format_fit + 0.11 * class_fit + 0.08 * capability_fit
        observed = self.catalog.ledger.get(provider.id)
        if observed:
            base *= 0.78 + 0.44 * observed.get("performance", 0.5)
        if provider.discovered: base *= 0.78
        reasons = [f"artifact compatibility {artifact:.2f}", f"source fit {class_fit:.2f}",
                   f"format fit {format_fit:.2f}", f"trust {provider.metrics.get('trust', 0):.2f}"]
        if observed: reasons.append(f"observed performance {observed.get('performance', 0):.2f}")
        return round(_bounded(base), 4), reasons

    def rank(self, request: SourceRequirements, available: Iterable[str] | None = None) -> list[dict[str, Any]]:
        allowed = None if available is None else set(available)
        out = []
        for provider in self.catalog.providers():
            if allowed is not None and provider.id not in allowed: continue
            score, reasons = self.score(provider, request)
            if score < 0: continue
            out.append({"provider": provider.id, "score": score, "mechanism": provider.mechanism,
                        "sourceClasses": sorted(provider.source_classes), "reasons": reasons,
                        "discovered": provider.discovered})
        out.sort(key=lambda row: row["score"], reverse=True)
        return out

    def plan(self, request: SourceRequirements, available: Iterable[str] | None = None) -> dict[str, Any]:
        ranked = self.rank(request, available)
        # Progressive bounded stages: best-fitting pair, reputable alternatives,
        # then remaining broad coverage. Execution stops after a quality pass.
        stages, cursor = [], 0
        for width, label in ((2, "best-fit"), (2, "reputable-alternatives"), (99, "broad-coverage")):
            batch = ranked[cursor:cursor + width]
            if batch: stages.append({"stage": len(stages) + 1, "strategy": label,
                                     "providers": [row["provider"] for row in batch]})
            cursor += width
        return {"catalogVersion": self.catalog.version, "requirements": {
            "capability": request.capability, "artifactType": request.artifact_type,
            "formats": sorted(request.formats), "sourceClasses": sorted(request.source_classes),
            "requiredCapabilities": sorted(request.required_capabilities),
            "characteristics": sorted(request.characteristics), "minimumTrust": request.minimum_trust,
            "diversity": request.diversity}, "candidates": ranked, "stages": stages}

    def observe(self, provider: str, **observation):
        return self.catalog.ledger.observe(provider, **observation)


CATALOG = ProviderCatalog()
ROUTER = SourceRouter(CATALOG)
