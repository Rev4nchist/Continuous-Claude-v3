"""Rejected-candidate hash log.

A candidate that a quality gate or the schema rejects is logged by content hash,
so the next extraction run skips it. The log is a hint, not a ledger.

File: ~/.claude/state/memory-rejected-candidates.jsonl (env CCV3_MEMORY_REJECT_LOG overrides).
It is separate from memory-write-failures.jsonl, so the health line does not count it.
Line: {"ts", "hash", "hash_basis", "stage", "reason", "source", "session_id"}.
A line never holds the candidate content.

Rules: the folder is 0700 and the file is 0600. Nothing here raises. After an append,
a file over the cap is cut to its newest lines. Two rotations at the same time can lose
a few lines.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path

HASH_BASIS = "raw-normalized-sha256-16"
MAX_LINES = 5000
KEEP_LINES = 2500
MAX_BYTES = 1024 * 1024
CHECK_BYTES = 128 * 1024  # below this size the file cannot be over the line cap in practice
MAX_REASON_CHARS = 200


def content_hash(content: str) -> str:
    """Hash of normalized content, used for dedup and for this log."""
    normalized = content.lower().strip()
    normalized = re.sub(r"\s+", " ", normalized)
    return hashlib.sha256(normalized.encode()).hexdigest()[:16]


def reject_log_path() -> Path:
    """Resolved at call time so tests can redirect it."""
    override = os.environ.get("CCV3_MEMORY_REJECT_LOG")
    if override:
        return Path(override)
    return Path.home() / ".claude" / "state" / "memory-rejected-candidates.jsonl"


def _rotate(path: Path) -> None:
    size = path.stat().st_size
    if size < CHECK_BYTES:
        return
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    if len(lines) <= MAX_LINES and size <= MAX_BYTES:
        return
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines[-KEEP_LINES:]) + "\n")
    os.replace(tmp, path)


def record_reject(
    hash_: str, stage: str, reason: str, source: str | None, session_id: str | None
) -> None:
    """Append one line. Never raises."""
    try:
        path = reject_log_path()
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        entry = {
            "ts": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "hash": hash_,
            "hash_basis": HASH_BASIS,
            "stage": stage,
            "reason": str(reason)[:MAX_REASON_CHARS],
            "source": source or "unknown",
            "session_id": session_id or "unknown",
        }
        fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")
        _rotate(path)
    except Exception:  # noqa: BLE001 - a log must never break a store
        pass


def load_rejected_hashes() -> set[str]:
    """Hashes in the log. A missing file gives an empty set. Bad lines are skipped."""
    hashes: set[str] = set()
    try:
        text = reject_log_path().read_text(encoding="utf-8", errors="replace")
    except OSError:
        return hashes
    for line in text.splitlines():
        try:
            value = json.loads(line).get("hash")
        except (ValueError, AttributeError):
            continue
        if isinstance(value, str) and value:
            hashes.add(value)
    return hashes
