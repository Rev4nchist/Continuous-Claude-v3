"""Tests for lazy_memory.py - Phase 1 of CCv3 Memory Remediation Plan.

These tests verify that L2 (session-end) extraction actually persists learnings
to PostgreSQL instead of silently dropping them. Prior to the fix, an ImportError
caused both `store_learning` and `LearningType` to be set to None, and the
"if store and store_learning and learnings" guard skipped the storage call.

Tests cover:
1. Module import is sound -- no silent None degradation
2. Empty input returns [] cleanly without crashing
3. Loud failure propagation when storage backend is unreachable
4. Happy-path end-to-end: extraction -> embed -> persist to postgres -> readable
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import uuid
from pathlib import Path
from unittest import mock

import pytest

# Ensure scripts/core is importable as a package via PYTHONPATH=opc
_CORE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_CORE_DIR))

import lazy_memory  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def fake_session_jsonl(tmp_path):
    """Build a small JSONL fixture with assistant thinking blocks.

    The blocks contain perception signals (e.g. "actually", "turns out") so
    they pass extract_thinking_blocks's filter, plus enough length and a
    quality signal so they pass validate_learning_quality in store_learning_v2.
    """
    jsonl_path = tmp_path / "fake_session.jsonl"
    insight_text = (
        "Turns out the bug was caused by a stale ImportError handler that "
        "silently swallowed failures, so nothing was actually being persisted. "
        "The fix was to call store_learning_v2 directly instead of the v1 "
        "entrypoint, because v1's signature didn't match the call site. "
        "This pattern works because v2 accepts learning_type as a string and "
        "performs its own quality gating before invoking the embedding model."
    )

    lines = []
    # 12 user/assistant pairs so should_extract(min_turns=10) is True
    for i in range(12):
        lines.append(json.dumps({"type": "user", "message": {"content": f"msg {i}"}}))
        # Only some assistant turns carry thinking content
        thinking_blocks = []
        if i in (3, 7):
            thinking_blocks.append({"type": "thinking", "thinking": insight_text})
        lines.append(
            json.dumps(
                {
                    "type": "assistant",
                    "timestamp": f"2026-04-27T12:00:{i:02d}Z",
                    "message": {"content": thinking_blocks or [{"type": "text", "text": "ok"}]},
                }
            )
        )

    jsonl_path.write_text("\n".join(lines), encoding="utf-8")
    return jsonl_path


@pytest.fixture
def canary_session_id():
    """Unique session id per test run, prefixed so we can clean up."""
    return f"phase1-test-{uuid.uuid4().hex[:8]}"


@pytest.fixture
def cleanup_db(canary_session_id):
    """Best-effort delete of any rows created with the canary session_id.

    Runs after the test even if it fails. Tolerant of missing DB.
    """
    yield
    try:
        import asyncpg  # type: ignore

        url = os.environ.get("DATABASE_URL")
        if not url:
            return

        async def _delete():
            conn = await asyncpg.connect(url)
            try:
                await conn.execute(
                    "DELETE FROM archival_memory WHERE session_id = $1",
                    canary_session_id,
                )
            finally:
                await conn.close()

        asyncio.run(_delete())
    except Exception:
        # Cleanup is best-effort; never fail the test on cleanup
        pass


# ---------------------------------------------------------------------------
# 1. Import soundness
# ---------------------------------------------------------------------------


def test_import_is_sound_store_learning_callable():
    """After the fix, lazy_memory must expose a callable storage path.

    The pre-fix bug masked an ImportError and set store_learning = None,
    so this assertion would catch any regression that re-introduces silent
    degradation.
    """
    # The module must expose SOMETHING callable that lazy_memory uses to persist.
    # After the fix this is _store_learning_v2 (an async function),
    # but we accept either the v2 function or a wrapper, as long as it's callable.
    storer = getattr(lazy_memory, "_store_learning_v2", None) or getattr(
        lazy_memory, "store_learning", None
    )
    assert storer is not None, (
        "lazy_memory must expose a non-None storage callable. "
        "If this is None, the silent ImportError swallow has regressed."
    )
    assert callable(storer), "Storage entrypoint must be callable, not a sentinel"


def test_no_silent_learningtype_sentinel():
    """LearningType must not exist as a None sentinel. Either it's a real type
    or it's not in the namespace at all. A None sentinel is the regression we
    want to catch.
    """
    lt = getattr(lazy_memory, "LearningType", "ABSENT")
    # Either absent (preferred) or a real type/enum -- never literally None.
    assert lt is not None or lt == "ABSENT", (
        "LearningType is None -- this is the silent-failure sentinel pattern. "
        "Either define LearningType properly or remove it from imports."
    )


# ---------------------------------------------------------------------------
# 2. Empty input is a clean no-op
# ---------------------------------------------------------------------------


def test_extract_session_learnings_empty_returns_list(tmp_path, canary_session_id):
    """When find_session_jsonl can't locate a JSONL, return [] cleanly."""
    # project_dir points at an empty tmp_path -- nothing to find
    result = lazy_memory.extract_session_learnings(
        canary_session_id, str(tmp_path), store=False
    )
    assert result == []


def test_extract_session_learnings_no_thinking_blocks(
    tmp_path, canary_session_id, monkeypatch
):
    """JSONL exists but contains no perception-signal thinking blocks -> []."""
    # Write the JSONL into tmp_path (auto-cleaned by pytest) instead of real
    # Path.home() / .claude / projects / ..., then redirect the lookup so the
    # extractor finds it. Avoids polluting the developer's real home dir and
    # eliminates inter-test races on shared paths.
    jsonl = tmp_path / f"{canary_session_id}.jsonl"
    jsonl.write_text(
        json.dumps({"type": "assistant", "message": {"content": [{"type": "text", "text": "boring"}]}}) + "\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(
        lazy_memory, "find_session_jsonl", lambda sid, pd: jsonl
    )

    result = lazy_memory.extract_session_learnings(
        canary_session_id, str(tmp_path), store=False
    )
    assert result == []


# ---------------------------------------------------------------------------
# 3. Loud failure on storage error
# ---------------------------------------------------------------------------


def test_storage_failure_is_visible_not_silent(monkeypatch, fake_session_jsonl, canary_session_id):
    """When the storage call raises, lazy_memory must log to stderr.

    Pre-fix behavior was: store_learning=None, the storage branch was skipped,
    extraction returned a happy-looking list of learnings, and nothing ever
    reached postgres. This test guards against that regression: any exception
    from the storage backend MUST produce visible stderr output.
    """
    # Force find_session_jsonl to return our fixture
    monkeypatch.setattr(
        lazy_memory, "find_session_jsonl", lambda sid, pd: fake_session_jsonl
    )

    # Simulate an unreachable backend by patching the internal storer
    boom_calls = []

    async def boom(**kwargs):  # noqa: ANN001
        boom_calls.append(kwargs)
        raise RuntimeError("simulated DB outage")

    # We patch whichever symbol lazy_memory actually calls.
    target = "_store_learning_v2" if hasattr(lazy_memory, "_store_learning_v2") else "store_learning"
    monkeypatch.setattr(lazy_memory, target, boom)

    captured_stderr = []

    def fake_print(*args, **kwargs):
        if kwargs.get("file") is sys.stderr:
            captured_stderr.append(" ".join(str(a) for a in args))

    monkeypatch.setattr(lazy_memory, "print", fake_print, raising=False)

    # Should NOT raise (extractor should remain robust to per-learning failures),
    # but it MUST have attempted the call and emitted a stderr diagnostic.
    learnings = lazy_memory.extract_session_learnings(
        canary_session_id, str(fake_session_jsonl.parent), store=True
    )

    # Phase 3 provenance: regex extraction of reasoning on a hook trigger.
    assert boom_calls and boom_calls[0]["source"] == "hook"
    assert boom_calls[0]["is_inference"] is True

    assert len(boom_calls) >= 1, (
        "Storage call was never attempted -- silent skip regression detected"
    )
    assert any("simulated DB outage" in msg or "Failed to store" in msg for msg in captured_stderr), (
        f"Expected a visible stderr diagnostic, got: {captured_stderr!r}"
    )
    # The extractor still returns the in-memory learnings list (pre-store)
    assert isinstance(learnings, list)


# ---------------------------------------------------------------------------
# 4. Happy-path end-to-end with real postgres
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    not os.environ.get("DATABASE_URL"),
    reason="DATABASE_URL not set; skipping integration test",
)
def test_happy_path_persists_to_postgres(monkeypatch, fake_session_jsonl, canary_session_id, cleanup_db):
    """End-to-end: fixture -> extract -> embed -> insert into archival_memory.

    Verifies the row actually appears in postgres tagged with our canary
    session_id. cleanup_db fixture deletes it after the test.
    """
    monkeypatch.setattr(
        lazy_memory, "find_session_jsonl", lambda sid, pd: fake_session_jsonl
    )

    learnings = lazy_memory.extract_session_learnings(
        canary_session_id,
        str(fake_session_jsonl.parent),
        store=True,
        max_learnings=5,
    )

    assert len(learnings) >= 1, "Expected at least one learning extracted from fixture"

    # Now query postgres to confirm the row landed.
    import asyncpg  # type: ignore

    async def _count():
        conn = await asyncpg.connect(os.environ["DATABASE_URL"])
        try:
            row = await conn.fetchrow(
                "SELECT COUNT(*)::int AS n FROM archival_memory WHERE session_id = $1",
                canary_session_id,
            )
            return row["n"] if row else 0
        finally:
            await conn.close()

    n = asyncio.run(_count())
    assert n >= 1, (
        f"Expected >=1 archival_memory row for session {canary_session_id}, got {n}. "
        "L2 extraction is silently dropping learnings."
    )


# ---------------------------------------------------------------------------
# 5. CLI sanity (non-DB)
# ---------------------------------------------------------------------------


def test_should_extract_below_threshold(tmp_path, canary_session_id):
    """should_extract returns False when there is no JSONL at all."""
    assert lazy_memory.should_extract(canary_session_id, str(tmp_path), min_turns=10) is False
