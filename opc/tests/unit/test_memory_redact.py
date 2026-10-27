"""Secret redaction: one shared module, every write path.

Ways it can fail, one test each (each names the change that breaks it):
1. A pattern kind is removed or stops matching -> parametrized over every kind.
2. A placeholder value is redacted -> the placeholder skip is removed.
3. A second pass finds hits or changes text -> "[REDACTED" dropped from the skip list.
4. A word that merely ends in "sk-" is tagged -> the lookbehind is removed.
5. A PEM with no END line leaks its body -> the END line becomes mandatory.
6. hits carry the matched text -> a secret appears in repr(hits).
7. redact_obj stops recursing, or touches non-strings.
8. distill_learning.is_secret_bearing keeps the bare-keyword regex.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

from db import memory_redact as mr  # noqa: E402

from tests.unit import fake_secrets as fs  # noqa: E402

CASES = [
    ("private_key", fs.pem_block(), "MIIEow"),
    ("url_credentials", "connect " + fs.db_url() + " now", "Hunter99"),
    ("credential", fs.password_assignment(), "9x7Lm2Zp4Rt"),
    ("credential", "OPENAI_" + "API_KEY" + ": " + "zz" * 10, "zzzzzz"),
    ("credential", '{"client_' + 'secret": "' + "w" * 20 + '"}', "wwwwww"),
    ("bearer_token", "Authorization: Bear" + "er " + "t" * 30, "tttttt"),
    ("basic_auth", "Authorization: Ba" + "sic " + "QWxhZGRpbjpvcGVuIHNlc2FtZQ==", "QWxhZGRpbjpv"),
    ("provider_token", "key " + fs.anthropic_key(), "aaaaaaaa"),
    ("provider_token", fs.github_token(), "bbbbbbbb"),
    ("provider_token", fs.slack_token(), "abcdefghij"),
    ("provider_token", "id " + fs.aws_key_id(), "ABCDEFGHIJKLMNOP"),
    ("provider_token", fs.google_key(), "cccccccc"),
    ("provider_token", fs.stripe_key(), "dddddddd"),
    ("provider_token", fs.npm_token(), "eeeeeeee"),
    ("provider_token", fs.gitlab_token(), "ffffffff"),
    ("provider_token", fs.supermemory_key(), "gggggggg"),
    ("jwt", "token is " + fs.jwt(), "hhhhhhhh"),
]


@pytest.mark.parametrize(("kind", "text", "body"), CASES)
def test_each_kind_becomes_its_marker(kind, text, body):
    result = mr.redact(text)
    assert kind in result.hits
    assert mr.MARKER.format(kind=kind) in result.text
    assert body not in result.text


@pytest.mark.parametrize(
    "text",
    [
        "API_" + "KEY=your-key-goes-here",
        "TOKEN=${" + "TOKEN}",
        "PASSWORD=<" + "your-password>",
        "SECRET=" + "{{" + "secret_value}}",
        "API_" + "KEY=" + "$" + "SOME_ENV_VARIABLE",
        "PASS" + "WORD=" + "*" * 12,
        "api_" + "key = process" + ".env.THE_KEY_NAME",
        "TOKEN=" + "change" + "me-please",
        "Bear" + "er " + "[REDACTED:bearer_token]",
    ],
)
def test_placeholder_values_stay(text):
    result = mr.redact(text)
    assert result.hits == ()
    assert result.text == text


def test_second_pass_is_a_no_op():
    text = " ".join(c[1] for c in CASES)
    first = mr.redact(text)
    second = mr.redact(first.text)
    assert second.hits == ()
    assert second.text == first.text
    assert first.hits


def test_word_prefix_before_sk_is_not_a_token():
    text = "task-" + "a" * 24 + " and desk-" + "b" * 24 + " and disk-" + "c" * 24
    assert mr.redact(text).hits == ()


def test_pem_without_end_line_is_cut_to_end_of_text():
    text = "before\n" + fs.pem_block(with_end=False)
    result = mr.redact(text)
    assert "private_key" in result.hits
    assert "MIIEow" not in result.text
    assert result.text.startswith("before\n")


def test_hits_hold_kinds_never_values():
    text = fs.anthropic_key() + " " + fs.password_assignment() + " " + fs.db_url()
    result = mr.redact(text)
    shown = repr(result.hits)
    assert "aaaa" not in shown and "Hunter99" not in shown and "9x7L" not in shown
    assert set(result.hits) <= {
        "private_key", "url_credentials", "credential", "bearer_token",
        "basic_auth", "provider_token", "jwt",
    }


def test_redact_obj_recurses_into_dicts_and_lists_only_strings():
    obj = {
        "a": fs.anthropic_key(),
        "n": 5,
        "flag": True,
        "nested": {"tags": ["ok", fs.github_token()], "x": None},
    }
    out, hits = mr.redact_obj(obj)
    assert out["n"] == 5 and out["flag"] is True and out["nested"]["x"] is None
    assert "aaaa" not in out["a"] and "bbbb" not in out["nested"]["tags"][1]
    assert out["nested"]["tags"][0] == "ok"
    assert hits.count("provider_token") == 2
    assert "aaaa" in obj["a"]  # the input is not mutated


def test_contains_secret_matches_redact_hits():
    assert mr.contains_secret(fs.anthropic_key()) is True
    assert mr.contains_secret("plain prose about api keys and secrets") is False
    assert mr.contains_secret("") is False


def test_is_secret_bearing_uses_value_level_check():
    import distill_learning

    assert distill_learning.is_secret_bearing("API_" + "KEY=[REDACTED:credential]") is False
    assert distill_learning.is_secret_bearing("we rotate the api key weekly") is False
    assert distill_learning.is_secret_bearing(fs.anthropic_key()) is True
    assert not hasattr(distill_learning, "SECRET_RE")


def _sha() -> str:
    import hashlib

    return hashlib.sha1(b"phase3").hexdigest()


def _uuid() -> str:
    import uuid

    return str(uuid.uuid5(uuid.NAMESPACE_DNS, "phase3.example"))


@pytest.mark.parametrize(
    "text",
    [
        "commit " + _sha(),
        "hash 0123456789abcdef and " + _uuid(),
        "the refresh token: expiration is 30 days",
        "secret: rotation happens weekly",
        "param token: Optional[str] = None",
        "password=hashed_password",
        "accessToken: AccessTokenType",
        "Bearer authentication-required",
        "api_key = get_key(settings)",
        "password: config.yaml holds it",
        "self.api_" + "key = config.api_key",
        "DB_" + "PASSWORD=settings.db_password",
        "client_" + "secret = app.settings.client_secret",
        "token = os.environ[\"GH_TOKEN\"]",
        "api_key = load_secret(name)",
    ],
)
def test_prose_and_code_are_not_redacted(text):
    """Breaks if a bare name or the Bearer rule redacts words, identifiers or hashes."""
    result = mr.redact(text)
    assert result.hits == ()
    assert result.text == text


@pytest.mark.parametrize(
    "text",
    [
        "password: " + "abc" + "12345",
        "my token=" + "a1b2c3" + "d4e5f6",
        "GITHUB_" + "TOKEN=" + "plainlowercaseword",
        "secret = " + "Zq" + "8Lm2Xp",
        "DB_" + "PASSWORD=settings.db" + "_password9",
        "API_" + "KEY=" + "abcd.efgh" + "1234",
        "PASS" + "WORD=" + "Xk9(mP2" + "!qR",
        "API_" + "KEY=" + "aB3[x9" + "!Lm2",
        "DB_" + "PASSWORD=" + '"Qw(e7' + 'rT!z"',
        "TOKEN=" + "abc(def" + "ghij",
    ],
)
def test_secret_shaped_values_after_bare_names_are_still_redacted(text):
    """Breaks if the identifier skip swallows values with digits or prefixed names."""
    assert "credential" in mr.redact(text).hits


@pytest.mark.parametrize(
    "password", ["pa/ss" + "Word9", "pa@ss" + "Word9", "a/b@c" + "d/e12"]
)
def test_url_password_with_slash_or_at_is_fully_redacted(password):
    """Breaks if the url_credentials password class stops at '/' or the first '@'."""
    url = "postgres" + "://" + "admin" + ":" + password + "@db.internal:5432/app"
    result = mr.redact("connect " + url + " now")
    assert "url_credentials" in result.hits
    assert "Word9" not in result.text and "d/e12" not in result.text
    assert "ss" + "Word" not in result.text
    assert result.text == "connect postgres://[REDACTED:url_credentials]@db.internal:5432/app now"


def test_url_with_port_and_email_query_is_not_a_credential():
    """Breaks if host:port/path?mail=a@b is read as user:password@host."""
    text = "see http://host:8080/path?mail=foo@bar.com for details"
    assert mr.redact(text).hits == ()


@pytest.mark.parametrize(
    "name",
    ["SECRET_" + "KEY", "DJANGO_SECRET_" + "KEY", "JWT_SECRET_" + "KEY", "SECRET-" + "KEY",
     "ENCRYPTION_" + "KEY", "SIGNING_" + "KEY", "PRIVATE_" + "KEY", "secret_" + "key"],
)
def test_secret_key_family_names_are_redacted(name):
    """Breaks if the credential-name list drops the SECRET_KEY / ENCRYPTION_KEY forms."""
    result = mr.redact(name + "=" + "Zq" + "8Lm2Xp4Rt9")
    assert "credential" in result.hits
    assert "8Lm2Xp4Rt9" not in result.text


@pytest.mark.parametrize("pw", ["pass" + "word99", "Zq" + "8Lm2Xp4Rt"])
def test_url_with_empty_user_is_redacted(pw):
    """Breaks if the url_credentials user group needs 1+ chars (redis://:pw@host)."""
    result = mr.redact("cache " + "redis" + "://" + ":" + pw + "@cache.internal:6379 up")
    assert "url_credentials" in result.hits
    assert pw not in result.text
    assert result.text == "cache redis://[REDACTED:url_credentials]@cache.internal:6379 up"
