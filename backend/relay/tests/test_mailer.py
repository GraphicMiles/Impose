"""The outbound mail request.

Sendlib scopes an API key to an allowlist of origins and reads the Origin
header. A server-to-server call sends none, so ours arrived as 'unknown'
and was refused with 403 while every credential was correct. These pin the
header so that cannot recur silently.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from relay import mailer  # noqa: E402


def test_requests_carry_an_origin():
    h = mailer._auth_headers()
    assert h.get("Origin"), "Sendlib reads this to match its allowlist"
    assert h["Origin"].startswith("http"), h["Origin"]


def test_the_origin_is_overridable_per_deployment(monkeypatch):
    monkeypatch.setenv("SENDLIB_ORIGIN", "https://example.test")
    assert mailer._auth_headers()["Origin"] == "https://example.test"


def test_a_blank_override_falls_back(monkeypatch):
    """An empty env var is a common deploy slip and must not send Origin: ''."""
    monkeypatch.setenv("SENDLIB_ORIGIN", "   ")
    assert mailer._auth_headers()["Origin"].startswith("https://")


def test_the_key_is_sent_as_a_bearer_token(monkeypatch):
    monkeypatch.setenv("SENDLIB_API_KEY", "k-123")
    assert mailer._auth_headers()["Authorization"] == "Bearer k-123"


def test_send_and_probe_use_the_same_headers():
    """They authenticate identically, or the probe proves nothing about send."""
    src = open(os.path.join(os.path.dirname(__file__), "..", "mailer.py")).read()
    assert src.count("headers=_auth_headers()") == 2


def test_console_mode_when_unconfigured(monkeypatch, capsys):
    """No key means the code is printed, not silently dropped.

    Driven with asyncio.run rather than pytest-asyncio: the suite has no
    async plugin and one test is not worth a new dependency.
    """
    import asyncio
    monkeypatch.delenv("SENDLIB_API_KEY", raising=False)
    monkeypatch.delenv("SENDLIB_FROM", raising=False)
    asyncio.run(mailer.send_code("a@b.com", "12345678", "signup", 600))
    assert "12345678" in capsys.readouterr().out
