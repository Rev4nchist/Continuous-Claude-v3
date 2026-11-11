"""incremental_extract: a store that fails on a connection error must not lose the learning.

store_learning_v2 is replaced. A DB outage does not raise: it returns
{"success": False, "error": ...}. A temp transcript and a temp state file drive each run.

Ways it can fail, one test each:
a. One of three stores fails on a connection error, and the pointer or its hash still advances.
b. All three fail, and the state keeps a pointer past the first one or any hash.
c. A raised ConnectionError is treated as permanent.
d. A permanent error ("No content provided") holds the pointer back (control: it must advance).
e. All stores succeed and the pointer or hashes change from today (control).
f. A re-run after the DB returns stores the held-back candidate again, or stores the
   others a second time.
g. The real store_learning_v2 turns an asyncio.TimeoutError (empty text) into an empty
   error string, so the store timeout reads as permanent.
h. Through extract_incremental with the real store_learning_v2, that timeout still
   advances the pointer and saves the hash.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

import incremental_extract as ie  # noqa: E402
import memory_reject_log as rl  # noqa: E402
import store_learning  # noqa: E402

SESSION = "sess-1"
TEXTS = [
    f"I now realize that the root cause was a missing index on session_id in the "
    f"{name} migration file, and the fix is to add the index before the backfill runs."
    for name in ("users", "orders", "events")
]
HASHES = [rl.content_hash(t) for t in TEXTS]
# Line 1 is blank, so the candidates sit on lines 0, 2 and 3.
LINES = [0, 2, 3]
CONN_ERROR = "connection refused: could not connect to server"


def _thinking_line(text: str) -> str:
    msg = {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": text}]}}
    return json.dumps(msg)


def _transcript(tmp_path: Path) -> str:
    rows = [_thinking_line(TEXTS[0]), "", _thinking_line(TEXTS[1]), _thinking_line(TEXTS[2])]
    path = tmp_path / "t.jsonl"
    path.write_text("\n".join(rows) + "\n", encoding="utf-8")
    return str(path)


class FakeStore:
    """Stands in for store_learning_v2. `failing` maps a candidate hash to a failure mode."""

    def __init__(self) -> None:
        self.failing: dict[str, str] = {}
        self.stored: list[str] = []

    async def __call__(self, **kwargs):
        h = kwargs["candidate_hash"]
        mode = self.failing.get(h)
        if mode == "raise":
            raise ConnectionError(CONN_ERROR)
        if mode == "connection":
            return {"success": False, "error": CONN_ERROR}
        if mode == "permanent":
            return {"success": False, "error": "No content provided"}
        self.stored.append(h)
        return {"success": True, "memory_id": "m1"}


@pytest.fixture
def db(monkeypatch):
    monkeypatch.setenv("CCV3_DISTILL", "0")
    fake = FakeStore()
    monkeypatch.setattr(store_learning, "store_learning_v2", fake)
    return fake


async def _run(tmp_path: Path, state_file: Path, start_line: int = 0):
    return await ie.extract_incremental(
        _transcript(tmp_path), SESSION, start_line=start_line, state_file=str(state_file)
    )


def _saved(state_file: Path) -> ie.ExtractionState:
    return ie.load_state(str(state_file), SESSION)


async def test_a_one_connection_failure_holds_back_its_line_and_hash(tmp_path, db):
    state_file = tmp_path / "state.json"
    db.failing[HASHES[1]] = "connection"
    result = await _run(tmp_path, state_file)
    saved = _saved(state_file)
    assert saved["last_extracted_line"] == LINES[1]
    assert result["new_last_line"] == LINES[1]
    assert HASHES[1] not in saved["recent_hashes"] and HASHES[1] not in result["hashes"]
    assert HASHES[0] in saved["recent_hashes"] and HASHES[2] in saved["recent_hashes"]
    assert any("held back at line 2" in e for e in result["errors"])


async def test_b_all_connection_failures_hold_back_the_first_line_and_save_no_hash(tmp_path, db):
    state_file = tmp_path / "state.json"
    db.failing = {h: "connection" for h in HASHES}
    result = await _run(tmp_path, state_file)
    saved = _saved(state_file)
    assert saved["last_extracted_line"] == LINES[0]
    assert result["new_last_line"] == LINES[0]
    assert saved["recent_hashes"] == [] and result["hashes"] == []


async def test_c_raised_connection_error_is_held_back_like_a_returned_one(tmp_path, db):
    state_file = tmp_path / "state.json"
    db.failing[HASHES[1]] = "raise"
    result = await _run(tmp_path, state_file)
    saved = _saved(state_file)
    assert saved["last_extracted_line"] == LINES[1]
    assert HASHES[1] not in saved["recent_hashes"]
    assert HASHES[0] in saved["recent_hashes"] and HASHES[2] in saved["recent_hashes"]
    assert result["new_last_line"] == LINES[1]


async def test_d_permanent_error_still_advances_pointer_and_hash(tmp_path, db):
    state_file = tmp_path / "state.json"
    db.failing[HASHES[1]] = "permanent"
    result = await _run(tmp_path, state_file)
    saved = _saved(state_file)
    assert saved["last_extracted_line"] == 4
    assert set(saved["recent_hashes"]) == set(HASHES)
    assert "No content provided" in result["errors"]


async def test_e_all_success_advances_pointer_and_saves_every_hash(tmp_path, db):
    state_file = tmp_path / "state.json"
    result = await _run(tmp_path, state_file)
    saved = _saved(state_file)
    assert saved["last_extracted_line"] == 4
    assert set(saved["recent_hashes"]) == set(HASHES)
    assert result["learnings_stored"] == 3 and result["errors"] == []


async def test_f_rerun_after_db_returns_stores_only_the_held_back_candidate(tmp_path, db):
    state_file = tmp_path / "state.json"
    db.failing[HASHES[1]] = "connection"
    await _run(tmp_path, state_file)
    assert db.stored == [HASHES[0], HASHES[2]]

    db.failing.clear()
    result = await _run(tmp_path, state_file, start_line=_saved(state_file)["last_extracted_line"])
    assert db.stored == [HASHES[0], HASHES[2], HASHES[1]]
    assert result["learnings_stored"] == 1 and result["learnings_deduped"] == 1
    assert _saved(state_file)["last_extracted_line"] == 4
    assert set(_saved(state_file)["recent_hashes"]) == set(HASHES)


@pytest.fixture
def real_store_times_out(monkeypatch):
    """The real store_learning_v2 runs; the memory service times out with empty error text."""
    import db.memory_factory as factory

    async def timing_out(**kwargs):
        raise asyncio.TimeoutError()

    assert str(asyncio.TimeoutError()) == ""
    monkeypatch.setenv("CCV3_DISTILL", "0")
    monkeypatch.setattr(factory, "create_memory_service", timing_out)


async def test_g_real_store_names_the_exception_when_its_text_is_empty(real_store_times_out):
    result = await store_learning.store_learning_v2(
        session_id=SESSION, content=TEXTS[0], source="hook", candidate_hash=HASHES[0]
    )
    assert result["success"] is False
    assert result["error"] != ""
    assert ie._is_connection_error(result["error"])


async def test_h_real_store_timeout_is_held_back_through_extract_incremental(
    tmp_path, real_store_times_out
):
    state_file = tmp_path / "state.json"
    result = await _run(tmp_path, state_file)
    saved = _saved(state_file)
    assert result["learnings_stored"] == 0
    assert saved["last_extracted_line"] == LINES[0]
    assert saved["recent_hashes"] == [] and result["hashes"] == []
