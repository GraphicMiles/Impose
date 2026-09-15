"""Reusable discovery -> verification -> ranking pipeline.

Adapters discover typed candidates and attach only the guarantees they can
prove (for example ``playable``, ``live`` or ``latest``). The pipeline applies
request constraints, deduplicates, and ranks. Adding another web capability
means registering another adapter; callers do not gain another pile of
provider-specific conditionals.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Mapping, Protocol


@dataclass(frozen=True)
class CapabilityRequest:
    capability: str
    query: str
    limit: int
    subject: str = ""
    platforms: frozenset[str] = frozenset()
    required_claims: frozenset[str] = frozenset()
    options: Mapping[str, Any] = field(default_factory=dict)


@dataclass
class Candidate:
    value: dict[str, Any]
    provider: str
    claims: frozenset[str] = frozenset()
    score: float = 0.0


class Adapter(Protocol):
    name: str
    capabilities: frozenset[str]

    def supports(self, request: CapabilityRequest) -> bool: ...

    async def discover(self, request: CapabilityRequest, context: Any) -> list[Candidate]: ...


class CapabilityPipeline:
    """Provider-neutral orchestration with fail-closed claim enforcement."""

    def __init__(self) -> None:
        self._adapters: list[Adapter] = []

    def register(self, adapter: Adapter) -> Adapter:
        if not adapter.name or not adapter.capabilities:
            raise ValueError("capability adapters need a name and capabilities")
        if any(existing.name == adapter.name for existing in self._adapters):
            raise ValueError("duplicate capability adapter: " + adapter.name)
        self._adapters.append(adapter)
        return adapter

    @property
    def adapters(self) -> tuple[Adapter, ...]:
        return tuple(self._adapters)

    async def run(self, request: CapabilityRequest, context: Any) -> list[Candidate]:
        selected = [adapter for adapter in self._adapters
                    if request.capability in adapter.capabilities and adapter.supports(request)]
        batches = await asyncio.gather(
            *(adapter.discover(request, context) for adapter in selected),
            return_exceptions=True,
        )
        candidates: list[Candidate] = []
        for batch in batches:
            if isinstance(batch, BaseException):
                continue
            candidates.extend(batch)

        required = request.required_claims
        candidates = [item for item in candidates if required.issubset(item.claims)]
        candidates.sort(key=lambda item: item.score, reverse=True)

        out: list[Candidate] = []
        seen: set[str] = set()
        # The bound is checked before appending: a caller asking for zero
        # results must get zero, not the first candidate.
        for item in candidates:
            if len(out) >= max(0, int(request.limit or 0)):
                break
            value = item.value
            key = str(value.get("url") or value.get("id") or "")
            if not key or key in seen:
                continue
            seen.add(key)
            out.append(item)
        return out
