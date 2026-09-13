"""Security-boundary regression tests for relay target resolution."""
import os
import socket
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
os.environ.setdefault("CONTROL_KEY", "test123")

from relay import server  # noqa: E402


def _answer(ip):
    family = socket.AF_INET6 if ":" in ip else socket.AF_INET
    return (family, socket.SOCK_STREAM, 6, "", (ip, 0, 0, 0) if family == socket.AF_INET6 else (ip, 0))


def test_resolution_accepts_only_all_global_answers(monkeypatch):
    monkeypatch.setattr(server.socket, "getaddrinfo", lambda *a, **k: [
        _answer("8.8.8.8"), _answer("2001:4860:4860::8888")
    ])
    assert server._resolve_public_ips("safe.example") == ["8.8.8.8", "2001:4860:4860::8888"]


def test_resolution_rejects_mixed_public_private_dns(monkeypatch):
    monkeypatch.setattr(server.socket, "getaddrinfo", lambda *a, **k: [
        _answer("8.8.8.8"), _answer("127.0.0.1")
    ])
    assert server._resolve_public_ips("mixed.example") == []


def test_resolution_rejects_non_global_ranges(monkeypatch):
    for address in ("10.0.0.1", "100.64.0.1", "169.254.1.1", "224.0.0.1", "::1", "fe80::1"):
        monkeypatch.setattr(server.socket, "getaddrinfo", lambda *a, _ip=address, **k: [_answer(_ip)])
        assert server._resolve_public_ips("blocked.example") == [], address


def test_resolution_rejects_unparseable_answer(monkeypatch):
    monkeypatch.setattr(server.socket, "getaddrinfo", lambda *a, **k: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("not-an-ip", 0))
    ])
    assert server._resolve_public_ips("broken.example") == []
