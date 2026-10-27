"""Provenance contract on every new row.

Ways it can fail, one test each:
1. A missing source is filled with a default instead of raising.
2. A source outside {hook, manual, handoff, llm} is accepted.
3. An empty or "default" session id is stored as is, or metadata and column differ.
4. is_inference is coerced ("true" accepted) or missing is not False.
5. ensure_provenance overwrites caller values.
6. prepare_write skips the redaction backstop or the redacted_late flag.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

from db import memory_provenance as mp  # noqa: E402

from tests.unit import fake_secrets as fs  # noqa: E402


def test_missing_source_raises():
    with pytest.raises(ValueError, match="source"):
        mp.ensure_provenance({"is_inference": False}, "s1")
    with pytest.raises(ValueError, match="source"):
        mp.ensure_provenance(None, "s1")


@pytest.mark.parametrize("bad", ["bogus", "", "HOOK", None, 3])
def test_source_outside_the_enum_raises(bad):
    with pytest.raises(ValueError, match="source"):
        mp.ensure_provenance({"source": bad}, "s1")


@pytest.mark.parametrize("source", ["hook", "manual", "handoff", "llm"])
def test_every_enum_source_is_accepted(source):
    md, _ = mp.ensure_provenance({"source": source}, "s1")
    assert md["source"] == source


@pytest.mark.parametrize("sid", ["", "default", None, "  "])
def test_empty_session_becomes_the_sentinel_and_column_matches(sid):
    md, column = mp.ensure_provenance({"source": "hook"}, sid)
    assert column == mp.SENTINEL_UNKNOWN == "unknown-session"
    assert md["session_id"] == column


def test_metadata_session_id_fills_an_empty_column_id():
    md, column = mp.ensure_provenance({"source": "hook", "session_id": "from-meta"}, "default")
    assert column == "from-meta" and md["session_id"] == "from-meta"


def test_column_session_wins_so_both_always_match():
    md, column = mp.ensure_provenance({"source": "hook", "session_id": "other"}, "col")
    assert column == "col" and md["session_id"] == "col"


def test_is_inference_defaults_false_and_rejects_non_bool():
    md, _ = mp.ensure_provenance({"source": "manual"}, "s")
    assert md["is_inference"] is False
    for bad in ("true", 1, 0, "yes"):
        with pytest.raises(ValueError, match="is_inference"):
            mp.ensure_provenance({"source": "manual", "is_inference": bad}, "s")


def test_caller_values_stay_and_version_is_set():
    meta = {"source": "llm", "is_inference": True, "type": "session_learning"}
    md, column = mp.ensure_provenance(meta, "real-session")
    assert md["source"] == "llm" and md["is_inference"] is True
    assert md["type"] == "session_learning" and column == "real-session"
    assert md["provenance_v"] == 1
    assert "provenance_v" not in meta  # the input is not mutated


def test_prepare_write_redacts_and_flags_late_hits():
    content = "The build used " + fs.anthropic_key() + " during setup."
    meta = {"source": "manual", "context": "key " + fs.github_token()}
    new_content, md, column = mp.prepare_write(content, meta, "s1")
    assert "aaaa" not in new_content and "[REDACTED:provider_token]" in new_content
    assert "bbbb" not in md["context"]
    assert md["redacted_late"] is True
    assert md["redacted_kinds"] == ["provider_token"]
    assert column == "s1" and md["session_id"] == "s1"


def test_prepare_write_clean_content_sets_no_flags():
    new_content, md, _ = mp.prepare_write("nothing secret here at all", {"source": "hook"}, "s1")
    assert new_content == "nothing secret here at all"
    assert "redacted_late" not in md and "redacted_kinds" not in md
