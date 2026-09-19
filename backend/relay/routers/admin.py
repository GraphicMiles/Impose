"""Operator routes: account inventory, reports, waitlist, grants,
revocations, notifications, status and manual wake.

Cut from the monolithic relay.server (modularisation pass). Route
bodies are verbatim; only the registration object changed from
``app`` to a local ``APIRouter`` that relay.server mounts.
"""
from fastapi import APIRouter

import json
import os
import time

from fastapi import HTTPException, Request
from fastapi.responses import Response

from relay import otp_store, reports_store, supabase_admin
from relay.mailer import MailFailed, send_grant
from relay.mailer import configured as mailer_configured
from relay.mailer import probe as mailer_probe
from relay.settings import (
    GATEWAY_URL, IDLE_MONITOR, IDLE_STOP_MINUTES, STARTED_AT,
    WAKE_ON_CHAT, WAKE_STUDIO,
)
from relay.shared import (
    _authed, _gateway_snapshot, _otp_email, _rate_hit,
    _start_gateway_llm, _start_gateway_llm_in_background, _status_note,
    _wake_in_background, _wake_missing, gateway_reachable, idle_minutes,
    wake_studio,
)
import relay.settings as _settings



router = APIRouter()

@router.get("/admin/accounts")
async def admin_accounts(request: Request):
    """Why is signup failing? Answers it without reading the host's logs.

    Every dependency of the account flow, checked for real rather than
    reported from config. Two outages so far looked identical from the
    outside, a 502 with a deliberately vague message, and both took a
    round trip through Render's log viewer to tell apart: one was a
    missing EXECUTE grant, the other a Sendlib rejection. This endpoint
    distinguishes them in one call.

    Behind CONTROL_KEY, because it names infrastructure. It reports whether
    each credential is present and whether each dependency answers, never
    the credentials themselves.
    """
    _authed(request)

    out = {
        "supabase_url": bool(os.environ.get("SUPABASE_URL", "").strip()),
        "supabase_service_key": bool(os.environ.get("SUPABASE_SERVICE_KEY", "").strip()),
        "otp_pepper": bool(os.environ.get("OTP_PEPPER", "").strip()),
        "sendlib_key": bool(os.environ.get("SENDLIB_API_KEY", "").strip()),
        "sendlib_from": bool(os.environ.get("SENDLIB_FROM", "").strip()),
    }

    # Can the relay actually call the code store? A grant can be missing
    # while every variable is set, which is exactly what happened.
    try:
        await otp_store.peek_probe()
        out["auth_codes_rpc"] = "ok"
    except Exception as exc:
        out["auth_codes_rpc"] = str(exc)[:200]

    # Can it reach the mail provider, and what does the provider say?
    if out["sendlib_key"] and out["sendlib_from"]:
        try:
            out["sendlib"] = await mailer_probe()
        except Exception as exc:
            out["sendlib"] = str(exc)[:200]
    else:
        out["sendlib"] = "not configured; codes go to this log"

    out["ready"] = all([out["supabase_url"], out["supabase_service_key"],
                        out["otp_pepper"], out["auth_codes_rpc"] == "ok"])
    return out


@router.get("/admin/reports")
async def admin_reports(request: Request, status: str = "pending", limit: int = 50):
    """The moderation queue, readable only with the CONTROL_KEY.

    Reports are how a reader flags abuse, but the reports table has no
    client policies, so nothing short of the service key can read it.
    The relay holds that key, so this endpoint is the operator's single
    URL for "what was flagged." Newest first; the reporter's handle is
    embedded so the operator sees who flagged what without a second
    lookup. Reading never mutates: acting on a report (reviewed/
    actioned/dismissed) is done in the database by the operator.
    """
    _authed(request)
    try:
        rows = await reports_store.fetch(status=status, limit=limit)
    except reports_store.ReportsError as exc:
        raise HTTPException(status_code=exc.status, detail=str(exc))
    return {"count": len(rows), "reports": rows}


@router.get("/admin/waitlist")
async def admin_waitlist(request: Request, status: str = "pending", limit: int = 100):
    """The waitlist queue, readable only with the CONTROL_KEY.

    The operator's view of who is waiting, oldest first, with position and
    whether the address already has an account (user_id). Pairs with
    /admin/grant: read the queue here, grant from there.
    """
    _authed(request)
    if status not in ("pending", "approved", "rejected"):
        raise HTTPException(status_code=400, detail="unknown status")
    if not supabase_admin.configured():
        raise HTTPException(status_code=503, detail="accounts are not configured on the server")
    try:
        rows = await supabase_admin.fetch_waitlist(status=status, limit=limit)
    except supabase_admin.AdminError as exc:
        print(f"[admin] waitlist read failed: {exc.detail}")
        raise HTTPException(status_code=exc.status, detail=exc.safe)
    return {"count": len(rows), "waitlist": rows}


@router.post("/admin/grant")
async def admin_grant(request: Request):
    """Grant day, in one call: CONTROL_KEY only.

    Looks the account up by email, records the workspace grant, marks the
    waitlist row approved, and sends the approval email the sheet promised
    ("We'll email you when your seat opens"). Idempotent: re-granting an
    already-granted address reports already_granted and sends nothing,
    unless notify=true forces a resend (the recovery path when the grant
    landed but the email did not).
    """
    _authed(request)
    try:
        data = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="body must be JSON")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")

    email = _otp_email(data)
    notify = bool(data.get("notify"))

    # An operator typo loop should not become a mail flood: three approval
    # emails per address per ten minutes is generous and still bounded.
    if _rate_hit("grantmail", email, 3, 600.0):
        raise HTTPException(status_code=429, detail="too many approval emails to this address; try again later")

    if not supabase_admin.configured():
        raise HTTPException(status_code=503, detail="accounts are not configured on the server")

    user = await supabase_admin.find_user_by_email(email)
    if not user:
        # No account, no grant: the grant row keys off auth.users, and an
        # email without an account cannot sign in to receive the payoff.
        raise HTTPException(status_code=404, detail="no account uses that email yet; they need to sign up before a grant can land")

    try:
        is_new = await supabase_admin.grant_workspace(user["id"])
        if is_new:
            await supabase_admin.approve_waitlist(email)
            # B-09: parity with the admin_grant RPC — the granted member
            # finds the notice in their in-app inbox, not only in email.
            try:
                await supabase_admin.notify_waitlist_approved(user["id"])
            except supabase_admin.AdminError as nexc:
                # The grant and the email are the guarantees; the inbox
                # notice is best-effort and logged, never a reason to
                # un-record a grant that already landed.
                print(f"[admin] inbox notice failed for {email}: {nexc.detail}", flush=True)
            # Brief §39/A11: the panel's admin_grant RPC audits; this path
            # now writes the same trail, attributed to the owner exactly
            # like the inbox notice.
            try:
                owners = await supabase_admin.list_admin_owners()
                await supabase_admin.audit_event(
                    owners[0] if owners else None,
                    "workspace.grant", "user", user["id"],
                    {"via": "relay", "email": email})
            except supabase_admin.AdminError as aexc:
                print(f"[admin] grant audit failed for {email}: {aexc.detail}", flush=True)
    except supabase_admin.AdminError as exc:
        print(f"[admin] grant failed for {email}: {exc.detail}")
        raise HTTPException(status_code=exc.status, detail=exc.safe)

    delivery = "email" if mailer_configured() else "console"
    if is_new or notify:
        try:
            await send_grant(email)
        except MailFailed as exc:
            # The grant is recorded; the email is not. Say exactly that so
            # the operator retries with notify=true instead of guessing.
            print(f"[admin] grant email failed for {email}: {exc}")
            raise HTTPException(
                status_code=502,
                detail="the grant is recorded but the approval email failed; retry with notify=true",
            )
        return {
            "ok": True,
            "user_id": user["id"],
            "granted": "new" if is_new else "already_granted",
            "email": "sent",
            "delivery": delivery,
        }
    return {
        "ok": True,
        "user_id": user["id"],
        "granted": "already_granted",
        "email": "skipped",
        "delivery": delivery,
    }


@router.post("/notify/grant")
async def notify_grant(request: Request):
    """Send the approval email for a grant that was already recorded.

    This is the browser-facing half of granting: the admin panel calls the
    database RPCs itself (an admin cannot grant anything the RPCs refuse),
    and then asks here for the email. It is authenticated by the caller's
    own Supabase session instead of CONTROL_KEY, because the panel runs in
    a browser that must never hold the relay's key. Three checks, all
    enforced here rather than hoped for:

      1. GoTrue says the token is valid and names its owner.
      2. can_do('notify_grant'), evaluated with the caller's own token,
         returns true: the waitlist.manage capability is required, exactly
         as the admin_grant RPC requires it.
      3. The workspace grant row already exists for the target account.

    Check three matters: this endpoint can mail, but it can never grant.
    An attacker with a valid session for any account still fails two and
    three; an admin still cannot spam an address, because the grant row
    has to exist first and the rate limit below is shared with /admin/grant.
    """
    auth = request.headers.get("authorization", "")
    if not auth.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing session")
    access_token = auth[7:].strip()
    if not access_token:
        raise HTTPException(status_code=401, detail="missing session")

    try:
        data = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="body must be JSON")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    email = _otp_email(data)

    if not supabase_admin.configured():
        raise HTTPException(status_code=503, detail="accounts are not configured on the server")

    caller = await supabase_admin.verify_session(access_token)
    if not caller:
        raise HTTPException(status_code=401, detail="session is not valid")

    # The capability question is answered by Postgres, against the same
    # admin_action_caps contract every RPC enforces; this endpoint cannot
    # out-vote the database and the refusal says nothing an outsider could
    # use to map the admin system.
    try:
        allowed = await supabase_admin.session_can(access_token, "notify_grant")
    except supabase_admin.AdminError as exc:
        print(f"[admin] can_do check failed: {exc.detail}")
        raise HTTPException(status_code=exc.status, detail=exc.safe)
    if not allowed:
        raise HTTPException(status_code=403, detail="not available to this account")

    target = await supabase_admin.find_user_by_email(email)
    if not target:
        raise HTTPException(status_code=404, detail="no account uses that email yet")
    try:
        granted = await supabase_admin.has_workspace_grant(target["id"])
    except supabase_admin.AdminError as exc:
        print(f"[admin] grant check failed for {email}: {exc.detail}")
        raise HTTPException(status_code=exc.status, detail=exc.safe)
    if not granted:
        raise HTTPException(status_code=409, detail="no grant recorded for that account; record the grant first")

    # Shared bucket with /admin/grant: one address gets at most three
    # approval emails per ten minutes across both paths.
    if _rate_hit("grantmail", email, 3, 600.0):
        raise HTTPException(status_code=429, detail="too many approval emails to this address; try again later")

    delivery = "email" if mailer_configured() else "console"
    try:
        await send_grant(email)
    except MailFailed as exc:
        print(f"[admin] grant email failed for {email}: {exc}")
        raise HTTPException(
            status_code=502,
            detail="the grant is recorded but the approval email failed; try again",
        )
    return {
        "ok": True,
        "user_id": target["id"],
        "email": "sent",
        "delivery": delivery,
        "notified_by": caller.get("id"),
    }


@router.post("/admin/revoke_grant")
async def admin_revoke_grant(request: Request):
    """Take back workspace access for one account (0025 lifecycle closure).

    CONTROL_KEY only — the panel-side half of the same operation lives in
    the admin_revoke_grant RPC (capability gate + audit_log). Same
    guarantee on both surfaces: the very next save_workspace call fails
    server-side; the member finds the notice in their inbox; the operator
    finds the audit row.
    """
    _authed(request)
    try:
        data = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="body must be JSON")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    email = _otp_email(data)

    if not supabase_admin.configured():
        raise HTTPException(status_code=503, detail="accounts are not configured on the server")

    user = await supabase_admin.find_user_by_email(email)
    if not user:
        raise HTTPException(status_code=404, detail="no account uses that email yet")

    if _rate_hit("grantrevoke", email, 6, 600.0):
        raise HTTPException(status_code=429, detail="too many flips for this address; try again later")

    try:
        had = await supabase_admin.revoke_workspace_grant(user["id"])
    except supabase_admin.AdminError as exc:
        print(f"[admin] grant revoke failed for {email}: {exc.detail}")
        raise HTTPException(status_code=exc.status, detail=exc.safe)

    if had:
        try:
            await supabase_admin.notify_access_revoked(user["id"])
        except supabase_admin.AdminError as nexc:
            # The revocation is the guarantee; the notice is best-effort,
            # exactly as /admin/grant treats its inbox row.
            print(f"[admin] revoke notice failed for {email}: {nexc.detail}", flush=True)
        try:
            owners = await supabase_admin.list_admin_owners()
            await supabase_admin.audit_event(
                owners[0] if owners else None,
                "workspace.revoke", "user", user["id"],
                {"via": "relay"})
        except supabase_admin.AdminError as aexc:
            print(f"[admin] revoke audit failed for {email}: {aexc.detail}", flush=True)

    return {"ok": True, "user_id": user["id"],
            "status": "revoked" if had else "no_grant"}


@router.post("/admin/revoke_sessions")
async def admin_revoke_sessions(request: Request):
    """Kill every session an account holds, everywhere (brief A11).

    CONTROL_KEY only. The lever for a compromised account: one call and
    every access/refresh token the account owns stops authenticating —
    including the one the attacker may be holding right now.
    """
    _authed(request)
    try:
        data = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="body must be JSON")
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="body must be a JSON object")
    email = _otp_email(data)

    if not supabase_admin.configured():
        raise HTTPException(status_code=503, detail="accounts are not configured on the server")

    user = await supabase_admin.find_user_by_email(email)
    if not user:
        raise HTTPException(status_code=404, detail="no account uses that email yet")

    # Bounded the same way as approval mail: revocations are rare and one
    # confused operator loop should not become logout-as-a-DoS.
    if _rate_hit("revokesess", email, 3, 600.0):
        raise HTTPException(status_code=429, detail="too many revocations for this address; try again later")

    try:
        await supabase_admin.revoke_user_sessions(user["id"])
    except supabase_admin.AdminError as exc:
        print(f"[admin] session revoke failed for {email}: {exc.detail}")
        raise HTTPException(status_code=exc.status, detail=exc.safe)

    try:
        owners = await supabase_admin.list_admin_owners()
        await supabase_admin.audit_event(
            owners[0] if owners else None,
            "account.revoke_sessions", "user", user["id"],
            {"via": "relay"})
    except supabase_admin.AdminError as aexc:
        print(f"[admin] revoke audit failed for {email}: {aexc.detail}", flush=True)

    return {"ok": True, "user_id": user["id"], "sessions": "revoked"}


@router.get("/admin/status")
def admin_status(request: Request):
    _authed(request)
    gateway_up = gateway_reachable(force=True)
    snap = _gateway_snapshot()
    missing = _wake_missing()
    return {"gateway_up": gateway_up,
            "llm_up": snap.get("llm_up") if gateway_up else False,
            "gateway_configured": bool(GATEWAY_URL),
            "gateway_http_status": snap.get("status"),
            "gateway_error": snap.get("error"),
            "idle_minutes": round(idle_minutes(), 1),
            "idle_stop_minutes": IDLE_STOP_MINUTES,
            "idle_monitor": IDLE_MONITOR and WAKE_STUDIO,
            "wake_on_chat": WAKE_ON_CHAT,
            "wake_studio": WAKE_STUDIO,
            "wake_configured": WAKE_STUDIO and not missing,
            "waking": _settings._waking,
            "note": _status_note(gateway_up, snap, missing),
            "uptime_seconds": round(time.time() - STARTED_AT, 1)}


@router.post("/admin/wake-llm")
def admin_wake(request: Request, background: bool = False):
    """Wake the LLM chain on demand. Safe to call anytime. With
    `?background=1` it returns immediately and the wake continues server-side."""
    _authed(request)
    if gateway_reachable():
        snap = _gateway_snapshot()
        if snap.get("llm_up") is False:
            if background:
                _start_gateway_llm_in_background()
                return Response(
                    content=json.dumps({"llm_up": False, "woke": True,
                                        "state": "starting-model"}),
                    media_type="application/json", status_code=202)
            ok = _start_gateway_llm()
            if not ok:
                raise HTTPException(status_code=503,
                                    detail="The gateway is online but its model failed to start.")
            return {"llm_up": True, "woke": True}
        return {"llm_up": True, "woke": False,
                "note": "gateway and model are already online"}
    if not WAKE_STUDIO:
        raise HTTPException(
            status_code=409,
            detail="Automatic wake is disabled. Set WAKE_STUDIO=1 and add the Lightning credentials.")
    missing = _wake_missing()
    if missing:
        raise HTTPException(status_code=409,
                            detail="Missing wake configuration: " + ", ".join(missing))
    if background:
        _wake_in_background()
        return Response(
            content=json.dumps({"llm_up": False, "woke": True, "state": "waking"}),
            media_type="application/json", status_code=202)
    ok = wake_studio()
    if not ok:
        raise HTTPException(status_code=503, detail="The Studio wake attempt failed. Check the relay logs.")
    return {"llm_up": True, "woke": True}


