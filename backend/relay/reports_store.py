"""Operator view of content reports.

The reports table has no client policies at all: RLS is on and nothing is
granted to anon or authenticated, so only a service-role caller can read
it. This module is that caller. It exists so moderation does not require
opening the database dashboard: the relay already holds the service key
and the CONTROL_KEY that guards this path, so the operator gets one URL.

Keeps no state. A report's lifecycle (pending -> reviewed/actioned/
dismissed) is updated directly in the database by the operator; reading
here never changes anything.
"""

from __future__ import annotations

import os

import httpx

TIMEOUT = httpx.Timeout(8.0, connect=5.0)

STATUSES = {"pending", "reviewed", "actioned", "dismissed"}


class ReportsError(RuntimeError):
    def __init__(self, message: str, *, status: int = 400):
        super().__init__(message)
        self.status = status


def _base() -> str:
    base = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    if not base:
        raise ReportsError("Reports are not configured on the server.", status=503)
    return base


def _headers() -> dict:
    key = os.environ.get("SUPABASE_SERVICE_KEY", "").strip()
    if not key:
        raise ReportsError("Reports are not configured on the server.", status=503)
    return {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


async def fetch(status: str = "pending", limit: int = 50) -> list:
    """Newest first. Embeds the reporter's handle through the FK so the
    operator can see who flagged what without a second lookup."""
    if status not in STATUSES:
        raise ReportsError("Unknown report status.")
    limit = max(1, min(int(limit), 200))
    url = (
        f"{_base()}/rest/v1/reports"
        f"?select=id,kind,target_id,reporter_id,reason,status,created_at,"
        f"reporter:profiles(handle,display_name)"
        f"&status=eq.{status}&order=created_at.desc&limit={limit}"
    )
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            response = await client.get(url, headers=_headers())
    except httpx.HTTPError as exc:
        raise ReportsError("Could not reach the server. Try again shortly.", status=502) from exc
    if response.status_code >= 400:
        # Detail to the log, never to the caller: it may quote table shape.
        print(f"[reports] fetch -> {response.status_code} {response.text[:300]}")
        raise ReportsError("Could not reach the server. Try again shortly.", status=502)
    try:
        rows = response.json()
    except ValueError:
        rows = []
    return rows if isinstance(rows, list) else []
