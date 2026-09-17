"""One-time code behaviour.

These guard the properties that make the codes worth having: they expire,
they are single use, they cannot be brute forced, and one purpose's code
cannot be spent on another.
"""
import os
import sys
import time

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from relay import otp  # noqa: E402


@pytest.fixture(autouse=True)
def clean():
    otp.reset_for_tests()
    yield
    otp.reset_for_tests()


def test_issue_returns_a_code_of_the_expected_shape():
    out = otp.issue("a@b.com", "signup")
    assert out["code"].isdigit()
    assert len(out["code"]) == otp.CODE_LENGTH
    assert out["reused"] is False


def test_the_code_is_not_stored_in_the_clear():
    """A dump of the store must not let the reader sign in as anybody."""
    out = otp.issue("a@b.com", "signup")
    blob = repr(otp._store)
    assert out["code"] not in blob


def test_correct_code_verifies_once_then_cannot_be_replayed():
    out = otp.issue("a@b.com", "signup")
    otp.verify("a@b.com", "signup", out["code"])
    with pytest.raises(otp.OtpError) as exc:
        otp.verify("a@b.com", "signup", out["code"])
    assert exc.value.status == 410


def test_wrong_code_counts_down_then_burns_the_record():
    out = otp.issue("a@b.com", "signup")
    for _ in range(otp.MAX_ATTEMPTS - 1):
        with pytest.raises(otp.OtpError):
            otp.verify("a@b.com", "signup", "00000000")
    with pytest.raises(otp.OtpError) as exc:
        otp.verify("a@b.com", "signup", "00000000")
    assert exc.value.status == 429
    # The real code must die with the record, or the cap means nothing.
    with pytest.raises(otp.OtpError) as exc2:
        otp.verify("a@b.com", "signup", out["code"])
    assert exc2.value.status == 410


def test_a_signup_code_cannot_be_spent_on_a_reset():
    out = otp.issue("a@b.com", "signup")
    with pytest.raises(otp.OtpError) as exc:
        otp.verify("a@b.com", "reset", out["code"])
    assert exc.value.status == 410


def test_expired_codes_are_refused():
    original = otp.CODE_TTL_SECONDS
    otp.CODE_TTL_SECONDS = 1
    try:
        out = otp.issue("a@b.com", "signup")
        time.sleep(1.1)
        with pytest.raises(otp.OtpError) as exc:
            otp.verify("a@b.com", "signup", out["code"])
        assert exc.value.status == 410
    finally:
        otp.CODE_TTL_SECONDS = original


def test_resend_inside_the_cooldown_reuses_the_live_code():
    """A double tap must not invalidate the code already in the inbox."""
    first = otp.issue("a@b.com", "signup")
    second = otp.issue("a@b.com", "signup")
    assert second["reused"] is True
    assert second["code"] is None
    otp.verify("a@b.com", "signup", first["code"])


def test_unknown_purpose_is_rejected():
    with pytest.raises(otp.OtpError):
        otp.normalize_purpose("something-else")


def test_addresses_are_matched_case_insensitively():
    out = otp.issue("MiXeD@B.com", "signup")
    otp.verify("mixed@b.com", "signup", out["code"])


def test_verify_ignores_separators_in_the_supplied_code():
    """Users paste codes with spaces; that is not a wrong code."""
    out = otp.issue("a@b.com", "signup")
    spaced = " ".join(out["code"])
    otp.verify("a@b.com", "signup", spaced)
