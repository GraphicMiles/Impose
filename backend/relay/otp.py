"""Email one-time codes, issued and verified server side.

The browser never sees the Sendlib key and never learns whether an address is
registered. It asks for a code, then presents one; everything that decides
whether that code is good happens here.

Design notes that matter:

  HASHED AT REST  The code is stored as sha256(code + pepper), never plain.
    A dump of this table does not let the reader sign in as anybody.

  SINGLE USE      A verified code is consumed in the same lock that checks
    it, so two racing requests cannot both spend it.

  ATTEMPT CAP     Five wrong guesses burns the code. Eight digits is 100M
    combinations, but a cap turns "infeasible" into "not worth trying".

  NO ENUMERATION  Issuing a code for an unknown address looks exactly like
    issuing one for a known address: same latency band, same response. The
    caller decides whether an account exists; this module does not leak it.

  IDEMPOTENT SEND A second request inside the resend cooldown returns the
    existing code's expiry rather than minting a new one and sending a
    second email. Double-tapping Resend must not produce two emails.

Storage is a process-local dict. That is correct for a single relay
instance, which is what the product runs today. The moment there are two
instances behind a load balancer, codes issued by one will not verify on the
other, and this needs to move to the database. Flagged rather than
pre-solved: adding Redis now would be architecture theatre for one box.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import threading
import time

CODE_LENGTH = 8
CODE_TTL_SECONDS = 10 * 60
MAX_ATTEMPTS = 5
RESEND_COOLDOWN_SECONDS = 60
PURPOSES = ("signup", "reset")

_PEPPER = os.environ.get("OTP_PEPPER", "")
_store: dict[str, dict] = {}
_lock = threading.Lock()


class OtpError(Exception):
    """Raised with a message that is safe to show the user."""

    def __init__(self, message: str, *, status: int = 400, retry_after: int = 0):
        super().__init__(message)
        self.message = message
        self.status = status
        self.retry_after = retry_after


def _now() -> float:
    return time.time()


def _key(email: str, purpose: str) -> str:
    return f"{purpose}:{email.strip().lower()}"


def _hash(code: str) -> str:
    return hashlib.sha256((code + _PEPPER).encode("utf-8")).hexdigest()


def _prune(now: float) -> None:
    """Drop expired records so the dict cannot grow without bound."""
    dead = [k for k, rec in _store.items() if rec["expires_at"] <= now - 3600]
    for k in dead:
        _store.pop(k, None)


def normalize_purpose(value: str) -> str:
    purpose = str(value or "signup").strip().lower()
    if purpose not in PURPOSES:
        raise OtpError("Unknown verification purpose.")
    return purpose


def issue(email: str, purpose: str) -> dict:
    """Mint a code, or return the live one if we are inside the cooldown.

    Returns {code, expires_at, resend_in, reused}. `code` is the plaintext
    to email; it is never stored and never returned to the browser.
    """
    purpose = normalize_purpose(purpose)
    key = _key(email, purpose)
    now = _now()

    with _lock:
        _prune(now)
        record = _store.get(key)

        # Inside the cooldown a second request is a double tap, not a new
        # intent. Return the existing code's shape so the caller can skip
        # sending, rather than minting a rival code that invalidates the one
        # already in the user's inbox.
        if record and record["expires_at"] > now:
            since = now - record["issued_at"]
            if since < RESEND_COOLDOWN_SECONDS:
                return {
                    "code": None,
                    "expires_at": record["expires_at"],
                    "resend_in": int(RESEND_COOLDOWN_SECONDS - since) + 1,
                    "reused": True,
                }

        code = "".join(secrets.choice("0123456789") for _ in range(CODE_LENGTH))
        record = {
            "hash": _hash(code),
            "issued_at": now,
            "expires_at": now + CODE_TTL_SECONDS,
            "attempts": 0,
            "consumed_at": 0.0,
        }
        _store[key] = record
        return {
            "code": code,
            "expires_at": record["expires_at"],
            "resend_in": RESEND_COOLDOWN_SECONDS,
            "reused": False,
        }


def verify(email: str, purpose: str, code: str) -> None:
    """Consume the code, or raise OtpError with a user-safe message.

    Deliberately does not distinguish "no code was ever issued" from "the
    code expired": both mean the user needs a new one, and telling them
    apart would confirm whether the address had been used.
    """
    purpose = normalize_purpose(purpose)
    key = _key(email, purpose)
    supplied = "".join(ch for ch in str(code or "") if ch.isdigit())
    now = _now()

    with _lock:
        record = _store.get(key)
        if not record or record["expires_at"] <= now or record["consumed_at"]:
            raise OtpError("That code has expired. Request a new one.", status=410)

        if record["attempts"] >= MAX_ATTEMPTS:
            _store.pop(key, None)
            raise OtpError(
                "Too many incorrect attempts. Request a new code.", status=429
            )

        # compare_digest so a wrong code does not leak its correct prefix
        # through response timing.
        if not hmac.compare_digest(record["hash"], _hash(supplied)):
            record["attempts"] += 1
            left = MAX_ATTEMPTS - record["attempts"]
            if left <= 0:
                _store.pop(key, None)
                raise OtpError(
                    "Too many incorrect attempts. Request a new code.", status=429
                )
            raise OtpError(
                f"That code is not right. {left} attempt{'s' if left != 1 else ''} left."
            )

        # Consume inside the same lock that validated it: two racing
        # requests must not both succeed on one code.
        record["consumed_at"] = now
        _store.pop(key, None)


def peek_ttl(email: str, purpose: str) -> int:
    """Seconds until the live code expires, 0 if there is none."""
    with _lock:
        record = _store.get(_key(email, normalize_purpose(purpose)))
        if not record:
            return 0
        return max(0, int(record["expires_at"] - _now()))


def reset_for_tests() -> None:
    with _lock:
        _store.clear()
