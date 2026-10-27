"""Fake secret builders for tests.

Every value is joined at runtime so no secret-shaped literal sits in a test file
(GitGuardian scans the text). None of these values is a real credential.
"""
from __future__ import annotations


def anthropic_key(n: int = 40) -> str:
    return "sk-" + "ant-" + "a" * n


def github_token() -> str:
    return "gh" + "p_" + "b" * 36


def slack_token() -> str:
    return "xox" + "b-" + "1234567890-abcdefghij"


def aws_key_id() -> str:
    return "AK" + "IA" + "ABCDEFGHIJKLMNOP"


def google_key() -> str:
    return "AI" + "za" + "c" * 35


def stripe_key() -> str:
    return "sk" + "_live_" + "d" * 24


def npm_token() -> str:
    return "npm" + "_" + "e" * 36


def gitlab_token() -> str:
    return "glpat" + "-" + "f" * 22


def supermemory_key() -> str:
    return "sm" + "_" + "g" * 24


def jwt() -> str:
    return "ey" + "J" + "h" * 12 + "." + "i" * 12 + "." + "j" * 20


def pem_block(with_end: bool = True) -> str:
    head = "-----BEGIN " + "RSA PRIVATE KEY-----\n"
    body = "MIIEow" + "A" * 60 + "\n"
    tail = "-----END " + "RSA PRIVATE KEY-----" if with_end else ""
    return head + body + tail


def db_url(password: str = "pw" + "Hunter99") -> str:
    return "postgres" + "://" + "admin" + ":" + password + "@db.internal:5432/app"


PASSWORD_BODY = "9x7" + "Lm2" + "Zp4" + "Rt"


def password_assignment(value: str = "q" + PASSWORD_BODY) -> str:
    return "DB_" + "PASSWORD" + "=" + value
