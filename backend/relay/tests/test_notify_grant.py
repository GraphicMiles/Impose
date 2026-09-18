"""The browser-facing half of granting: POST /notify/grant.

The admin panel cannot hold CONTROL_KEY, so this endpoint is
authenticated by the caller's own Supabase session instead. The tests pin
the ladder that keeps it safe: no session -> 401, a session that is not an
admin -> 403, an admin mailing an address with no recorded grant -> 409,
and only then does an email go out. It must never grant access itself,
and it shares the grantmail rate bucket with /admin/grant so the two
paths cannot flood an address together.
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

ADMIN = {"id": "admin-1", "email": "owner@company.com"}
TARGET = {"id": "u-222", "email": "invited@company.com"}


def _stub_notify(monkeypatch, *, session=True, can=True,
                 found=True, granted=True):
    calls = {}

    async def verify(token):
        calls["verify_token"] = token
        return dict(ADMIN) if session else None

    async def admin_check(token, action):
        calls["admin_token"] = token
        calls["admin_action"] = action
        return can

    async def find(email):
        calls["find"] = email
        return dict(TARGET) if found else None

    async def has_grant(user_id):
        calls["has_grant"] = user_id
        return granted

    monkeypatch.setattr(supabase_admin, "verify_session", verify)
    monkeypatch.setattr(supabase_admin, "session_can", admin_check)
    monkeypatch.setattr(supabase_admin, "find_user_by_email", find)
    monkeypatch.setattr(supabase_admin, "has_workspace_grant", has_grant)
    monkeypatch.setattr(supabase_admin, "configured", lambda: True)
    return calls


def _stub_mail(monkeypatch):
    sent = []

    async def send(email):
        sent.append(email)

    monkeypatch.setattr(server, "send_grant", send)
    return sent


# ------------------------------------------------------------ the ladder

def test_notify_requires_a_session(monkeypatch):
    _stub_notify(monkeypatch)
    assert client.post("/notify/grant",
                       json={"email": TARGET["email"]}).status_code == 401
    assert client.post("/notify/grant",
                       headers={"Authorization": "Bearer "},
                       json={"email": TARGET["email"]}).status_code == 401


def test_notify_rejects_a_dead_token(monkeypatch):
    _stub_notify(monkeypatch, session=False)
    res = client.post("/notify/grant",
                      headers={"Authorization": "Bearer expired-jwt"},
                      json={"email": TARGET["email"]})
    assert res.status_code == 401


def test_notify_refuses_a_non_admin_session(monkeypatch):
    _stub_notify(monkeypatch, can=False)
    sent = _stub_mail(monkeypatch)
    res = client.post("/notify/grant",
                      headers={"Authorization": "Bearer someone-elses-jwt"},
                      json={"email": TARGET["email"]})
    assert res.status_code == 403
    # Generic refusal: the body must not name admins, capabilities, or any
    # part of the admin system the caller is not entitled to learn about.
    body = res.text.lower()
    for leak in ("company.com", "admin", "capab", "waitlist", "supabase"):
        assert leak not in body, f"refusal leaked {leak!r}"
    assert not sent, "a refused call must not reach the mailer"


def test_notify_refuses_an_address_without_an_account(monkeypatch):
    _stub_notify(monkeypatch, found=False)
    sent = _stub_mail(monkeypatch)
    res = client.post("/notify/grant",
                      headers={"Authorization": "Bearer admin-jwt"},
                      json={"email": "ghost1@company.com"})
    assert res.status_code == 404
    assert sent == []


def test_notify_refuses_to_mail_a_grant_that_was_never_recorded(monkeypatch):
    _stub_notify(monkeypatch, granted=False)
    sent = _stub_mail(monkeypatch)
    res = client.post("/notify/grant",
                      headers={"Authorization": "Bearer admin-jwt"},
                      json={"email": TARGET["email"]})
    assert res.status_code == 409
    assert sent == []


def test_notify_sends_the_email_for_a_recorded_grant(monkeypatch):
    calls = _stub_notify(monkeypatch)
    sent = _stub_mail(monkeypatch)
    res = client.post("/notify/grant",
                      headers={"Authorization": "Bearer admin-jwt"},
                      json={"email": "Invited@Company.com"})
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["email"] == "sent"
    assert body["user_id"] == TARGET["id"]
    assert body["notified_by"] == ADMIN["id"]
    assert sent == [TARGET["email"]]
    # The caller's token is what both checks ran with — never a key.
    assert calls["verify_token"] == "admin-jwt"
    assert calls["admin_token"] == "admin-jwt"
    assert calls["admin_action"] == "notify_grant"


def test_notify_rejects_a_malformed_email(monkeypatch):
    _stub_notify(monkeypatch)
    res = client.post("/notify/grant",
                      headers={"Authorization": "Bearer admin-jwt"},
                      json={"email": "nope"})
    assert res.status_code == 400


def test_notify_rejects_a_blocked_provider(monkeypatch):
    _stub_notify(monkeypatch)
    res = client.post("/notify/grant",
                      headers={"Authorization": "Bearer admin-jwt"},
                      json={"email": "someone@test.com"})
    assert res.status_code == 400


def test_notify_says_so_when_the_email_fails(monkeypatch):
    from relay.mailer import MailFailed

    _stub_notify(monkeypatch)

    async def broken(email):
        raise MailFailed("provider down")

    monkeypatch.setattr(server, "send_grant", broken)
    res = client.post("/notify/grant",
                      headers={"Authorization": "Bearer admin-jwt"},
                      json={"email": "mailfail1@company.com"})
    assert res.status_code == 502
    assert "approval email failed" in res.json()["detail"]


def test_notify_answers_503_when_accounts_are_not_configured(monkeypatch):
    _stub_notify(monkeypatch)
    monkeypatch.setattr(supabase_admin, "configured", lambda: False)
    res = client.post("/notify/grant",
                      headers={"Authorization": "Bearer admin-jwt"},
                      json={"email": "noconfig@company.com"})
    assert res.status_code == 503


def test_notify_shares_the_grantmail_rate_bucket(monkeypatch):
    """Three emails per address per ten minutes, counted across BOTH the
    operator path and the panel path."""
    _stub_notify(monkeypatch)
    _stub_mail(monkeypatch)
    addr = {"email": "flood2@company.com"}
    hdrs = {"Authorization": "Bearer admin-jwt"}
    codes = [client.post("/notify/grant", headers=hdrs, json=addr).status_code
             for _ in range(4)]
    assert codes[:3] == [200, 200, 200]
    assert codes[3] == 429
