import asyncio
import sys
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2]))

from relay.capabilities import Candidate, CapabilityPipeline, CapabilityRequest


class Adapter:
    def __init__(self, name, claims, score=1, fail=False):
        self.name = name
        self.capabilities = frozenset({"demo.read"})
        self.claims = frozenset(claims)
        self.score = score
        self.fail = fail

    def supports(self, request):
        return True

    async def discover(self, request, context):
        if self.fail:
            raise RuntimeError("provider unavailable")
        return [Candidate({"url": "https://example.test/" + self.name},
                          self.name, self.claims, self.score)]


def test_pipeline_is_registry_based_and_enforces_claims():
    pipeline = CapabilityPipeline()
    pipeline.register(Adapter("unverified", {"readable"}, 100))
    pipeline.register(Adapter("verified", {"readable", "current"}, 10))
    pipeline.register(Adapter("down", {"readable", "current"}, 1000, fail=True))
    request = CapabilityRequest(
        capability="demo.read", query="x", limit=3,
        required_claims=frozenset({"readable", "current"}),
    )
    rows = asyncio.run(pipeline.run(request, None))
    assert [row.provider for row in rows] == ["verified"]


def test_pipeline_rejects_duplicate_adapter_names():
    pipeline = CapabilityPipeline()
    pipeline.register(Adapter("same", {"readable"}))
    try:
        pipeline.register(Adapter("same", {"readable"}))
        assert False, "duplicate should fail"
    except ValueError:
        pass
