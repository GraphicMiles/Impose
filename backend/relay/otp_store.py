"""Durable one-time codes, held in Supabase.

Every decision here is made by the database in a single statement, not by
this module across several round trips. That is not a style preference: the
previous version read the attempt count, added one, and wrote it back, so
guesses issued in parallel all read the same value and the five-attempt cap
never fired. Measured against real Postgres, ten concurrent wrong guesses
recorded as one attempt and the code stayed live. An attacker with a
hundred parallel connections would have walked through it.

So issue and verify are both RPCs (see 0003_auth_hardening.sql):

  issue_auth_code    upsert plus cooldown, under a row lock, so two resends
                     cannot both decide they are the first.
  consume_auth_code  lock, compare, and either delete or increment in the
                     same transaction. One call per attempt, one outcome,
                     and every branch costs the same round trip so response
                     timing does not say which branch was taken.

The code itself is hashed with a pepper before it is ever sent to the
database, so the table is useless on its own.
"""
from __future__ import annotations

import hashlib
import os

import httpx

CODE_LENGTH = 8
CODE_TTL_SECONDS = 10 * 60
MAX_ATTEMPTS = 5
RESEND_COOLDOWN_SECONDS = 60
PURPOSES = ("signup", "reset")

TIMEOUT = 15.0


class OtpError(Exception):
    def __init__(self, message: str, *, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def _pepper() -> str:
    pepper = os.environ.get("OTP_PEPPER", "")
    if not pepper:
        # Refusing is the right failure. Without a pepper the stored hash is
        # sha256 of eight digits, which is a rainbow table, and running
        # anyway would hide that behind a flow that looks like it works.
        raise OtpError("Accounts are not configured on the server.", status=503)
    return pepper


def hash_code(code: str) -> str:
    return hashlib.sha256((code + _pepper()).encode("utf-8")).hexdigest()


def normalize_purpose(value: str) -> str:
    purpose = str(value or "signup").strip().lower()
    if purpose not in PURPOSES:
        raise OtpError("Unknown verification purpose.")
    return purpose


def _base() -> str:
    base = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    if not base:
        raise OtpError("Accounts are not configured on the server.", status=503)
    return base


def _headers() -> dict:
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not key:
        raise OtpError("Accounts are not configured on the server.", status=503)
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


async def _rpc(name: str, payload: dict):
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                f"{_base()}/rest/v1/rpc/{name}", headers=_headers(), json=payload
            )
    except httpx.HTTPError as exc:
        raise OtpError("Could not reach the server. Try again shortly.", status=502) from exc
    if response.status_code >= 400:
        # Body to the log, never to the caller.
        print(f"[otp] rpc {name} -> {response.status_code} {response.text[:300]}")
        raise OtpError("Could not reach the server. Try again shortly.", status=502)
    try:
        return response.json()
    except ValueError:
        return []


async def issue(email: str, purpose: str, code: str, user_id: str | None = None) -> dict:
    """Store a code, or report that a live one is still in its cooldown.

    reused=True means an email must NOT be sent: the code already in the
    inbox is still valid, and minting a rival would invalidate it.
    """
    purpose = normalize_purpose(purpose)
    rows = await _rpc("issue_auth_code", {
        "p_email": email.strip().lower(),
        "p_purpose": purpose,
        "p_hash": hash_code(code),
        "p_user_id": user_id,
        "p_ttl": CODE_TTL_SECONDS,
        "p_cooldown": RESEND_COOLDOWN_SECONDS,
    })
    row = rows[0] if isinstance(rows, list) and rows else (rows or {})
    return {
        "reused": bool(row.get("reused")),
        "resend_in": int(row.get("resend_in") or RESEND_COOLDOWN_SECONDS),
    }


async def verify(email: str, purpose: str, code: str) -> dict:
    """Consume the code. Returns {'user_id': ...} or raises.

    One RPC. The lock, the comparison, the delete and the attempt
    increment all happen inside it, so there is no window in which two
    requests can disagree about the state of the row.
    """
    purpose = normalize_purpose(purpose)
    supplied = "".join(ch for ch in str(code or "") if ch.isdigit())

    rows = await _rpc("consume_auth_code", {
        "p_email": email.strip().lower(),
        "p_purpose": purpose,
        "p_hash": hash_code(supplied),
        "p_max": MAX_ATTEMPTS,
    })
    row = rows[0] if isinstance(rows, list) and rows else (rows or {})
    outcome = row.get("outcome")

    if outcome == "ok":
        return {"user_id": row.get("user_id")}
    if outcome == "locked":
        raise OtpError("Too many incorrect attempts. Request a new code.", status=429)
    if outcome == "wrong":
        left = int(row.get("attempts_left") or 0)
        raise OtpError(
            f"That code is not right. {left} attempt{'s' if left != 1 else ''} left."
        )
    # 'expired' also covers "no pending code", deliberately: telling those
    # apart would say whether a signup was in flight for that address.
    raise OtpError("That code has expired. Request a new one.", status=410)


async def issue_ticket(email: str, token: str, user_id: str | None, ttl: int = 600) -> None:
    """Record a reset ticket. Stored hashed, for the same reason codes are."""
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.post(
                f"{_base()}/rest/v1/auth_tickets",
                headers={**_headers(), "Prefer": "resolution=merge-duplicates,return=minimal"},
                json={
                    "token_hash": hash_code(token),
                    "email": email.strip().lower(),
                    "user_id": user_id,
                    "expires_at": _iso_in(ttl),
                },
            )
    except httpx.HTTPError as exc:
        raise OtpError("Could not reach the server. Try again shortly.", status=502) from exc
    if response.status_code >= 400:
        print(f"[otp] ticket insert -> {response.status_code} {response.text[:200]}")
        raise OtpError("Could not reach the server. Try again shortly.", status=502)


async def redeem_ticket(token: str) -> dict | None:
    """Spend a reset ticket. The delete is the single-use guarantee."""
    rows = await _rpc("redeem_auth_ticket", {"p_hash": hash_code(token)})
    if isinstance(rows, list) and rows:
        return rows[0]
    return None


def _iso_in(seconds: int) -> str:
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()
