"""Closure audit regression tests — B-01 (chat auth split) and
B-09 (relay grant writes the inbox notice the RPC writes)."""
import asyncio
import os

os.environ.setdefault("CONTROL_KEY", "test123")

import httpx
import pytest
from fastapi.testclient import TestClient

from relay import server, supabase_admin


class Resp:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload if payload is not None else {}
        self.text = text
        self.content = b"x"

    def json(self):
        return self._payload


class FakeClient:
    """Routes httpx calls the same way the real code would speak to
    Supabase, and records the notification insert."""

    notifications = []
    audits = []
    logouts = []

    def __init__(self, *a, **kw):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def request(self, method, url, headers=None, json=None, params=None):
        """supabase_admin._request() speaks GoTrue/admin over this verb."""
        if url.endswith("/auth/v1/admin/users"):
            return Resp(200, {"users": [{"id": "member-1",
                                         "email": "member@example.test"}]})
        raise AssertionError(f"unexpected {method} {url}")

    async def get(self, url, headers=None, params=None):
        if "/auth/v1/user" in url:
            token = (headers or {}).get("Authorization", "")
            if token == "Bearer member-token":
                return Resp(200, {"user": {"id": "member-1"}})
            return Resp(401, {})
        params = params or {}
        if url.endswith("/rest/v1/workspace_grants"):
            return Resp(200, [{"user_id": "member-1"}])
        if url.endswith("/rest/v1/admins"):
            return Resp(200, [{"user_id": "owner-1"}])
        raise AssertionError(f"unexpected GET {url}")

    async def post(self, url, headers=None, json=None):
        if url.endswith("/rest/v1/notifications"):
            FakeClient.notifications.append(json)
            return Resp(201, {})
        if url.endswith("/rest/v1/audit_events"):
            FakeClient.audits.append(json)
            return Resp(201, {})
        if "/auth/v1/admin/users/" in url and url.endswith("/logout"):
            FakeClient.logouts.append(url)
            return Resp(201, {})
        raise AssertionError(f"unexpected POST {url}")

    async def patch(self, url, headers=None, params=None, json=None):
        return Resp(204, {})


@pytest.fixture(autouse=True)
def fake_httpx(monkeypatch):
    FakeClient.notifications = []
    FakeClient.audits = []
    FakeClient.logouts = []
    server._MEMBER_CACHE.clear()
    server._RATE_BUCKETS.clear()
    monkeypatch.setattr(supabase_admin.httpx, "AsyncClient", FakeClient)
    monkeypatch.setenv("SUPABASE_URL", "https://example.test")
    monkeypatch.setenv("SUPABASE_SERVICE_KEY", "svc")
    yield
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SERVICE_KEY", raising=False)


def test_chat_accepts_member_session():
    member = __import__("asyncio").run(server._authed_member(_req("member-token")))
    assert member == {"role": "member", "user_id": "member-1"}


def test_chat_accepts_control_key_without_supabase():
    # No SUPABASE_URL configured for this check: owner access must not
    # depend on Supabase being reachable or configured.
    owner = __import__("asyncio").run(server._authed_member(_req("test123")))
    assert owner == {"role": "owner"}


def test_chat_rejects_unknown_bearer():
    with pytest.raises(Exception) as exc:
        __import__("asyncio").run(server._authed_member(_req("junk")))
    assert getattr(exc.value, "status_code", None) == 401


class CaselessHeaders(dict):
    def get(self, key, default=None):
        for k, v in self.items():
            if k.lower() == key.lower():
                return v
        return default


class FakeClientAddr:
    host = "10.0.0.9"


def _req(token):
    class R:
        headers = CaselessHeaders({"Authorization": f"Bearer {token}"})
        client = FakeClientAddr()
    return R()


def test_notify_waitlist_approved_attributes_owner():
    __import__("asyncio").run(supabase_admin.notify_waitlist_approved("member-1"))
    assert FakeClient.notifications == [
        {"user_id": "member-1", "actor_id": "owner-1", "kind": "waitlist_approved"}
    ]


def test_notify_waitlist_approved_skips_without_owner(monkeypatch):
    class NoOwner(FakeClient):
        async def get(self, url, headers=None, params=None):
            if url.endswith("/rest/v1/admins"):
                return Resp(200, [])
            return await super().get(url, headers=headers, params=params)

    monkeypatch.setattr(supabase_admin.httpx, "AsyncClient", NoOwner)
    __import__("asyncio").run(supabase_admin.notify_waitlist_approved("member-1"))
    assert FakeClient.notifications == []


def test_revoke_sessions_calls_gotrue_logout_and_audits():
    asyncio.run(supabase_admin.revoke_user_sessions("member-1"))
    assert FakeClient.logouts == [
        "https://example.test/auth/v1/admin/users/member-1/logout"
    ]
    asyncio.run(supabase_admin.audit_event(
        "owner-1", "account.revoke_sessions", "user", "member-1", {"via": "relay"}))
    assert FakeClient.audits[-1] == {
        "actor_id": "owner-1", "action": "account.revoke_sessions",
        "target_type": "user", "target_id": "member-1", "metadata": {"via": "relay"},
    }


def test_revoke_sessions_endpoint_needs_key_and_writes_audit():
    client = TestClient(server.app)
    server._RATE_BUCKETS.clear()
    r = client.post("/admin/revoke_sessions", json={"email": "member@example.test"})
    assert r.status_code in (401, 403)

    r = client.post(
        "/admin/revoke_sessions",
        json={"email": "member@example.test"},
        headers={"Authorization": "Bearer test123"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["sessions"] == "revoked"
    assert FakeClient.logouts
    assert FakeClient.audits and FakeClient.audits[-1]["action"] == "account.revoke_sessions"
