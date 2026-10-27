"""Extractor output schema.

Ways it can fail, one test each:
1. A valid candidate is rejected (schema too strict).
2. Empty content, or content over 4000 chars after strip, passes.
3. An unknown learning_type or source passes.
4. A non-bool is_inference passes (strict mode removed).
5. An unknown field passes (extra=forbid removed).
6. A bad evidence block passes.
7. The reason code loses its "schema:<field>:<type>" shape.
8. Content is not stripped before the length check.
9. LEARNING_TYPES is not the one list store_learning uses.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

import memory_candidate as mc  # noqa: E402


def _ok(**over):
    data = {
        "content": "Use a lock file so two syncs never run at once.",
        "learning_type": "WORKING_SOLUTION",
        "source": "hook",
        "is_inference": False,
        "session_id": "s1",
    }
    data.update(over)
    return data


def test_valid_candidate_passes_with_no_reasons():
    cand, reasons = mc.validate_candidate(_ok(tags=["a", "b"], confidence="high"))
    assert reasons == [] and cand is not None
    assert cand.content.startswith("Use a lock")


def test_valid_candidate_with_evidence_passes():
    ev = {"kind": "thinking_block", "line": 7, "hash": "0123456789abcdef"}
    cand, reasons = mc.validate_candidate(_ok(evidence=ev))
    assert reasons == [] and cand.evidence.line == 7


@pytest.mark.parametrize(
    ("over", "field", "etype"),
    [
        ({"content": ""}, "content", "string_too_short"),
        ({"content": "x" * 4001}, "content", "string_too_long"),
        ({"learning_type": "NOT_A_TYPE"}, "learning_type", "literal_error"),
        ({"source": "bogus"}, "source", "literal_error"),
        ({"is_inference": "true"}, "is_inference", "bool_type"),
        ({"session_id": ""}, "session_id", "string_too_short"),
        ({"confidence": "certain"}, "confidence", "literal_error"),
        ({"extra_field": 1}, "extra_field", "extra_forbidden"),
        ({"tags": ["x"] * 31}, "tags", "too_long"),
    ],
)
def test_invalid_candidate_gets_a_schema_reason(over, field, etype):
    cand, reasons = mc.validate_candidate(_ok(**over))
    assert cand is None
    assert f"schema:{field}:{etype}" in reasons


def test_bad_evidence_is_rejected():
    cand, reasons = mc.validate_candidate(
        _ok(evidence={"kind": "thinking_block", "line": -1, "hash": "nothex"})
    )
    assert cand is None
    assert any(r.startswith("schema:evidence.") for r in reasons)


def test_missing_required_field_is_reported():
    data = _ok()
    del data["source"]
    cand, reasons = mc.validate_candidate(data)
    assert cand is None and "schema:source:missing" in reasons


def test_content_is_stripped_before_the_length_check():
    cand, reasons = mc.validate_candidate(_ok(content="   \n  "))
    assert cand is None and "schema:content:string_too_short" in reasons
    cand, reasons = mc.validate_candidate(_ok(content="  " + "y" * 3990 + "  "))
    assert reasons == [] and len(cand.content) == 3990


def test_one_learning_type_list_is_shared_with_store_learning():
    import store_learning

    assert store_learning.LEARNING_TYPES is mc.LEARNING_TYPES
    assert len(mc.LEARNING_TYPES) == 7
