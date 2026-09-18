"""The moderation queue endpoint.

Reports are a reader's only recourse against abuse, so the pin here is
twofold: the queue must answer the operator, and it must answer NOBODY
else. The table itself has no client policies; this endpoint is the one
place a read becomes possible, so its gate is the whole gate.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

os.environ.setdefault("CONTROL_KEY", "test123")
os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "service-key-stub")

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from relay import reports_store  # noqa: E402
from relay.server import app  # noqa: E402

client = TestClient(app)
AUTH = {"Authorization": "Bearer test123"}

_ROWS = [
    {"id": "r1", "kind": "post", "target_id": "g1", "reporter_id": "u1",
     "reason": None, "status": "pending", "created_at": "2026-09-18T00:00:00Z",
     "reporter": {"handle": "accuser", "display_name": "Accuser"}},
]


def test_reports_require_the_control_key(monkeypatch):
    """No key, wrong key: the queue does not even admit it exists."""
    async def fake_fetch(status="pending", limit=50):
        return _ROWS

    monkeypatch.setattr(reports_store, "fetch", fake_fetch)
    assert client.get("/admin/reports").status_code in (401, 403)
    assert client.get("/admin/reports",
                      headers={"Authorization": "Bearer wrong"}).status_code in (401, 403)


def test_reports_answer_the_operator(monkeypatch):
    async def fake_fetch(status="pending", limit=50):
        return _ROWS

    monkeypatch.setattr(reports_store, "fetch", fake_fetch)
    res = client.get("/admin/reports", headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert body["count"] == 1
    assert body["reports"][0]["reporter"]["handle"] == "accuser"


def test_reports_pass_status_and_limit_through(monkeypatch):
    seen = {}

    async def fake_fetch(status="pending", limit=50):
        seen["status"] = status
        seen["limit"] = limit
        return []

    monkeypatch.setattr(reports_store, "fetch", fake_fetch)
    res = client.get("/admin/reports?status=dismissed&limit=5", headers=AUTH)
    assert res.status_code == 200
    assert seen == {"status": "dismissed", "limit": 5}


def test_store_rejects_unknown_status():
    """Validation before any network hop: a typo must not become a query."""
    import asyncio

    with pytest.raises(reports_store.ReportsError):
        asyncio.run(reports_store.fetch(status="burned"))
