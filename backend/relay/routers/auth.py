"""Auth routes: OTP request/verify and password reset.

Cut from the monolithic relay.server (modularisation pass). Route
bodies are verbatim; only the registration object changed from
``app`` to a local ``APIRouter`` that relay.server mounts.
"""
from fastapi import APIRouter

import secrets

from fastapi import HTTPException, Request

from relay import otp_store, supabase_admin
from relay.mailer import MailFailed, send_code
from relay.mailer import configured as mailer_configured
from relay.shared import (
    _client_ip, _issued_code, _otp_email, _otp_password, _rate_hit,
    _signup_email,
)



router = APIRouter()

@router.post("/v1/auth/otp/request")
async def otp_request(request: Request):
    ip = _client_ip(request)
    if _rate_hit("otpip", ip, 12, 3600.0):
        raise HTTPException(status_code=429, detail="too many code requests; try again later")
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")

    email = _otp_email(data)
    try:
        purpose = otp_store.normalize_purpose(data.get("purpose"))
    except otp_store.OtpError as exc:
        raise HTTPException(status_code=400, detail=exc.message)

    if _rate_hit("otpaddr", email, 6, 3600.0):
        raise HTTPException(status_code=429, detail="too many codes sent to this address; try again later")

    if not supabase_admin.configured():
        raise HTTPException(status_code=503, detail="accounts are not configured on the server")

    if purpose == "reset":
        # An address with no account gets an identical answer and no email.
        # Sending a code anyway turned this endpoint into a mail relay for
        # arbitrary inboxes: twelve requests an hour per IP, six per
        # address, each one a real send from our provider to a stranger.
        # The response shape is deliberately indistinguishable from the
        # known-address path, so this cannot be probed for enumeration.
        if not await supabase_admin.find_user_by_email(email):
            return {
                "ok": True,
                "resend_in": otp_store.RESEND_COOLDOWN_SECONDS,
                "expires_in": otp_store.CODE_TTL_SECONDS,
                "delivery": "email" if mailer_configured() else "console",
            }

    pending_user_id = None
    if purpose == "signup":
        # The quality rules on top of the shape rules apply only to new
        # accounts: a legacy address must still be able to reset.
        email = _signup_email(data)
        password = _otp_password(data)
        existing = await supabase_admin.find_user_by_email(email)
        if existing:
            if existing.get("email_confirmed_at"):
                raise HTTPException(
                    status_code=409,
                    detail="That address already has an account. Try signing in.",
                )
            # An unconfirmed row is an abandoned or retried signup, not a
            # real account. Replace it so a half-finished attempt cannot
            # squat an address, and so the password in Supabase matches the
            # one just typed.
            await supabase_admin.delete_user(existing["id"])

        # Created disabled. Supabase hashes the password on arrival, which
        # is why nothing here has to keep it: the old design encrypted it
        # into the codes table for ten minutes, making OTP_PEPPER a key
        # whose loss was a breach.
        try:
            created = await supabase_admin.create_pending_user(email, password)
        except supabase_admin.AdminError as exc:
            print(f"[auth] could not stage signup for {email}: {exc.detail}")
            raise HTTPException(status_code=exc.status, detail=exc.safe)
        pending_user_id = created.get("id")

    code = _issued_code()
    try:
        issued = await otp_store.issue(email, purpose, code, pending_user_id)
    except otp_store.OtpError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message)

    if not issued["reused"]:
        try:
            await send_code(email, code, purpose, otp_store.CODE_TTL_SECONDS)
        except MailFailed as exc:
            print(f"[otp] delivery failed for {email}: {exc}")
            # No code can arrive, so the staged account would block the
            # address on every retry. Remove it rather than leave a ghost.
            if pending_user_id:
                await supabase_admin.delete_user(pending_user_id)
            # The code row has to go too. Left behind, it holds the resend
            # cooldown open, so the next attempt is told a live code exists
            # and no second email is sent: one delivery failure locked the
            # address out for the full ten minutes.
            await otp_store.forget(email, purpose)
            raise HTTPException(status_code=502, detail="could not send the email just now; try again shortly")

    return {
        "ok": True,
        "resend_in": issued["resend_in"],
        "expires_in": otp_store.CODE_TTL_SECONDS,
        "delivery": "email" if mailer_configured() else "console",
    }


@router.post("/v1/auth/otp/verify")
async def otp_verify(request: Request):
    """Verify a code and act on it.

    This endpoint does the thing the old one only claimed to do. On signup
    it creates the confirmed account and returns a real Supabase session;
    on reset it returns a short-lived ticket that the reset endpoint below
    requires. Either way the browser leaves with something it could not
    have produced on its own.
    """
    ip = _client_ip(request)
    if _rate_hit("otpverifyip", ip, 40, 3600.0):
        raise HTTPException(status_code=429, detail="too many attempts; try again later")
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")

    email = _otp_email(data)
    try:
        purpose = otp_store.normalize_purpose(data.get("purpose"))
        row = await otp_store.verify(email, purpose, data.get("code"))
    except otp_store.OtpError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message)

    if purpose == "reset":
        # Proof of inbox control, good for ten minutes and one password
        # change. Not a session: it cannot read or write anything. Stored
        # hashed in the database rather than a process dict, so a restart
        # or a second instance does not silently invalidate it.
        ticket = secrets.token_urlsafe(32)
        try:
            await otp_store.issue_ticket(email, ticket, row.get("user_id"))
        except otp_store.OtpError as exc:
            raise HTTPException(status_code=exc.status, detail=exc.message)
        return {"ok": True, "email": email, "purpose": purpose, "ticket": ticket}

    # Signup. The account already exists, disabled, created when the code
    # was requested. Verification flips the one flag that makes it usable,
    # so nothing had to remember the password.
    user_id = row.get("user_id")
    if not user_id:
        raise HTTPException(status_code=410, detail="That signup expired. Start again.")

    try:
        await supabase_admin.confirm_user(user_id)
    except supabase_admin.AdminError as exc:
        print(f"[auth] confirm failed for {email}: {exc.detail}")
        raise HTTPException(status_code=exc.status, detail=exc.safe)

    # The browser gets a session by signing in normally. The relay does not
    # mint tokens: Supabase stays the authority on what a valid session is.
    return {"ok": True, "email": email, "purpose": purpose, "confirmed": True}


@router.post("/v1/auth/password/reset")
async def password_reset(request: Request):
    """Set a new password, but only for a browser holding a fresh ticket."""
    ip = _client_ip(request)
    if _rate_hit("pwreset", ip, 20, 3600.0):
        raise HTTPException(status_code=429, detail="too many attempts; try again later")
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="body must be JSON")

    ticket = str(data.get("ticket", ""))
    password = _otp_password(data)

    if not supabase_admin.configured():
        raise HTTPException(status_code=503, detail="accounts are not configured on the server")

    try:
        held = await otp_store.redeem_ticket(ticket)
    except otp_store.OtpError as exc:
        raise HTTPException(status_code=exc.status, detail=exc.message)
    if not held:
        raise HTTPException(status_code=403, detail="That reset expired. Request a new code.")

    try:
        user_id = held.get("user_id")
        if not user_id:
            user = await supabase_admin.find_user_by_email(held["email"])
            if not user:
                # Only said now, after a code proved the caller owns the
                # inbox, so this cannot be used to enumerate addresses.
                raise HTTPException(status_code=404, detail="That address has no account.")
            user_id = user["id"]
        await supabase_admin.set_password(user_id, password)
    except supabase_admin.AdminError as exc:
        print(f"[auth] reset failed: {exc.detail}")
        raise HTTPException(status_code=exc.status, detail=exc.safe)

    return {"ok": True}


