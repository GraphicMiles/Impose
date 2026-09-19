#!/usr/bin/env python3
"""Impose relay: the always-on layer in front of the GPU box (optional).

Same OpenAI-compatible surface as the box gateway (models, chat, search),
plus the two things that make free-tier self-hosting practical:

  WAKE-ON-CHAT  a request arriving while the box is down starts the Studio
                in the background and answers 503 "waking up, retry soon".
  IDLE AUTO-STOP  with no inference for IDLE_STOP_MINUTES, the Studio is
                stopped to save credits. The next chat wakes it again.

No cron jobs here (that is Luna's render-control-plane plus jobs; this relay
stays focused on proxy + wake + idle). Deploy to Render free tier via the
root render.yaml, or any host that runs uvicorn.

Env (Render dashboard, or .env for local):
  CONTROL_KEY        required: Bearer key browsers must present (its own key)
  LLM_GATEWAY_URL    required: the box gateway root, WITHOUT /v1
  LLM_GATEWAY_KEY    required: the box CONTROL_KEY
  ALLOWED_ORIGINS    default * (comma separated to tighten)
  PORT               default 8000
  WAKE_STUDIO        0|1: allow starting/stopping the GPU Studio
  WAKE_ON_CHAT       0|1: auto-wake when a request finds the box down
  IDLE_MONITOR       0|1: stop the Studio after idle
  IDLE_STOP_MINUTES  int: idle minutes before stopping (default 5)
  IDLE_CHECK_MINUTES int: how often the idle loop checks (default 5)
  LIGHTNING_API_KEY / LIGHTNING_USER_ID / LIGHTNING_USERNAME /
  LIGHTNING_STUDIO / LIGHTNING_TEAMSPACE / LIGHTNING_MACHINE (default T4)

Modularisation pass layout: this module is the shell — it owns the FastAPI
app, the lifespan hook, correlation middleware and /health, then mounts the
three routers (auth, media, admin). Cross-cutting helpers live in
relay.shared, runtime configuration and mutable runtime state in
relay.settings. The imports below re-export the historic attribute names
(``server._RATE_BUCKETS``, ``server._otp_email`` …) so earlier tests and
tools keep working. State that a test must replace wholesale (e.g.
``monkeypatch.setattr(_settings, "_rate_pruned_at", 0.0)``) lives on
relay.settings, the single owner.
"""
import os
import re
import socket  # noqa: F401  (module-object alias for test monkeypatching)
import threading
import time
from contextlib import asynccontextmanager

import httpx  # noqa: F401  (module-object alias: tests monkeypatch httpx.get through server)
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

import relay.settings as _settings
from relay.settings import (  # noqa: F401  (re-exported for back-compat)
    ALLOWED_ORIGINS, CONTROL_KEY, GATEWAY_KEY, GATEWAY_URL,
    IDLE_CHECK_MINUTES, IDLE_MONITOR, IDLE_STOP_MINUTES, PORT,
    PUB_SEARCH_LIMIT, RESTART_SCRIPT, STARTED_AT, WAKE_ON_CHAT, WAKE_STUDIO,
    _CACHE, _MEMBER_CACHE, _RATE_BUCKETS, _rate_lock, _state_lock,
    _wake_lock, _cache_lock, _member_cache_lock,
)
from relay.shared import (  # noqa: F401  (re-exported for back-compat)
    _authed, _authed_member, _bounded_mapping, _bounded_strings, _cache_get,
    _cache_put, _client_ip, _conversion_signature, _gateway_snapshot,
    _idle_loop, _is_owner, _local_part_is_spammy, _member_cache_get,
    _member_cache_put, _need_wake, _otp_email, _otp_password, _rate_hit,
    _rate_over, _rate_prune, _resolve_public_ips, _safe_file_bytes,
    _semantic_bool, _signup_email, _status_note, _tier_auth,
    _verify_image_constraints, gateway_reachable, html_to_text,
)
from relay.mailer import (  # noqa: F401  (re-exported for back-compat)
    MailFailed, send_code, send_grant,
)
from relay.images import engine_images  # noqa: F401  (re-exported)
from relay.search import engine_search  # noqa: F401  (re-exported)
from relay.videos import engine_videos  # noqa: F401  (re-exported)


@asynccontextmanager
async def _lifespan(_app):
    """Start background work whether launched with ``python`` or uvicorn.

    Render imports ``relay.server:app`` directly, so setup hidden only in
    main() never ran there. Keep this hook idempotent for tests and reloads.
    """
    with _settings._lifecycle_lock:
        if not _settings._lifecycle_started:
            _settings._lifecycle_started = True
            print(f"[relay] gateway: {GATEWAY_URL or 'UNSET'} | "
                  f"auth: {'enabled' if CONTROL_KEY else 'DISABLED'} | "
                  f"wake_studio: {WAKE_STUDIO}", flush=True)

            # Accounts need three things and silently refuse without them.
            # A user found this by filling in a signup form and getting
            # "accounts are not configured on the server", which is a
            # deployment gap discovered in the worst possible place. Say it
            # at boot, in the logs, where it is cheap to notice and name
            # exactly which variable is missing.
            missing = [name for name in
                       ("SUPABASE_URL", "SUPABASE_SERVICE_KEY", "OTP_PEPPER")
                       if not os.environ.get(name, "").strip()]
            if missing:
                print("[relay] ACCOUNTS DISABLED, missing: " + ", ".join(missing) +
                      " -- signup, sign-in and password reset will answer 503"
                      " until these are set.", flush=True)
            elif not (os.environ.get("SENDLIB_API_KEY", "").strip()
                      and os.environ.get("SENDLIB_FROM", "").strip()):
                # Both are needed together; one alone falls back to console
                # mode, which looks like it works and emails nobody.
                print("[relay] accounts ON, but SENDLIB_API_KEY/SENDLIB_FROM are"
                      " incomplete: codes will be printed to this log, not"
                      " emailed.", flush=True)
            else:
                print("[relay] accounts: ready", flush=True)
            if IDLE_MONITOR and WAKE_STUDIO:
                threading.Thread(target=_idle_loop, daemon=True).start()
                print(f"[relay] idle monitor every {IDLE_CHECK_MINUTES}m "
                      f"(stop GPU after {IDLE_STOP_MINUTES}m idle)", flush=True)
    yield


app = FastAPI(title="impose-relay", lifespan=_lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS or ["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _correlate(request: Request, call_next):
    """Carry the browser's request id through the log and back in the reply.

    A browser log line and a relay log line describing the same request
    previously had nothing in common, so matching them meant comparing
    timestamps by eye across two systems. Three of the recent signup
    outages were diagnosed that way and it was slow every time.

    Only the account endpoints are logged. Logging every request would
    bury the ones that matter under feed traffic, and these are the ones
    that fail in ways the browser cannot see.
    """
    # The id travels back into a response header and into the log, so it is
    # stripped of control characters first: an echoed request header is a
    # classic injection point, and a log line is a spoofable one.
    rid = re.sub(r"[\x00-\x1f\x7f]+", "", request.headers.get("X-Request-Id", ""))[:64]
    started = time.time()
    response = await call_next(request)
    if rid and request.url.path.startswith("/v1/auth/"):
        ms = int((time.time() - started) * 1000)
        print(f"[req] {rid} {request.method} {request.url.path} "
              f"-> {response.status_code} ({ms}ms)", flush=True)
    if rid:
        response.headers["X-Request-Id"] = rid
    return response


@app.get("/health")
def health():
    """Report liveness without waiting on the optional LLM gateway.

    Health contains no private data and is readable from every origin. This
    lets the portable/local app distinguish a live relay from a browser CORS
    failure while protected relay routes keep the configured origin policy.
    """
    snap = _gateway_snapshot()
    return JSONResponse(
        {"ok": True, "service": "impose-relay",
         "gateway_up": snap.get("up") is True,
         "uptime_seconds": round(time.time() - STARTED_AT, 1)},
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-store"},
    )


from relay.routers import admin as _admin_routes  # noqa: E402
from relay.routers import auth as _auth_routes   # noqa: E402
from relay.routers import media as _media_routes  # noqa: E402

app.include_router(_auth_routes.router)
app.include_router(_media_routes.router)
app.include_router(_admin_routes.router)

# Historic attribute names some tests still reach for. Values that are
# mutable containers (dicts, locks) are the very objects so .clear()/setitem
# keeps working for everyone; scalars that must be reassigned now live on
# relay.settings and the few tests doing so were updated to touch it.



# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #


def main() -> None:
    print(f"[relay] starting on 0.0.0.0:{PORT}", flush=True)
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="warning")


if __name__ == "__main__":
    main()
