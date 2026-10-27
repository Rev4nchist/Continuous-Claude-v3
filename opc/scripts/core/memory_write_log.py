"""Failed-write log for the memory store.

A store that fails must leave a trace the SessionStart health line can count.
On 2026-10-24 every store failed for 3 days and nothing recorded it.

File: ~/.claude/state/memory-write-failures.jsonl
Line: {"ts", "source", "error", "session_id"}

Rules: the URL is masked, secrets are redacted, the error is cut to 300 characters, and nothing here
ever raises. The TypeScript reader is .claude/hooks/src/shared/memory-health.ts.
"""

from __future__ import annotations

import json
import os
import re
import sys
from datetime import UTC, datetime
from pathlib import Path

try:
    from db.memory_redact import redact
except ImportError:  # imported without scripts/ on the path
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from db.memory_redact import redact

MAX_ERROR_CHARS = 300
_URL_RE = re.compile(r"postgres(?:ql)?(?:\+\w+)?://\S+", re.IGNORECASE)


def mask_urls(text: str) -> str:
    """Replace any postgres:// or postgresql:// URL with <db-url>."""
    return _URL_RE.sub("<db-url>", text)


def failure_log_path() -> Path:
    """Resolved at call time. CCV3_MEMORY_FAILURE_LOG overrides it, so test runs
    that force a store failure never write to the real log the health line counts."""
    override = os.environ.get("CCV3_MEMORY_FAILURE_LOG")
    if override:
        return Path(override)
    return Path.home() / ".claude" / "state" / "memory-write-failures.jsonl"


def record_write_failure(source: str, error: object, session_id: str | None) -> None:
    """Append one failure line. Never raises."""
    try:
        path = failure_log_path()
        # Owner-only, like shared/guard-log.ts: driver errors can quote row values.
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        entry = {
            "ts": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "source": source,
            "error": redact(mask_urls(str(error))).text[:MAX_ERROR_CHARS],
            "session_id": session_id or "unknown",
        }
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")
    except Exception:  # noqa: BLE001 - a log must never break a store
        pass
