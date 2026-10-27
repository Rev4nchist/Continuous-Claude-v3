"""Secret redaction for every memory write path.

One module, reused by store_learning, index_handoffs, supersede, incremental_extract,
distill_learning, memory_write_log and MemoryServicePG.store (the backstop).

Patterns adapted from supermemoryai/claude-supermemory plugin/hooks/lib/redact.js
(MIT, declared in README and plugin.json).

Rules:
- A match is replaced with a marker, ``[REDACTED:<kind>]``. Nothing is skipped.
- ``hits`` holds kinds, one per replacement. It never holds a matched value.
- Idempotent: ``redact(redact(x).text).hits == ()``. A marker counts as a placeholder.
- This module imports no database code, so light scripts can import it.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

MARKER = "[REDACTED:{kind}]"
_MIN_VALUE_CHARS = 8

_PLACEHOLDER_PREFIXES = (
    "your", "example", "placeholder", "replace", "insert", "changeme", "redacted",
)
_PLACEHOLDER_WORDS = {"password", "token", "api-key", "api_key", "apikey", "secret", "dummy"}
_ENV_LOOKUP_PREFIXES = ("process.env", "os.environ", "os.getenv", "getenv", "env.", "env[")


@dataclass(frozen=True)
class RedactResult:
    text: str
    hits: tuple[str, ...]  # kinds, one per replacement, never values


def _marker(kind: str) -> str:
    return MARKER.format(kind=kind)


def _is_placeholder(value: str) -> bool:
    v = value.strip().strip("'\"`").strip()
    low = v.lower()
    if not low or "[redacted" in low:
        return True
    if (v.startswith("<") and v.endswith(">")) or v.startswith(("${", "{{", "$")):
        return True
    if low.startswith(_PLACEHOLDER_PREFIXES) or low in _PLACEHOLDER_WORDS:
        return True
    if low.startswith(_ENV_LOOKUP_PREFIXES):
        return True
    return set(v) <= {"*", "."}


# --- Rules. Each returns the replacement for one match, or None to leave it. ---

_PRIVATE_KEY = re.compile(
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|\Z)"
)


def _private_key(_m: re.Match[str]) -> str | None:
    return _marker("private_key")


# The password may hold "/" or "@". It is greedy up to the last "@" that is followed by a
# host, so "user:pa@ss@host" and "user:pa/ss@host" are cut whole. Over-cutting a URL with an
# "@" in its path is the safe side. The user may be empty: redis://:password@host.
_URL_CREDENTIALS = re.compile(
    r"(?P<scheme>\b[A-Za-z][A-Za-z0-9+.-]*://)(?P<user>[^\s:/@]*):(?P<pw>[^\s]+)"
    r"@(?=[^\s@/]+(?:[:/]|\s|$))"
)
_PORT_THEN_PATH = re.compile(r"\d+/")


def _url_credentials(m: re.Match[str]) -> str | None:
    pw = m.group("pw")
    if "[REDACTED" in m.group(0) or _is_placeholder(pw):
        return None
    if _PORT_THEN_PATH.match(pw):  # host:8080/path?mail=a@b is not user:password@host
        return None
    return f"{m.group('scheme')}{_marker('url_credentials')}@"


_CREDENTIAL_NAMES = (
    r"API[_-]?KEY|ACCESS[_-]?KEY[_-]?ID|SECRET[_-]?ACCESS[_-]?KEY|ACCESS[_-]?TOKEN"
    r"|AUTH[_-]?TOKEN|REFRESH[_-]?TOKEN|CLIENT[_-]?SECRET|PRIVATE[_-]?KEY"
    r"|SECRET[_-]?KEY|ENCRYPTION[_-]?KEY|SIGNING[_-]?KEY"
    r"|PASSWORD|PASSWD|SECRET|TOKEN"
)
_CREDENTIAL = re.compile(
    rf"(?P<name>{_CREDENTIAL_NAMES})(?P<sep>[\"']?[ \t]*[:=](?!=)[ \t]*)"
    r"(?P<val>\"[^\"\n]*\"|'[^'\n]*'|[^\s\"',;]+)",
    re.IGNORECASE,
)


# Values that read as code or prose, not as a secret. A bare name (TOKEN, SECRET, PASSWORD,
# PASSWD with no prefix) is also an ordinary word, so it needs a value with a digit or symbol.
_BARE_NAMES = {"token", "secret", "password", "passwd"}
_WORD_CHAIN = re.compile(r"[A-Za-z]+(?:[_-][A-Za-z]+)*")
_LOWER_WORD_CHAIN = re.compile(r"[a-z]+(?:[_-][a-z]+)+")  # two or more lowercase words
_CAMEL = re.compile(r"(?:[A-Z][a-z]{2,}){2,}|[a-z]{2,}(?:[A-Z][a-z]{2,})+")
_DOTTED_IDENTIFIER = re.compile(r"[A-Za-z]\.[A-Za-z]")
# config.api_key, settings.db_password: lowercase dotted names, no digit or symbol.
# This is code for any credential name.
# Accepted gap: a digit-free passphrase in this shape (correct.horse.battery or
# CorrectHorseBattery) is not redacted. Values with a digit or symbol still are.
_LOWER_DOTTED_CHAIN = re.compile(r"[a-z_]+(?:\.[a-z_]+)+")
# get_key(settings), os.environ["X"], Optional[str]: a call or index on an identifier with no
# digit, closed at the end. A password such as Xk9(mP2!qR does not match.
_CALL_OR_INDEX = re.compile(r"[A-Za-z_][A-Za-z_.]*[(\[][^\s]*[)\]]")


def _is_code_or_prose(value: str, *, bare: bool) -> bool:
    if _CAMEL.fullmatch(value) or _LOWER_DOTTED_CHAIN.fullmatch(value):
        return True
    if _CALL_OR_INDEX.fullmatch(value):
        return True
    if bare:
        return bool(_WORD_CHAIN.fullmatch(value) or _DOTTED_IDENTIFIER.search(value))
    return False


def _credential(m: re.Match[str]) -> str | None:
    val = m.group("val")
    quote = val[0] if val[0] in "\"'" else ""
    inner = val[1:-1] if quote and len(val) >= 2 and val[-1] == quote else val
    if len(inner) < _MIN_VALUE_CHARS or _is_placeholder(inner):
        return None
    before = m.string[m.start() - 1] if m.start() else " "
    bare = m.group("name").lower() in _BARE_NAMES and not (before.isalnum() or before in "_-")
    if _is_code_or_prose(inner, bare=bare):
        return None
    return f"{m.group('name')}{m.group('sep')}{quote}{_marker('credential')}{quote}"


_BEARER = re.compile(r"(?P<head>\bBearer\s+)(?P<tok>[A-Za-z0-9._~+/=-]{16,})", re.IGNORECASE)


def _bearer(m: re.Match[str]) -> str | None:
    tok = m.group("tok")
    if _is_placeholder(tok) or _LOWER_WORD_CHAIN.fullmatch(tok) or _CAMEL.fullmatch(tok):
        return None  # "Bearer authentication-required" is prose
    return f"{m.group('head')}{_marker('bearer_token')}"


_BASIC = re.compile(
    r"(?P<head>Authorization:[ \t]*Basic[ \t]+)(?P<tok>[A-Za-z0-9+/=]{16,})", re.IGNORECASE
)


def _basic(m: re.Match[str]) -> str | None:
    return f"{m.group('head')}{_marker('basic_auth')}"


_PROVIDER_TOKEN = re.compile(
    r"(?<![A-Za-z0-9_])(?:"
    r"sk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}"
    r"|sm_[A-Za-z0-9_]{20,}"
    r"|gh[pousr]_[A-Za-z0-9]{20,}"
    r"|github_pat_[A-Za-z0-9_]{20,}"
    r"|xox[baprs]-[A-Za-z0-9-]{10,}"
    r"|xapp-[A-Za-z0-9-]{10,}"
    r"|(?:AKIA|ASIA)[A-Z0-9]{16}"
    r"|AIza[0-9A-Za-z_-]{35}"
    r"|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}"
    r"|npm_[A-Za-z0-9]{36}"
    r"|glpat-[A-Za-z0-9_-]{20,}"
    r")"
)


def _provider_token(_m: re.Match[str]) -> str | None:
    return _marker("provider_token")


_JWT = re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}")


def _jwt(_m: re.Match[str]) -> str | None:
    return _marker("jwt")


# Order matters: credential runs before provider_token, so API_KEY=<sk-key> is "credential".
_RULES: tuple[tuple[str, re.Pattern[str], Callable[[re.Match[str]], str | None]], ...] = (
    ("private_key", _PRIVATE_KEY, _private_key),
    ("url_credentials", _URL_CREDENTIALS, _url_credentials),
    ("credential", _CREDENTIAL, _credential),
    ("bearer_token", _BEARER, _bearer),
    ("basic_auth", _BASIC, _basic),
    ("provider_token", _PROVIDER_TOKEN, _provider_token),
    ("jwt", _JWT, _jwt),
)


def redact(text: str) -> RedactResult:
    """Replace every secret in ``text`` with a marker. Never raises on a str."""
    if not text:
        return RedactResult(text or "", ())
    hits: list[str] = []
    for kind, pattern, fn in _RULES:

        def _sub(m: re.Match[str], _kind: str = kind, _fn=fn) -> str:
            replacement = _fn(m)
            if replacement is None:
                return m.group(0)
            hits.append(_kind)
            return replacement

        text = pattern.sub(_sub, text)
    return RedactResult(text, tuple(hits))


def redact_obj(obj: Any) -> tuple[Any, tuple[str, ...]]:
    """Redact every string inside dicts, lists and tuples. Other values pass through.

    Returns a new object. The input is not changed. Dict keys are not redacted.
    """
    if isinstance(obj, str):
        result = redact(obj)
        return result.text, result.hits
    if isinstance(obj, dict):
        out_d: dict[Any, Any] = {}
        hits_d: list[str] = []
        for key, value in obj.items():
            new, h = redact_obj(value)
            out_d[key] = new
            hits_d.extend(h)
        return out_d, tuple(hits_d)
    if isinstance(obj, (list, tuple)):
        items = [redact_obj(v) for v in obj]
        seq = [i[0] for i in items]
        hits_s = tuple(h for i in items for h in i[1])
        return (seq if isinstance(obj, list) else tuple(seq)), hits_s
    return obj, ()


def contains_secret(text: str) -> bool:
    return bool(redact(text).hits)
