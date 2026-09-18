"""Transactional email via Sendlib.

Sendlib relays through a connected Gmail account, so there is no domain to
verify. The key lives here and only here: the browser must never hold a
credential that can send mail as the product.

Env:
  SENDLIB_API_KEY   required to actually send. Absent, the relay runs in
                    console mode: the code is logged instead of emailed, so
                    local development works without an account.
  SENDLIB_URL       default https://sendlib.samueltuoyo.com/api/send
  SENDLIB_FROM      the connected Gmail address to send from
  SENDLIB_REPLY_TO  optional support address
  APP_NAME          default Impose
"""
from __future__ import annotations

import os

import httpx

SENDLIB_URL = os.environ.get(
    "SENDLIB_URL", "https://sendlib.samueltuoyo.com/api/send"
)
APP_NAME = os.environ.get("APP_NAME", "Impose")
SEND_TIMEOUT = 12.0


class MailFailed(Exception):
    """Delivery failed. Distinct from a bad code: the user did nothing wrong."""


def configured() -> bool:
    return bool(os.environ.get("SENDLIB_API_KEY") and os.environ.get("SENDLIB_FROM"))


def _origin() -> str:
    """The origin Sendlib sees on our requests.

    Sendlib scopes an API key to an allowlist of origins and reads the
    Origin header to decide. A server-to-server call sends none, so it
    logged ours as 'unknown' and refused with 403. Nothing was wrong with
    the key; the request simply had no identity to match.

    Sending one explicitly gives the dashboard something to allow.
    SENDLIB_ORIGIN overrides it for a different deployment.
    """
    return os.environ.get("SENDLIB_ORIGIN", "").strip() or "https://impose-relay.onrender.com"


def _auth_headers() -> dict:
    return {
        "Authorization": f"Bearer {os.environ.get('SENDLIB_API_KEY', '')}",
        "Content-Type": "application/json",
        "Origin": _origin(),
    }


def _subject(purpose: str) -> str:
    if purpose == "reset":
        return f"Reset your {APP_NAME} password"
    return f"Verify your {APP_NAME} email"


def _lead(purpose: str) -> str:
    if purpose == "reset":
        return "Use this code to set a new password."
    return "Use this code to finish setting up your account."


def _text_body(code: str, purpose: str, minutes: int) -> str:
    return (
        f"{_lead(purpose)}\n\n"
        f"{code}\n\n"
        f"The code expires in {minutes} minutes and can be used once.\n"
        f"If you did not ask for this, ignore this email and nothing will change.\n"
    )


def _html_body(code: str, purpose: str, minutes: int) -> str:
    """Deliberately plain.

    Sendlib's own guidance is that light, human-looking mail lands; heavy
    marketing HTML does not. Spaced digits so the code is readable and easy
    to copy, and no images or tracking.
    """
    spaced = " ".join(code)
    return (
        '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;'
        'font-size:15px;line-height:1.6;color:#1a1a1a">'
        f"<p>{_lead(purpose)}</p>"
        '<p style="font-size:28px;font-weight:600;letter-spacing:6px;'
        'margin:24px 0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">'
        f"{spaced}</p>"
        f"<p>The code expires in {minutes} minutes and can be used once.</p>"
        '<p style="color:#666;font-size:13px">If you did not ask for this, '
        "ignore this email and nothing will change.</p>"
        "</div>"
    )


async def send_message(email: str, subject: str, text: str, html: str) -> None:
    """Hand one message to the transport. Raises MailFailed on refusal.

    The console-mode fallback keeps every flow developable without a
    Sendlib account: the message is logged instead of sent.
    """
    api_key = os.environ.get("SENDLIB_API_KEY", "")
    sender = os.environ.get("SENDLIB_FROM", "")

    if not api_key or not sender:
        print(f"[mail] to {email}: {subject}")
        return

    payload = {
        "from": sender,
        "to": email,
        "subject": subject,
        "text": text,
        "html": html,
    }
    reply_to = os.environ.get("SENDLIB_REPLY_TO", "")
    if reply_to:
        payload["replyTo"] = reply_to

    try:
        async with httpx.AsyncClient(timeout=SEND_TIMEOUT) as client:
            response = await client.post(
                SENDLIB_URL,
                json=payload,
                headers=_auth_headers(),
            )
    except httpx.HTTPError as exc:
        raise MailFailed(f"mail transport failed: {exc}") from exc

    if response.status_code >= 400:
        # Body is logged server side only. It can carry provider detail that
        # is useless and occasionally sensitive to the end user.
        raise MailFailed(
            f"sendlib rejected the message: {response.status_code} {response.text[:300]}"
        )


async def send_code(email: str, code: str, purpose: str, ttl_seconds: int) -> None:
    """Email one code. Raises MailFailed if it could not be handed off.

    Console mode prints the code itself: without a Sendlib account this
    is how a developer receives the OTP, so the print is the feature.
    """
    minutes = max(1, ttl_seconds // 60)
    if not (os.environ.get("SENDLIB_API_KEY") and os.environ.get("SENDLIB_FROM")):
        print(f"[otp] {purpose} code for {email}: {code} (expires in {minutes}m)")
        return
    await send_message(
        email,
        _subject(purpose),
        _text_body(code, purpose, minutes),
        _html_body(code, purpose, minutes),
    )


# ---------- the waitlist payoff ----------
# The sheet promises "We'll email you when your seat opens," so the grant
# email is a kept promise, not a nicety. Deliberately plain, like the code
# mail: one good sentence, one link, no images, no tracking.

def _app_url() -> str:
    """The sign-in link in the grant email. APP_URL overrides for custom
    domains; the default is the deployed web origin."""
    return os.environ.get("APP_URL", "https://impose-web.onrender.com").rstrip("/")


def _grant_subject() -> str:
    return f"You're in — your {APP_NAME} workspace is ready"


def _grant_text() -> str:
    return (
        "Your waitlist seat just opened.\n\n"
        f"Sign in to open your workspace: {_app_url()}/sign-in\n\n"
        "Your workspace is yours: chats, saved history and your own provider "
        "keys, synced to your account.\n\n"
        "If you did not join the waitlist, someone used this address — "
        "sign in and check your account, or ignore this email.\n"
    )


def _grant_html() -> str:
    url = _app_url() + "/sign-in"
    return (
        '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;'
        'font-size:15px;line-height:1.6;color:#1a1a1a">'
        "<p>Your waitlist seat just opened.</p>"
        f'<p style="margin:24px 0"><a href="{url}" '
        'style="display:inline-block;padding:10px 18px;border-radius:10px;'
        'background:#1a1a1a;color:#fff;text-decoration:none;font-weight:600">'
        f"Open your {APP_NAME} workspace</a></p>"
        '<p style="color:#666;font-size:13px">Or sign in at '
        f'<a href="{url}">{url}</a>. Your workspace is yours: chats, saved '
        "history and your own provider keys, synced to your account.</p>"
        '<p style="color:#666;font-size:13px">If you did not join the '
        "waitlist, someone used this address — sign in and check your "
        "account, or ignore this email.</p>"
        "</div>"
    )


async def send_grant(email: str) -> None:
    """The approval email. Raises MailFailed if it could not be handed off."""
    await send_message(email, _grant_subject(), _grant_text(), _grant_html())


async def probe() -> str:
    """Ask Sendlib whether it would accept a send, and report what it says.

    A rejection here is the difference between "the key is wrong", "the
    sender is not connected" and "the provider is down", and those need
    different fixes. The message is truncated and the key never appears.
    """
    sender = os.environ.get("SENDLIB_FROM", "")
    try:
        async with httpx.AsyncClient(timeout=SEND_TIMEOUT) as client:
            r = await client.post(
                SENDLIB_URL,
                json={"from": sender, "to": sender,
                      "subject": "Impose relay connectivity probe",
                      "text": "Ignore: verifying the relay can send."},
                headers=_auth_headers(),
            )
    except httpx.HTTPError as exc:
        return f"unreachable: {exc}"[:200]
    if r.status_code >= 400:
        body = r.text[:200]
        return (f"rejected {r.status_code} (sent as origin {_origin()}): {body}"
                + _sendlib_hint(body))
    return "ok"


def _sendlib_hint(body: str) -> str:
    """Turn a provider rejection into the action that resolves it.

    Four different causes have now produced a 4xx here and each needed a
    different fix in a different dashboard. The message alone was not
    enough to tell them apart at a glance, and every round trip cost a
    deploy. The provider's own words are still reported above; this only
    adds where to go.
    """
    low = body.lower()
    if "insufficient authentication scopes" in low:
        return ("  -> Google refused the token, not Sendlib. The Gmail account is"
                " connected but was authorised before send permission was granted."
                " Disconnect it in the Sendlib dashboard and reconnect, pressing"
                " Allow on the Gmail send consent screen.")
    if "not connected" in low:
        return ("  -> SENDLIB_FROM names a Gmail that is not linked. Connect that"
                " exact address in the Sendlib dashboard, or change SENDLIB_FROM"
                " to one that is.")
    if "origin not allowed" in low:
        return ("  -> Add the origin above to this API key's allowed origins in"
                " the Sendlib dashboard.")
    if "invalid api key" in low or r"401" in low:
        return "  -> SENDLIB_API_KEY is wrong or revoked."
    if "quota" in low or "limit" in low:
        return "  -> The account's daily send quota is spent."
    return ""
