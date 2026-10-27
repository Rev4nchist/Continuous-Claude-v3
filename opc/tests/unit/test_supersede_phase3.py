"""supersede.build_successor: the successor row carries provenance and no secret.

The function is pure, so no database is needed.

Ways it can fail, one test each:
1. The successor lacks source "manual", supersedes_source, or the inherited session id.
2. new_content or the reason keeps a key.
3. A later prepare_write finds the successor still holds a secret (late hit).
4. A missing old source is recorded as a value instead of left out.
"""
from __future__ import annotations

import sys
from datetime import UTC, datetime
from pathlib import Path

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

import supersede  # noqa: E402
from db.memory_provenance import prepare_write  # noqa: E402

from tests.unit import fake_secrets as fs  # noqa: E402

NOW = datetime(2026, 10, 27, tzinfo=UTC)
OLD = "11111111-2222-3333-4444-555555555555"


def _build(new_content="Use the lock file.", reason=None, old_meta=None, old_session="col-session"):
    return supersede.build_successor(
        old_id=OLD,
        old_meta=old_meta
        if old_meta is not None
        else {"source": "hook", "session_id": "meta-session"},
        old_session_id=old_session,
        new_content=new_content,
        reason=reason,
        learning_type="WORKING_SOLUTION",
        now=NOW,
    )


def test_successor_has_manual_source_and_inherited_session():
    content, md, session = _build()
    assert md["source"] == "manual" and md["is_inference"] is False
    assert md["supersedes"] == OLD and md["supersedes_source"] == "hook"
    assert md["session_id"] == "meta-session" == session
    assert content == "Use the lock file."


def test_session_falls_back_to_the_old_column():
    _, md, session = _build(old_meta={"source": "manual"})
    assert session == "col-session" and md["session_id"] == "col-session"


def test_content_and_reason_are_redacted():
    content, md, _ = _build(
        "Rotate " + fs.anthropic_key(), reason="leaked via " + fs.github_token()
    )
    assert "aaaa" not in content and "[REDACTED:provider_token]" in content
    assert "bbbb" not in md["supersede_reason"]
    assert md["redacted_kinds"] == ["provider_token"]


def test_prepare_write_finds_nothing_left_to_redact():
    content, md, session = _build("Rotate " + fs.anthropic_key(), reason="r " + fs.github_token())
    _, final_md, _ = prepare_write(content, md, session)
    assert "redacted_late" not in final_md


def test_old_row_without_a_source_records_none():
    _, md, _ = _build(old_meta={})
    assert "supersedes_source" not in md


def test_inherited_fields_from_a_pre_phase3_row_are_redacted_without_a_late_flag():
    """Breaks if tags/context are copied raw: prepare_write would then flag a false late hit."""
    old_meta = {
        "source": "manual",
        "tags": ["ok-tag", fs.github_token()],
        "context": "seen with " + fs.anthropic_key(),
        "confidence": "high",
    }
    content, md, session = _build(old_meta=old_meta)
    assert md["tags"][0] == "ok-tag" and "bbbb" not in md["tags"][1]
    assert "aaaa" not in md["context"] and md["confidence"] == "high"
    assert md["redacted_kinds"] == ["provider_token"]
    _, final_md, _ = prepare_write(content, md, session)
    assert "redacted_late" not in final_md
