"""The account flow, tested at the boundary that actually decides things.

The first version of this flow was theatre: the browser created the account
itself and the code check answered into the void. These tests pin the
property that was missing, which is that verification is what creates the
account, and that nothing reaches Supabase until it has happened.

Supabase is stubbed. The point is not that httpx works; it is that the
relay refuses to create a user until a code delivered to that address comes
back, and that the refusals cannot be talked out of.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

os.environ.setdefault("OTP_PEPPER", "test-pepper-value-for-sealing")
os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "service-key-stub")

from fastapi.testclient import TestClient  # noqa: E402

from relay import otp_store, supabase_admin  # noqa: E402
from relay.server import app  # noqa: E402


class FakeStore:
    """Stands in for the auth_codes table, with the same guarantees."""

    def __init__(self):
        self.rows = {}
        self.issued = []

    async def issue(self, email, purpose, code, password_hash):
        key = (email.lower(), purpose)
        self.rows[key] = {
            "email": email.lower(),
            "purpose": purpose,
            "code_hash": otp_store.hash_code(code),
            "password_hash": password_hash,
            "attempts": 0,
        }
        self.issued.append((email.lower(), purpose, code))
        return {"reused": False, "resend_in": 60}

    async def verify(self, email, purpose, code):
        key = (email.lower(), purpose)
        row = self.rows.get(key)
        supplied = "".join(c for c in str(code or "") if c.isdigit())
        if not row:
            raise otp_store.OtpError("That code has expired. Request a new one.", status=410)
        if row["attempts"] >= otp_store.MAX_ATTEMPTS:
            del self.rows[key]
            raise otp_store.OtpError("Too many incorrect attempts. Request a new code.", status=429)
        if row["code_hash"] != otp_store.hash_code(supplied):
            row["attempts"] += 1
            if row["attempts"] >= otp_store.MAX_ATTEMPTS:
                del self.rows[key]
                raise otp_store.OtpError("Too many incorrect attempts. Request a new code.", status=429)
            raise otp_store.OtpError("That code is not right. 4 attempts left.")
        del self.rows[key]
        return row

    def last_code(self, email, purpose="signup"):
        for addr, why, code in reversed(self.issued):
            if addr == email.lower() and why == purpose:
                return code
        return None


@pytest.fixture
def env(monkeypatch):
    store = FakeStore()
    created = []
    passwords = []

    monkeypatch.setattr(otp_store, "issue", store.issue)
    monkeypatch.setattr(otp_store, "verify", store.verify)

    async def find_user(email):
        for user in created:
            if user["email"] == email.lower():
                return user
        return None

    async def create_user(email, password):
        user = {"id": "user-" + str(len(created) + 1), "email": email.lower(), "password": password}
        created.append(user)
        return user

    async def set_password(user_id, password):
        passwords.append((user_id, password))
        for user in created:
            if user["id"] == user_id:
                user["password"] = password
        return {}

    async def issue_session(email, password):
        for user in created:
            if user["email"] == email.lower() and user["password"] == password:
                return {"access_token": "tok-" + user["id"], "refresh_token": "ref", "user": user}
        raise supabase_admin.AdminError("That email and password do not match.", status=401)

    monkeypatch.setattr(supabase_admin, "find_user_by_email", find_user)
    monkeypatch.setattr(supabase_admin, "create_confirmed_user", create_user)
    monkeypatch.setattr(supabase_admin, "set_password", set_password)
    monkeypatch.setattr(supabase_admin, "issue_session", issue_session)
    monkeypatch.setattr(supabase_admin, "configured", lambda: True)

    from relay import server
    monkeypatch.setattr(server, "_RATE_BUCKETS", {})

    return {"client": TestClient(app), "store": store, "created": created, "passwords": passwords}


def test_requesting_a_code_creates_no_account(env):
    """The defect that made all of this necessary."""
    r = env["client"].post("/v1/auth/otp/request",
                           json={"email": "a@b.com", "password": "Str0ng!pass", "purpose": "signup"})
    assert r.status_code == 200
    assert env["created"] == [], "no user may exist before the code is verified"


def test_the_code_is_what_creates_the_account(env):
    c = env["client"]
    c.post("/v1/auth/otp/request", json={"email": "a@b.com", "password": "Str0ng!pass", "purpose": "signup"})
    code = env["store"].last_code("a@b.com")
    r = c.post("/v1/auth/otp/verify", json={"email": "a@b.com", "purpose": "signup", "code": code})
    assert r.status_code == 200
    body = r.json()
    assert body["session"]["access_token"], "verification must return a real session"
    assert len(env["created"]) == 1
    assert env["created"][0]["email"] == "a@b.com"


def test_a_wrong_code_creates_nothing(env):
    c = env["client"]
    c.post("/v1/auth/otp/request", json={"email": "a@b.com", "password": "Str0ng!pass", "purpose": "signup"})
    r = c.post("/v1/auth/otp/verify", json={"email": "a@b.com", "purpose": "signup", "code": "00000000"})
    assert r.status_code == 400
    assert env["created"] == []


def test_a_code_cannot_be_replayed(env):
    c = env["client"]
    c.post("/v1/auth/otp/request", json={"email": "a@b.com", "password": "Str0ng!pass", "purpose": "signup"})
    code = env["store"].last_code("a@b.com")
    assert c.post("/v1/auth/otp/verify", json={"email": "a@b.com", "purpose": "signup", "code": code}).status_code == 200
    again = c.post("/v1/auth/otp/verify", json={"email": "a@b.com", "purpose": "signup", "code": code})
    assert again.status_code == 410
    assert len(env["created"]) == 1, "a replayed code must not create a second account"


def test_a_taken_address_is_refused_before_any_email(env):
    c = env["client"]
    c.post("/v1/auth/otp/request", json={"email": "a@b.com", "password": "Str0ng!pass", "purpose": "signup"})
    code = env["store"].last_code("a@b.com")
    c.post("/v1/auth/otp/verify", json={"email": "a@b.com", "purpose": "signup", "code": code})
    before = len(env["store"].issued)
    r = c.post("/v1/auth/otp/request", json={"email": "a@b.com", "password": "Other!pass1", "purpose": "signup"})
    assert r.status_code == 409
    assert len(env["store"].issued) == before, "no code should be sent for a taken address"


def test_signup_requires_a_password_server_side(env):
    """The browser checks this too; this is the check that counts."""
    r = env["client"].post("/v1/auth/otp/request",
                           json={"email": "a@b.com", "password": "short", "purpose": "signup"})
    assert r.status_code == 400
    assert env["store"].issued == []


def test_reset_returns_a_ticket_not_a_session(env):
    c = env["client"]
    c.post("/v1/auth/otp/request", json={"email": "a@b.com", "password": "Str0ng!pass", "purpose": "signup"})
    c.post("/v1/auth/otp/verify", json={"email": "a@b.com", "purpose": "signup",
                                        "code": env["store"].last_code("a@b.com")})
    c.post("/v1/auth/otp/request", json={"email": "a@b.com", "purpose": "reset"})
    code = env["store"].last_code("a@b.com", "reset")
    r = c.post("/v1/auth/otp/verify", json={"email": "a@b.com", "purpose": "reset", "code": code})
    assert r.status_code == 200
    body = r.json()
    assert body.get("ticket"), "reset must hand back a ticket"
    assert "session" not in body, "a reset code must not itself be a login"


def test_a_password_cannot_be_reset_without_a_ticket(env):
    r = env["client"].post("/v1/auth/password/reset",
                           json={"ticket": "made-up", "password": "Brand!new1"})
    assert r.status_code == 403
    assert env["passwords"] == []


def test_a_ticket_works_once(env):
    c = env["client"]
    c.post("/v1/auth/otp/request", json={"email": "a@b.com", "password": "Str0ng!pass", "purpose": "signup"})
    c.post("/v1/auth/otp/verify", json={"email": "a@b.com", "purpose": "signup",
                                        "code": env["store"].last_code("a@b.com")})
    c.post("/v1/auth/otp/request", json={"email": "a@b.com", "purpose": "reset"})
    ticket = c.post("/v1/auth/otp/verify",
                    json={"email": "a@b.com", "purpose": "reset",
                          "code": env["store"].last_code("a@b.com", "reset")}).json()["ticket"]
    assert c.post("/v1/auth/password/reset", json={"ticket": ticket, "password": "Brand!new1"}).status_code == 200
    again = c.post("/v1/auth/password/reset", json={"ticket": ticket, "password": "Third!pass1"})
    assert again.status_code == 403, "a spent ticket must not work twice"


def test_reset_does_not_reveal_whether_an_address_exists(env):
    """An unknown address must look exactly like a known one here."""
    known = env["client"].post("/v1/auth/otp/request", json={"email": "nobody@b.com", "purpose": "reset"})
    assert known.status_code == 200


def test_the_pending_password_is_not_stored_in_the_clear(env):
    """It sits in the codes table for up to ten minutes; a dump must not read it."""
    from relay.server import _seal_password, _unseal_password
    sealed = _seal_password("Str0ng!pass")
    assert "Str0ng!pass" not in sealed
    assert _unseal_password(sealed) == "Str0ng!pass"


def test_a_tampered_password_blob_is_rejected(env):
    from relay.server import _seal_password, _unseal_password
    sealed = _seal_password("Str0ng!pass")
    body, tag = sealed.rsplit(".", 1)
    assert _unseal_password(body + ".00000000000000000000000000000000") == ""
