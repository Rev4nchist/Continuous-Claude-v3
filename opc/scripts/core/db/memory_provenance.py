"""Provenance contract for every new archival_memory row.

Fields (all in the metadata JSONB, no new column):
- source: one of hook, manual, handoff, llm. A missing or other value raises ValueError.
- session_id: the row's session id. Empty or "default" becomes SENTINEL_UNKNOWN.
  The metadata value always equals the column value.
- is_inference: bool. Missing means False. A non-bool raises ValueError.
- provenance_v: 1. A later SQL check can count compliant rows.
- redacted_kinds / redacted_late: set by prepare_write when the backstop found a secret.

Sentinels:
- SENTINEL_CLI ("cli-manual"): store_learning.py CLI with no --session-id and no
  CLAUDE_SESSION_ID env var.
- SENTINEL_UNKNOWN ("unknown-session"): the effective session id is empty or "default"
  (the MemoryServicePG default).

Exempt writers (they restore or probe, they do not create learnings):
- memory_backup.py restore INSERT: it restores rows exactly as backed up.
- scripts/system-coherence-stress.mjs: it writes test canary rows.

This module imports no database code.
"""

from __future__ import annotations

from typing import Any

try:  # package import (memory_service_pg) and top-level import (core scripts)
    from .memory_redact import redact, redact_obj
except ImportError:  # pragma: no cover - imported as a top-level module
    from db.memory_redact import redact, redact_obj  # type: ignore[no-redef]

SOURCES = ("hook", "manual", "handoff", "llm")
SENTINEL_CLI = "cli-manual"
SENTINEL_UNKNOWN = "unknown-session"
PROVENANCE_VERSION = 1


def _usable_session(value: object) -> bool:
    return isinstance(value, str) and value.strip() not in ("", "default")


def ensure_provenance(
    metadata: dict[str, Any] | None, row_session_id: str | None
) -> tuple[dict[str, Any], str]:
    """Return ``(metadata, session_id)`` with provenance filled. Raises ValueError.

    ``session_id`` is the value for the row column. ``metadata["session_id"]`` equals it.
    The input metadata is not changed.
    """
    md = dict(metadata or {})
    source = md.get("source")
    if not isinstance(source, str) or source not in SOURCES:
        raise ValueError(f"metadata.source must be one of {list(SOURCES)}, got {source!r}")

    is_inference = md.get("is_inference", False)
    if not isinstance(is_inference, bool):
        raise ValueError(f"metadata.is_inference must be a bool, got {type(is_inference).__name__}")

    if _usable_session(row_session_id):
        session_id = str(row_session_id)
    elif _usable_session(md.get("session_id")):
        session_id = md["session_id"]
    else:
        session_id = SENTINEL_UNKNOWN

    md["is_inference"] = is_inference
    md["session_id"] = session_id
    md["provenance_v"] = PROVENANCE_VERSION
    return md, session_id


def flag_late_redaction(metadata: dict[str, Any], kinds: Any) -> dict[str, Any]:
    """Record a backstop hit: redacted_late is true and redacted_kinds gains the kinds."""
    md = dict(metadata)
    md["redacted_late"] = True
    md["redacted_kinds"] = sorted(set(md.get("redacted_kinds", [])) | set(kinds))
    return md


def prepare_write(
    content: str, metadata: dict[str, Any] | None, row_session_id: str | None
) -> tuple[str, dict[str, Any], str]:
    """Redaction backstop plus provenance. Used by every raw writer.

    Callers redact before they embed. A hit here is late: the embedding already saw
    the secret. It is flagged with ``redacted_late`` so a test can keep late hits at zero.
    """
    result = redact(content)
    clean_md, md_hits = redact_obj(dict(metadata or {}))
    md, session_id = ensure_provenance(clean_md, row_session_id)
    kinds = sorted(set(result.hits) | set(md_hits))
    if kinds:
        md = flag_late_redaction(md, kinds)
    return result.text, md, session_id
