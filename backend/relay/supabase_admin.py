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


# ---------- workspace grants + waitlist (service role over PostgREST) ----------
# Grants are inserted by the operator, never by a client; the table has no
# client policies, so only this key can write it. These helpers are the
# relay side of the "grant day" flow: flip the grant, mark the waitlist row
# approved, and the approval email goes out.

def _postgrest_headers() -> dict:
    key = _service_key()
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


async def grant_workspace(user_id: str) -> bool:
    """Insert a workspace grant. Returns True only if the row is new.

    Idempotent by construction: a second grant for the same user is ignored
    (ignore-duplicates), so a retried approval never double-sends or errors.
    The caller uses the True/False to decide whether the email should go out.
    """
    url = _url() + "/rest/v1/workspace_grants"
    headers = _postgrest_headers()
    headers["Prefer"] = "resolution=ignore-duplicates,return=representation"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                url, headers=headers, json={"user_id": user_id}
            )
    except httpx.HTTPError as exc:
        raise AdminError(
            "Could not reach the accounts service. Try again shortly.",
            f"grant insert transport error: {exc}",
        ) from exc
    if response.status_code >= 400:
        raise AdminError(
            "The grant could not be recorded. Try again shortly.",
            f"grant insert -> {response.status_code} {response.text[:400]}",
            status=502,
        )
    try:
        rows = response.json()
    except ValueError:
        rows = []
    return bool(rows)


async def approve_waitlist(email: str) -> None:
    """Mark the waitlist row for an address as approved.

    Best-effort bookkeeping: a join stores the email, and this flips its
    status so the queue reflects reality. A missing row (someone granted
    without joining) is not an error.
    """
    url = _url() + "/rest/v1/waitlist"
    headers = _postgrest_headers()
    headers["Prefer"] = "return=minimal"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            await client.patch(
                url,
                headers=headers,
                params={"email": f"eq.{email}"},
                json={"status": "approved"},
            )
    except httpx.HTTPError as exc:
        raise AdminError(
            "Could not reach the accounts service. Try again shortly.",
            f"waitlist update transport error: {exc}",
        ) from exc


async def fetch_waitlist(status: str = "pending", limit: int = 100) -> list:
    """The waitlist queue for the operator, oldest first.

    Service role only: the table has no client policies, so this read is
    the one place the queue becomes visible outside the database.
    """
    url = _url() + "/rest/v1/waitlist"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.get(
                url,
                headers=_postgrest_headers(),
                params={
                    "status": f"eq.{status}",
                    "order": "created_at.asc",
                    "limit": str(max(1, min(limit, 500))),
                    "select": "id,email,status,position,created_at,user_id",
                },
            )
    except httpx.HTTPError as exc:
        raise AdminError(
            "Could not reach the accounts service. Try again shortly.",
            f"waitlist read transport error: {exc}",
        ) from exc
    if response.status_code >= 400:
        raise AdminError(
            "The waitlist could not be read. Try again shortly.",
            f"waitlist read -> {response.status_code} {response.text[:400]}",
            status=502,
        )
    try:
        rows = response.json()
    except ValueError:
        rows = []
    return rows if isinstance(rows, list) else []


# --- admin-actor checks, authenticated by the caller's own session -------
#
# The admin panel runs in a browser that must never hold the relay's
# CONTROL_KEY. These helpers let the relay answer two questions about a
# Supabase JWT instead: who owns it, and does that account sit in the
# admins table. The service key is used only as the apikey PostgREST and
# GoTrue require; the Authorization header always carries the caller's
# token, so every check below is evaluated in the caller's own context.


async def verify_session(access_token: str) -> dict | None:
    """Ask GoTrue who owns this token. None means invalid or expired."""
    url = _url() + "/auth/v1/user"
    headers = {
        "apikey": _service_key(),
        "Authorization": f"Bearer {access_token}",
    }
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.get(url, headers=headers)
    except httpx.HTTPError as exc:
        raise AdminError(
            "Could not reach the accounts service. Try again shortly.",
            f"session verify transport error: {exc}",
        ) from exc
    if response.status_code >= 400:
        return None
    try:
        body = response.json()
    except ValueError:
        return None
    return body.get("user") if isinstance(body, dict) else None


async def session_is_admin(access_token: str) -> bool:
    """Evaluate is_admin() in the caller's own context.

    The function itself checks auth.uid() against the admins table and is
    executable only by the authenticated role, so neither a forged token
    nor an ordinary account can get a true out of it.
    """
    url = _url() + "/rest/v1/rpc/is_admin"
    headers = _headers()
    headers["Authorization"] = f"Bearer {access_token}"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(url, headers=headers, json={})
    except httpx.HTTPError as exc:
        raise AdminError(
            "Could not reach the accounts service. Try again shortly.",
            f"is_admin transport error: {exc}",
        ) from exc
    if response.status_code >= 400:
        return False
    try:
        return response.json() is True
    except ValueError:
        return False


async def session_can(access_token: str, action: str) -> bool:
    """Ask Postgres, in the caller's own context, whether this session may
    perform the named action.

    Capability-based authorization for session-authenticated endpoints:
    the answer comes from can_do(), which resolves the action through the
    admin_action_caps contract and checks the caller's grants, reading
    auth.uid() off this very token. Neither a forged client nor an
    ordinary account can produce a true, and the endpoint never
    re-implements the rule the RPCs enforce.
    """
    url = _url() + "/rest/v1/rpc/can_do"
    headers = _headers()
    headers["Authorization"] = f"Bearer {access_token}"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(url, headers=headers, json={"p_action": action})
    except httpx.HTTPError as exc:
        raise AdminError(
            "Could not reach the accounts service. Try again shortly.",
            f"can_do transport error: {exc}",
        ) from exc
    if response.status_code >= 400:
        return False
    try:
        return response.json() is True
    except ValueError:
        return False


async def notify_waitlist_approved(user_id: str) -> None:
    """In-app notice for a fresh grant, mirroring the admin_grant RPC.

    Closure audit B-09: the panel's RPC path inserts
    notifications(kind='waitlist_approved'); the relay's /admin/grant path
    silently recorded the grant and sent nothing, so a member granted from
    the operator console got a working account with no inbox notice. This
    restores parity between the two write surfaces.

    actor_id is NOT NULL -> profiles, and the CONTROL_KEY carries no admin
    identity, so the notice is attributed to the owner admin — the control
    key is the owner's tool, which makes that attribution true. With no
    owner row (pre-bootstrap) the note is skipped rather than forged.
    """
    owners = await list_admin_owners()
    if not owners:
        print("[admin] inbox notice skipped: no owner admin to attribute", flush=True)
        return
    url = _url() + "/rest/v1/notifications"
    headers = _postgrest_headers()
    headers["Prefer"] = "return=minimal"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                url,
                headers=headers,
                json={"user_id": user_id, "actor_id": owners[0],
                      "kind": "waitlist_approved"},
            )
    except httpx.HTTPError as exc:
        raise AdminError(
            "The grant is recorded but the inbox notice could not be written.",
            f"notification insert transport error: {exc}",
        ) from exc
    if response.status_code >= 400:
        raise AdminError(
            "The grant is recorded but the inbox notice could not be written.",
            f"notification insert -> {response.status_code} {response.text[:400]}",
            status=502,
        )


async def list_admin_owners() -> list:
    """User ids of owner admins, service role only. The table has no client
    policies; this read exists to attribute operator actions taken with the
    CONTROL_KEY to the owner, exactly as the RPC attributes panel actions
    to auth.uid()."""
    url = _url() + "/rest/v1/admins"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.get(
                url,
                headers=_postgrest_headers(),
                params={"owner": "is.true", "select": "user_id", "limit": "5"},
            )
    except httpx.HTTPError as exc:
        raise AdminError(
            "Could not reach the accounts service. Try again shortly.",
            f"owner read transport error: {exc}",
        ) from exc
    if response.status_code >= 400:
        raise AdminError(
            "Could not reach the accounts service. Try again shortly.",
            f"owner read -> {response.status_code} {response.text[:400]}",
            status=502,
        )
    try:
        rows = response.json()
    except ValueError:
        rows = []
    return [r["user_id"] for r in rows if isinstance(r, dict) and r.get("user_id")]


async def has_workspace_grant(user_id: str) -> bool:
    """Whether the workspace grant row exists. Service role only; the table
    has no client policies, and this read is what lets /notify/grant refuse
    to send mail for access that was never actually recorded."""
    url = _url() + "/rest/v1/workspace_grants"
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.get(
                url,
                headers=_postgrest_headers(),
                params={"user_id": f"eq.{user_id}", "select": "user_id"},
            )
    except httpx.HTTPError as exc:
        raise AdminError(
            "Could not reach the accounts service. Try again shortly.",
            f"grant read transport error: {exc}",
        ) from exc
    if response.status_code >= 400:
        raise AdminError(
            "The grant could not be checked. Try again shortly.",
            f"grant read -> {response.status_code} {response.text[:400]}",
            status=502,
        )
    try:
        rows = response.json()
    except ValueError:
        rows = []
    return bool(rows) if isinstance(rows, list) else False
