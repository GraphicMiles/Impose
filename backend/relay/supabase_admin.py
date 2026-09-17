"""Supabase admin calls, made with the service role key.

This module exists because the first version of the signup flow had no
server side at all. The browser called supabase.auth.signUp() directly,
Supabase handed back a session on the spot, and the one-time code was
checked afterwards by an endpoint whose answer nothing consumed. Skipping
the code entirely produced a confirmed, fully authenticated account.

So the trust boundary moves here. Public signup is turned off in the
dashboard, which leaves the service role as the only thing that can mint a
user, and the service role key never leaves this process. A browser can ask
for an account; it cannot create one.

The key is the most dangerous credential in the system: it bypasses RLS
entirely. Three rules follow from that and are enforced below rather than
documented and hoped for:

  1. It is read from the environment, never logged, and never returned in
     a response body, not even in an error.
  2. Only the narrow operations this flow needs are exposed. There is no
     general "run any admin query" helper for a future caller to misuse.
  3. Every function here is called only after a code has been verified.
     The call sites are in server.py and there are three of them.
"""
from __future__ import annotations

import os

import httpx

TIMEOUT = 20.0


class AdminError(Exception):
    """A Supabase admin call failed.

    `safe` is shown to the user; `detail` is logged server side only,
    because Supabase error bodies sometimes name whether an address exists
    and that is not the browser's business.
    """

    def __init__(self, safe: str, detail: str = "", status: int = 502):
        super().__init__(safe)
        self.safe = safe
        self.detail = detail or safe
        self.status = status


def _url() -> str:
    value = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    if not value:
        raise AdminError(
            "Accounts are not configured on the server.",
            "SUPABASE_URL is unset",
            status=503,
        )
    return value


def _service_key() -> str:
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not key:
        raise AdminError(
            "Accounts are not configured on the server.",
            "SUPABASE_SERVICE_KEY is unset",
            status=503,
        )
    return key


def configured() -> bool:
    return bool(
        os.environ.get("SUPABASE_URL", "").strip()
        and os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    )


def _headers() -> dict:
    key = _service_key()
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


async def _request(method: str, path: str, *, json_body=None, params=None) -> dict:
    url = _url() + path
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.request(
                method, url, headers=_headers(), json=json_body, params=params
            )
    except httpx.HTTPError as exc:
        raise AdminError(
            "Could not reach the accounts service. Try again shortly.",
            f"{method} {path} transport error: {exc}",
        ) from exc

    if response.status_code >= 400:
        # Body goes to the server log, never to the caller.
        raise AdminError(
            "That did not work. Try again shortly.",
            f"{method} {path} -> {response.status_code} {response.text[:400]}",
            status=502,
        )
    if not response.content:
        return {}
    try:
        return response.json()
    except ValueError:
        return {}


async def find_user_by_email(email: str) -> dict | None:
    """Return the user record for an address, or None.

    Used to decide create-or-refuse without asking the browser to tell us
    whether the account exists.
    """
    data = await _request(
        "GET", "/auth/v1/admin/users", params={"page": 1, "per_page": 200, "filter": email}
    )
    users = data.get("users") if isinstance(data, dict) else None
    if not users:
        return None
    target = email.strip().lower()
    for user in users:
        if str(user.get("email", "")).strip().lower() == target:
            return user
    return None


async def create_pending_user(email: str, password: str) -> dict:
    """Create the account up front, unconfirmed and therefore unusable.

    This is what removes the need to store the password anywhere of our
    own. The earlier design held it in the codes table, encrypted, until
    verification; that meant a decryptable password sat in a row for ten
    minutes and OTP_PEPPER became a key whose loss was a breach. Supabase
    hashes the password the moment it arrives here, and it is never written
    anywhere else.

    email_confirm is false, so the account cannot sign in. Confirmation is
    the single flag that verification flips, which makes the code the only
    thing standing between a request and a usable account.
    """
    return await _request(
        "POST",
        "/auth/v1/admin/users",
        json_body={
            "email": email,
            "password": password,
            "email_confirm": False,
        },
    )


async def confirm_user(user_id: str) -> dict:
    """Mark the address verified. Called only after a code is consumed."""
    return await _request(
        "PUT",
        f"/auth/v1/admin/users/{user_id}",
        json_body={"email_confirm": True},
    )


async def delete_user(user_id: str) -> None:
    """Remove an unconfirmed account.

    A pending signup that is never completed must not squat the address
    forever, and a failed send must not leave a ghost the user cannot get
    past. Best effort: a failure here is logged, not surfaced.
    """
    try:
        await _request("DELETE", f"/auth/v1/admin/users/{user_id}")
    except AdminError as exc:
        print(f"[auth] could not remove pending user {user_id}: {exc.detail}")


async def set_password(user_id: str, password: str) -> dict:
    """Set a user's password. Used by the reset flow, after verification."""
    return await _request(
        "PUT",
        f"/auth/v1/admin/users/{user_id}",
        json_body={"password": password},
    )


async def issue_session(email: str, password: str) -> dict:
    """Exchange credentials for a session, so signup lands signed in.

    Deliberately uses the ordinary password grant rather than minting a
    token by hand: Supabase stays the authority on what a valid session
    looks like, and nothing here has to know how to sign one.
    """
    url = _url() + "/auth/v1/token"
    key = _service_key()
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                url,
                params={"grant_type": "password"},
                headers={"apikey": key, "Content-Type": "application/json"},
                json={"email": email, "password": password},
            )
    except httpx.HTTPError as exc:
        raise AdminError(
            "Could not reach the accounts service. Try again shortly.",
            f"token grant transport error: {exc}",
        ) from exc

    if response.status_code >= 400:
        raise AdminError(
            "That email and password do not match.",
            f"token grant -> {response.status_code} {response.text[:300]}",
            status=401,
        )
    return response.json()
