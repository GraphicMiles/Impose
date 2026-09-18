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


# --------------------------------------------------------------------------- #
# client identification + limiter hygiene
# --------------------------------------------------------------------------- #


class _FakeClient:
    def __init__(self, host):
        self.host = host


class _FakeRequest:
    def __init__(self, host=None, forwarded=""):
        self.client = _FakeClient(host) if host else None
        self.headers = {"x-forwarded-for": forwarded} if forwarded else {}


def test_client_ip_prefers_the_rightmost_forwarded_hop():
    """The proxy appends the hop it saw; a caller can prepend a fake value
    but cannot change the rightmost entry the infrastructure wrote."""
    req = _FakeRequest(host="10.0.0.1", forwarded="6.6.6.6, 1.2.3.4")
    assert server._client_ip(req) == "1.2.3.4"


def test_client_ip_skips_unparseable_forwarded_entries():
    req = _FakeRequest(host="10.0.0.2", forwarded="junk, not.an.ip, 9.9.9.9")
    assert server._client_ip(req) == "9.9.9.9"


def test_client_ip_falls_back_to_the_socket_address():
    assert server._client_ip(_FakeRequest(host="10.0.0.3")) == "10.0.0.3"
    assert server._client_ip(_FakeRequest(host="10.0.0.4", forwarded="junk")) == "10.0.0.4"
    assert server._client_ip(_FakeRequest()) == "?"


def test_rate_buckets_prune_stale_keys(monkeypatch):
    """An address seen once must not be carried forever."""
    import time as _time

    monkeypatch.setattr(server, "_RATE_BUCKETS", {})
    monkeypatch.setattr(server, "_rate_pruned_at", 0.0)
    now = _time.time()
    # A stale bucket (quiet for two hours) and a live one.
    server._RATE_BUCKETS["otpaddr:old@x.com"] = [now - 7200]
    server._RATE_BUCKETS["otpaddr:new@x.com"] = [now - 1]

    server._rate_hit("probe", "k", 100, 60.0)

    assert "otpaddr:old@x.com" not in server._RATE_BUCKETS
    assert "otpaddr:new@x.com" in server._RATE_BUCKETS


def test_rate_prune_is_throttled(monkeypatch):
    import time as _time

    monkeypatch.setattr(server, "_RATE_BUCKETS", {})
    now = _time.time()
    server._RATE_BUCKETS["otpaddr:old@x.com"] = [now - 7200]
    # Pruned moments ago: a stale bucket survives this pass.
    monkeypatch.setattr(server, "_rate_pruned_at", now)

    server._rate_hit("probe", "k", 100, 60.0)

    assert "otpaddr:old@x.com" in server._RATE_BUCKETS
