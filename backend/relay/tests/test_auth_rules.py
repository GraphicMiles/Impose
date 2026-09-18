"""Email and password rules at the boundary that decides.

Both were reported from production: the reset flow checked only length, so
a password signup had refused could be set anyway, and any syntactically
valid address was accepted including example.com, which by RFC 2606 can
never receive mail.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

os.environ.setdefault("OTP_PEPPER", "test-pepper")
os.environ.setdefault("SUPABASE_URL", "https://stub.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_KEY", "stub")

from fastapi import HTTPException  # noqa: E402

from relay import server  # noqa: E402


def refuse(fn, value, field):
    with pytest.raises(HTTPException) as e:
        fn({field: value})
    return e.value.detail


@pytest.mark.parametrize("addr", [
    "you@example.com", "a@example.org", "b@test.com",
    "c@mailinator.com", "d@10minutemail.com", "e@yopmail.com",
    "f@guerrillamail.com", "g@maildrop.cc",
    # 'x@invalid' is caught earlier by the shape rule: a bare TLD has no
    # dot. Asserted separately below so the two reasons stay distinct.
])
def test_throwaway_and_reserved_domains_are_refused(addr):
    """A disposable signup takes a handle and is unreachable the moment it
    is abused: there is no account to warn, suspend or email."""
    detail = refuse(server._otp_email, addr, "email")
    assert "not accepted" in detail, (addr, detail)


@pytest.mark.parametrize("addr", [
    "someone@gmail.com", "a.b@company.co.uk", "user+tag@outlook.com",
])
def test_real_addresses_still_pass(addr):
    assert server._otp_email({"email": addr}) == addr.lower()


@pytest.mark.parametrize("addr", [
    "", "no-at-sign", "@nolocal.com", "spaces in@x.com",
    ".lead@x.com", "trail.@x.com", "two..dots@x.com",
])
def test_malformed_addresses_are_refused(addr):
    assert "valid email" in refuse(server._otp_email, addr, "email")


def test_an_over_long_address_is_refused():
    assert "valid email" in refuse(server._otp_email, "a" * 250 + "@x.com", "email")


def test_the_address_is_normalised():
    assert server._otp_email({"email": "  MiXeD@Gmail.COM  "}) == "mixed@gmail.com"


@pytest.mark.parametrize("pw,missing", [
    ("short1!", "at least 8"),
    ("abcdefghij", "number"),
    ("abcdefgh1", "special"),
    ("abcdefgh!", "number"),
])
def test_weak_passwords_are_refused(pw, missing):
    """The reset flow shared this function but only length was checked, so
    it could set a password the signup form had already refused."""
    assert missing in refuse(server._otp_password, pw, "password")


def test_a_compliant_password_passes():
    assert server._otp_password({"password": "Str0ng!Pass1"}) == "Str0ng!Pass1"


def test_an_absurd_password_is_refused():
    assert "too long" in refuse(server._otp_password, "a1!" * 200, "password")


def test_signup_and_reset_share_one_rule():
    """Two call sites, one function. Separate rules drift, and the weaker
    one becomes the real policy."""
    src = open(os.path.join(os.path.dirname(__file__), "..", "server.py")).read()
    assert src.count("_otp_password(data)") == 2


def test_a_dotless_domain_is_refused_as_malformed_not_as_a_provider():
    """Different reason, different message. 'x@invalid' has no dot so it
    never reaches the provider list, and saying 'provider not accepted'
    would send the reader looking for a different address when the address
    itself is the problem."""
    assert "valid email" in refuse(server._otp_email, "x@invalid", "email")


@pytest.mark.parametrize("addr", [
    # Keyboard mash: no vowels in twelve letters, and a bigram block
    # repeating three times. The reported example.
    "skskdjdjdjdh@gmail.com",
    # Digits interleaved with a trigram-style repeat. The other one.
    "18w8e7shshsysysy@outlook.com",
    # One character six times in a row.
    "aaaaaa@gmail.com",
    # A three-character block three times.
    "abcabcabc@yahoo.com",
    # Consonant soup with no pattern but also no vowels.
    "brktwzx@gmail.com",
])
def test_spammy_local_parts_are_refused_at_signup(addr):
    """Signup derives the display name and handle from the local part, so
    an account minted from one is unnameable and unreachable: exactly the
    shape that exists to spam. The database enforces the same rules on
    profile names and waitlist joins."""
    detail = refuse(server._signup_email, addr, "email")
    assert "made up" in detail, (addr, detail)


@pytest.mark.parametrize("addr", [
    "someone@gmail.com", "a.b@company.co.uk", "user+tag@outlook.com",
    # The flows' working address and the shapes real mailboxes actually
    # take: short, digit-heavy phone numbers, dotted names.
    "a@b.com", "08031234567@gmail.com", "mike.jones@fastmail.com",
    "ada@lovelace.dev", "ngozi.okafor@example-mail.net",
])
def test_real_addresses_still_pass_signup(addr):
    assert server._signup_email({"email": addr}) == addr.lower()


def test_an_over_long_local_part_is_refused():
    """RFC 5321 caps the local part at 64 octets. Anything longer is not a
    mailbox; it is an input testing how much of it we swallow."""
    assert "valid email" in refuse(server._otp_email, "a" * 65 + "@x.com", "email")


def test_the_spammy_rule_applies_to_signup_only():
    """A legacy account with an odd address must still be able to reset
    and sign in; the quality gate protects account creation, not
    recovery."""
    odd = "skskdjdjdjdh@gmail.com"
    assert server._otp_email({"email": odd}) == odd
    detail = refuse(server._signup_email, odd, "email")
    assert "made up" in detail
