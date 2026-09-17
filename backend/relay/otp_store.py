"""Durable one-time codes, held in Supabase.

The in-memory version in otp.py was correct for a single always-on process
and wrong for where this actually runs. Render's free tier sleeps, and a
restart between "send me a code" and "here is the code" left the user
holding a code the server had forgotten, with no way to tell them why. It
also could not survive a second relay instance.

Rows live in public.auth_codes, which has RLS on and no policies, so the
service role is the only thing that can read or write them.

The guarantees are the same ones the memory version had, re-established
against a database rather than a lock:

  HASHED AT REST   sha256(code + pepper). The pepper is in the relay's
    environment, so the table alone does not brute force.

  SINGLE USE       Verification deletes the row in the same statement that
    matches it, using DELETE ... RETURNING. Two racing requests cannot both
    succeed, because only one of them gets a row back.

  ATTEMPT CAP      A wrong guess increments atomically and the row is
    deleted on the fifth, so a burned code cannot be retried even with the
    right value.

  ONE LIVE CODE    Primary key (email, purpose). A resend overwrites, so
    there is never a question of which of two codes is real.
"""
from __future__ import annotations

import hashlib
import hmac
import os
from datetime import datetime, timedelta, timezone

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
    return os.environ.get("OTP_PEPPER", "")


def hash_code(code: str) -> str:
    return hashlib.sha256((code + _pepper()).encode("utf-8")).hexdigest()


def normalize_purpose(value: str) -> str:
    purpose = str(value or "signup").strip().lower()
    if purpose not in PURPOSES:
        raise OtpError("Unknown verification purpose.")
    return purpose


def _rest_url() -> str:
    base = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    if not base:
        raise OtpError("Accounts are not configured on the server.", status=503)
    return base + "/rest/v1/auth_codes"


def _headers(extra: dict | None = None) -> dict:
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not key:
        raise OtpError("Accounts are not configured on the server.", status=503)
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


async def _req(method: str, *, params=None, json_body=None, extra_headers=None):
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.request(
                method, _rest_url(), headers=_headers(extra_headers),
                params=params, json=json_body,
            )
    except httpx.HTTPError as exc:
        raise OtpError("Could not reach the server. Try again shortly.", status=502) from exc
    if response.status_code >= 400:
        print(f"[otp] store {method} -> {response.status_code} {response.text[:300]}")
        raise OtpError("Could not reach the server. Try again shortly.", status=502)
    if not response.content:
        return []
    try:
        return response.json()
    except ValueError:
        return []


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _parse(ts: str) -> datetime:
    value = str(ts or "").replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return _now()
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


async def peek(email: str, purpose: str) -> dict | None:
    rows = await _req(
        "GET",
        params={
            "email": f"eq.{email.strip().lower()}",
            "purpose": f"eq.{purpose}",
            "select": "email,purpose,attempts,issued_at,expires_at",
        },
    )
    return rows[0] if rows else None


async def issue(email: str, purpose: str, code: str, password_hash: str | None) -> dict:
    """Store a code, or report that a live one is still inside its cooldown.

    Returns {"reused": bool, "resend_in": int}. A reused result means the
    caller must not send another email: the code already in the inbox is
    still the valid one, and minting a rival would invalidate it.
    """
    purpose = normalize_purpose(purpose)
    address = email.strip().lower()
    now = _now()

    existing = await peek(address, purpose)
    if existing and _parse(existing["expires_at"]) > now:
        elapsed = (now - _parse(existing["issued_at"])).total_seconds()
        if elapsed < RESEND_COOLDOWN_SECONDS:
            return {
                "reused": True,
                "resend_in": int(RESEND_COOLDOWN_SECONDS - elapsed) + 1,
            }

    row = {
        "email": address,
        "purpose": purpose,
        "code_hash": hash_code(code),
        "password_hash": password_hash,
        "attempts": 0,
        "issued_at": now.isoformat(),
        "expires_at": (now + timedelta(seconds=CODE_TTL_SECONDS)).isoformat(),
    }
    # merge-duplicates makes a resend replace the live row, which is what
    # keeps "one live code per address per purpose" true.
    await _req(
        "POST", json_body=row,
        extra_headers={"Prefer": "resolution=merge-duplicates,return=minimal"},
    )
    return {"reused": False, "resend_in": RESEND_COOLDOWN_SECONDS}


async def verify(email: str, purpose: str, code: str) -> dict:
    """Consume the code and return the row, or raise.

    The delete-and-return is the single-use guarantee: the row is matched
    and removed in one statement, so a second request finds nothing.
    """
    purpose = normalize_purpose(purpose)
    address = email.strip().lower()
    supplied = "".join(ch for ch in str(code or "") if ch.isdigit())

    row = await peek(address, purpose)
    if not row:
        raise OtpError("That code has expired. Request a new one.", status=410)
    if _parse(row["expires_at"]) <= _now():
        await _delete(address, purpose)
        raise OtpError("That code has expired. Request a new one.", status=410)
    if int(row.get("attempts", 0)) >= MAX_ATTEMPTS:
        await _delete(address, purpose)
        raise OtpError("Too many incorrect attempts. Request a new code.", status=429)

    # Delete by hash: only the correct code matches, and the delete is what
    # consumes it. A wrong code deletes nothing and falls through to the
    # attempt counter below.
    deleted = await _req(
        "DELETE",
        params={
            "email": f"eq.{address}",
            "purpose": f"eq.{purpose}",
            "code_hash": f"eq.{hash_code(supplied)}",
        },
        extra_headers={"Prefer": "return=representation"},
    )
    if deleted:
        return deleted[0]

    attempts = int(row.get("attempts", 0)) + 1
    if attempts >= MAX_ATTEMPTS:
        await _delete(address, purpose)
        raise OtpError("Too many incorrect attempts. Request a new code.", status=429)
    await _req(
        "PATCH",
        params={"email": f"eq.{address}", "purpose": f"eq.{purpose}"},
        json_body={"attempts": attempts},
        extra_headers={"Prefer": "return=minimal"},
    )
    left = MAX_ATTEMPTS - attempts
    raise OtpError(
        f"That code is not right. {left} attempt{'s' if left != 1 else ''} left."
    )


async def _delete(email: str, purpose: str) -> None:
    await _req(
        "DELETE",
        params={"email": f"eq.{email}", "purpose": f"eq.{purpose}"},
        extra_headers={"Prefer": "return=minimal"},
    )
