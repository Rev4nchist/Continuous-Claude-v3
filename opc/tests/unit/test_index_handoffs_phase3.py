"""index_handoffs.build_entries: redaction, provenance and schema check. No database.

Ways it can fail, one test each:
1. A key in a handoff field reaches the entry content, or redaction touches the
   dedup key (handoff_path, handoff_field).
2. The metadata lacks source, session_id (equal to the column), handoff_session or
   is_inference, or the front-matter session overrides the column id.
3. An entry the schema rejects is kept, or not counted and logged by hash.
4. A field over 4000 chars is dropped instead of cut.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

import index_handoffs as ih  # noqa: E402
import memory_reject_log as rl  # noqa: E402
from db.memory_provenance import prepare_write  # noqa: E402

from tests.unit import fake_secrets as fs  # noqa: E402

KEY = fs.anthropic_key()


def _handoff(tmp_path: Path, goal: str, session: str | None = "front-session") -> Path:
    path = tmp_path / "handoff-abc.yaml"
    head = f"session: {session}\n" if session else ""
    path.write_text(
        head + "goal: " + json.dumps(goal) + "\noutcome: SUCCEEDED\n", encoding="utf-8"
    )
    return path


def _build(tmp_path: Path, goal: str, **kw):
    path = _handoff(tmp_path, goal, **kw)
    parsed = ih.parse_handoff_file(path)
    return ih.build_entries(path, parsed, tmp_path)


def test_key_is_redacted_and_the_dedup_key_is_unchanged(tmp_path):
    (entry,) = _build(tmp_path, "Fixed the deploy: export " + KEY + " before the build step.")
    assert "[REDACTED:provider_token]" in entry["content"] and "aaaa" not in entry["content"]
    assert entry["content"].startswith("Goal: ")
    md = entry["metadata"]
    assert md["handoff_field"] == "goal" and md["handoff_path"].endswith("handoff-abc.yaml")
    assert md["redacted_kinds"] == ["provider_token"]
    assert "aaaa" not in json.dumps(entry)
    # The store() backstop must find nothing: a late hit means the embedding saw the secret.
    _content, backstop_md, _sid = prepare_write(entry["content"], md, entry["session_id"])
    assert "redacted_late" not in backstop_md


def test_provenance_fields(tmp_path):
    (entry,) = _build(tmp_path, "Ship the provenance work for the memory store this week.")
    md = entry["metadata"]
    assert md["source"] == "handoff" and md["is_inference"] is False
    assert md["session_id"] == "handoff-abc" == entry["session_id"]
    assert md["handoff_session"] == "front-session"
    assert "redacted_kinds" not in md


def test_no_front_matter_session_means_no_handoff_session(tmp_path):
    (entry,) = _build(tmp_path, "Ship the provenance work for the memory store.", session=None)
    assert "handoff_session" not in entry["metadata"]
    assert entry["metadata"]["session_id"] == "handoff-abc"


def test_schema_reject_is_dropped_counted_and_logged(tmp_path, monkeypatch):
    monkeypatch.setattr(ih, "validate_candidate", lambda data: (None, ["schema:content:bad"]))
    path = _handoff(tmp_path, "Ship the provenance work for the memory store.")
    rejects: list[dict] = []
    entries = ih.build_entries(path, ih.parse_handoff_file(path), tmp_path, rejects=rejects)
    assert entries == [] and len(rejects) == 1
    lines = [json.loads(x) for x in rl.reject_log_path().read_text(encoding="utf-8").splitlines()]
    assert lines[0]["stage"] == "schema" and lines[0]["source"] == "handoff"
    raw = "Goal: Ship the provenance work for the memory store."
    assert lines[0]["hash"] == rl.content_hash(raw)


def test_a_field_over_4000_chars_is_cut_not_dropped(tmp_path):
    (entry,) = _build(tmp_path, "Decision text. " * 600)
    assert 0 < len(entry["content"]) <= 4000
