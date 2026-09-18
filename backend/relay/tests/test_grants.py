"""The grant-day endpoints: /admin/waitlist and /admin/grant.

The sheet promises "We'll email you when your seat opens," so the grant
email is a kept promise. These tests pin the three properties that make
that safe: the endpoints answer only the operator (CONTROL_KEY), granting
is idempotent (a retry never double-records and never double-mails), and
a failed email is reported honestly instead of pretending the whole flow
landed.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

os.environ.setdefault("CONTROL_KEY", "test123")
os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "service-key-stub")

from fastapi.testclient import TestClient  # noqa: E402

from relay import server, supabase_admin  # noqa: E402

client = TestClient(server.app)
AUTH = {"Authorization": "Bearer test123"}

USER = {"id": "u-111", "email": "waiter@company.com"}


def _stub_admin(monkeypatch, *, found=True, is_new=True):
    calls = {}

    async def find(email):
        calls["find"] = email
        return dict(USER) if found else None

    async def grant(user_id):
        calls["grant"] = user_id
        return is_new

    async def approve(email):
        calls["approve"] = email

    monkeypatch.setattr(supabase_admin, "find_user_by_email", find)
    monkeypatch.setattr(supabase_admin, "grant_workspace", grant)
    monkeypatch.setattr(supabase_admin, "approve_waitlist", approve)
    monkeypatch.setattr(supabase_admin, "configured", lambda: True)
    return calls


def _stub_mail(monkeypatch):
    sent = []

    async def send(email):
        sent.append(email)

    monkeypatch.setattr(server, "send_grant", send)
    return sent


# ------------------------------------------------------------- the gate

def test_waitlist_requires_the_control_key(monkeypatch):
    async def fake_fetch(status="pending", limit=100):
        return []

    monkeypatch.setattr(supabase_admin, "fetch_waitlist", fake_fetch)
    monkeypatch.setattr(supabase_admin, "configured", lambda: True)
    assert client.get("/admin/waitlist").status_code in (401, 403)
    assert client.get("/admin/waitlist",
                      headers={"Authorization": "Bearer wrong"}).status_code in (401, 403)


def test_grant_requires_the_control_key(monkeypatch):
    _stub_admin(monkeypatch)
    assert client.post("/admin/grant", json={"email": USER["email"]}).status_code in (401, 403)


# --------------------------------------------------------- the queue read

def test_waitlist_answers_the_operator(monkeypatch):
    rows = [{"id": "w1", "email": USER["email"], "status": "pending",
             "position": 3, "created_at": "2026-09-18T00:00:00Z",
             "user_id": "u-111"}]

    async def fake_fetch(status="pending", limit=100):
        return rows

    monkeypatch.setattr(supabase_admin, "fetch_waitlist", fake_fetch)
    monkeypatch.setattr(supabase_admin, "configured", lambda: True)
    res = client.get("/admin/waitlist", headers=AUTH)
    assert res.status_code == 200
    body = res.json()
    assert body["count"] == 1
    assert body["waitlist"][0]["position"] == 3


def test_waitlist_rejects_an_unknown_status():
    res = client.get("/admin/waitlist", headers=AUTH, params={"status": "odd"})
    assert res.status_code == 400


# ------------------------------------------------------------ grant day

def test_grant_flips_the_row_and_sends_the_promised_email(monkeypatch):
    calls = _stub_admin(monkeypatch)
    sent = _stub_mail(monkeypatch)
    res = client.post("/admin/grant", headers=AUTH,
                      json={"email": "Waiter@Company.com"})
    assert res.status_code == 200
    body = res.json()
    assert body["granted"] == "new"
    assert body["email"] == "sent"
    assert calls["grant"] == USER["id"]
    assert calls["approve"] == "waiter@company.com"
    assert sent == ["waiter@company.com"]


def test_regrant_is_idempotent_and_silent(monkeypatch):
    _stub_admin(monkeypatch, is_new=False)
    sent = _stub_mail(monkeypatch)
    res = client.post("/admin/grant", headers=AUTH,
                      json={"email": "regrant@company.com"})
    assert res.status_code == 200
    body = res.json()
    assert body["granted"] == "already_granted"
    assert body["email"] == "skipped"
    assert sent == []


def test_regrant_with_notify_resends_the_email(monkeypatch):
    _stub_admin(monkeypatch, is_new=False)
    sent = _stub_mail(monkeypatch)
    res = client.post("/admin/grant", headers=AUTH,
                      json={"email": "regrant@company.com", "notify": True})
    assert res.status_code == 200
    assert res.json()["email"] == "sent"
    assert sent == ["regrant@company.com"]


def test_grant_refuses_an_address_without_an_account(monkeypatch):
    _stub_admin(monkeypatch, found=False)
    sent = _stub_mail(monkeypatch)
    res = client.post("/admin/grant", headers=AUTH,
                      json={"email": "ghost@company.com"})
    assert res.status_code == 404
    assert sent == []


def test_grant_rejects_a_malformed_email(monkeypatch):
    _stub_admin(monkeypatch)
    res = client.post("/admin/grant", headers=AUTH, json={"email": "nope"})
    assert res.status_code == 400


def test_a_failed_email_says_so(monkeypatch):
    from relay.mailer import MailFailed

    _stub_admin(monkeypatch)

    async def broken(email):
        raise MailFailed("provider down")

    monkeypatch.setattr(server, "send_grant", broken)
    res = client.post("/admin/grant", headers=AUTH,
                      json={"email": "mailfail@company.com"})
    assert res.status_code == 502
    assert "notify=true" in res.json()["detail"]


def test_approval_emails_are_rate_limited(monkeypatch):
    _stub_admin(monkeypatch)
    _stub_mail(monkeypatch)
    addr = {"email": "flood@company.com"}
    codes = [client.post("/admin/grant", headers=AUTH, json=addr).status_code
             for _ in range(4)]
    assert codes[:3] == [200, 200, 200]
    assert codes[3] == 429
