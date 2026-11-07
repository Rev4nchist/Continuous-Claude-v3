"""B9: incremental_extract keeps its state file per session and writes it atomically.

The state file is shared by every session in a project. `last_extracted_line` is a line
index into ONE transcript, so it is stored per session. The TS hook
(.claude/hooks/src/shared/extraction-state.ts) reads and stamps the same file under a lock.

Failure modes, one test each:
1. A save by session B erases session A's entry or the hook's `last_launched` stamp.
2. Session B loads session A's line.
3. The old flat shape does not load, or loads for the wrong session.
4. The save truncates the destination first, so a reader sees an empty file.
5. A temp or lock file stays behind.
6. A stale lock blocks every later save.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

import incremental_extract as ie  # noqa: E402

A = "aaaaaaaa-1111"
B = "bbbbbbbb-2222"


def _state(session_id: str, line: int, hashes: list[str] | None = None) -> ie.ExtractionState:
    return ie.ExtractionState(
        session_id=session_id,
        last_extracted_line=line,
        recent_hashes=hashes or [],
        last_extraction_time="2026-11-07T00:00:00+00:00",
    )


def _read(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_save_keeps_other_sessions_and_the_launch_stamp(tmp_path):
    f = tmp_path / ".claude" / "extraction-state.json"
    f.parent.mkdir()
    f.write_text(json.dumps({
        "version": 2,
        "recent_hashes": ["h1"],
        "sessions": {
            A: {"last_extracted_line": 120, "last_launched": 5},
            B: {"last_launched": 9},
        },
    }))
    ie.save_state(str(f), _state(B, 7, ["h1", "h2"]))
    data = _read(f)
    assert data["sessions"][A] == {"last_extracted_line": 120, "last_launched": 5}
    assert data["sessions"][B]["last_extracted_line"] == 7
    assert data["sessions"][B]["last_launched"] == 9
    assert data["recent_hashes"] == ["h1", "h2"]


def test_second_session_loads_line_zero_and_round_trip_works(tmp_path):
    f = tmp_path / "state.json"
    ie.save_state(str(f), _state(A, 120))
    assert ie.load_state(str(f), A)["last_extracted_line"] == 120
    assert ie.load_state(str(f), B)["last_extracted_line"] == 0


def test_old_flat_shape_loads_for_the_session_it_names_only(tmp_path):
    f = tmp_path / "state.json"
    f.write_text(json.dumps({
        "session_id": A, "last_extracted_line": 40,
        "recent_hashes": ["h1"], "last_extraction_time": "x",
    }))
    assert ie.load_state(str(f), A)["last_extracted_line"] == 40
    assert ie.load_state(str(f), B)["last_extracted_line"] == 0
    assert ie.load_state(str(f), B)["recent_hashes"] == ["h1"]


def test_saving_over_the_old_flat_shape_migrates_it(tmp_path):
    f = tmp_path / "state.json"
    f.write_text(json.dumps({"session_id": A, "last_extracted_line": 40, "recent_hashes": ["h1"]}))
    ie.save_state(str(f), _state(B, 3, ["h1"]))
    data = _read(f)
    assert data["sessions"][A]["last_extracted_line"] == 40
    assert data["sessions"][B]["last_extracted_line"] == 3


def test_missing_empty_and_corrupt_files_load_as_line_zero(tmp_path):
    assert ie.load_state(str(tmp_path / "nope.json"), A)["last_extracted_line"] == 0
    f = tmp_path / "state.json"
    f.write_text("")
    assert ie.load_state(str(f), A)["last_extracted_line"] == 0
    f.write_text("{not json")
    assert ie.load_state(str(f), A)["last_extracted_line"] == 0


def test_the_destination_is_never_empty_while_a_save_is_in_flight(tmp_path, monkeypatch):
    f = tmp_path / "state.json"
    ie.save_state(str(f), _state(A, 120))
    before = f.read_text(encoding="utf-8")
    seen: list[str] = []
    real_replace = os.replace

    def spy(src, dst):
        seen.append(Path(dst).read_text(encoding="utf-8"))  # what a reader sees right now
        real_replace(src, dst)

    monkeypatch.setattr(ie.os, "replace", spy)
    ie.save_state(str(f), _state(B, 7))
    assert seen == [before]


def test_no_temp_or_lock_file_is_left_behind(tmp_path):
    f = tmp_path / "state.json"
    ie.save_state(str(f), _state(A, 1))
    assert sorted(p.name for p in tmp_path.iterdir()) == ["state.json"]


def test_a_stale_lock_does_not_block_the_save(tmp_path):
    f = tmp_path / "state.json"
    lock = tmp_path / "state.json.lock"
    lock.write_text("1\n0")
    old = time.time() - 60
    os.utime(lock, (old, old))
    ie.save_state(str(f), _state(A, 5))
    assert _read(f)["sessions"][A]["last_extracted_line"] == 5
    assert not lock.exists()


def test_a_stale_lock_that_cannot_be_deleted_times_out_instead_of_spinning(tmp_path, monkeypatch):
    lock = tmp_path / "state.json.lock"
    lock.write_text("1\n0")
    old = time.time() - 60
    os.utime(lock, (old, old))
    monkeypatch.setattr(ie, "_LOCK_TIMEOUT_S", 0.2)
    calls = {"n": 0}

    def locked_unlink(path, *a, **kw):
        calls["n"] += 1
        if calls["n"] > 1000:  # a spin loop: end the test with a clear failure
            raise RuntimeError("spun on a stale lock that cannot be deleted")
        raise PermissionError(13, "held by another process")

    monkeypatch.setattr(ie.os, "unlink", locked_unlink)
    assert ie._acquire_lock(str(lock)) is False
    assert calls["n"] < 100


def test_a_lock_that_vanishes_between_stat_and_unlink_is_retaken(tmp_path, monkeypatch):
    lock = tmp_path / "state.json.lock"
    lock.write_text("1\n0")
    old = time.time() - 60
    os.utime(lock, (old, old))
    real_unlink = os.unlink

    def racing_unlink(path, *a, **kw):
        real_unlink(path)  # another process removed it first
        real_unlink(path)  # so this raises FileNotFoundError

    monkeypatch.setattr(ie.os, "unlink", racing_unlink)
    assert ie._acquire_lock(str(lock)) is True
    real_unlink(str(lock))


def test_a_save_merges_hashes_another_session_saved_in_the_meantime(tmp_path):
    f = tmp_path / "state.json"
    # Session B loaded its snapshot (no hashes), then A saved, then B saves.
    ie.save_state(str(f), _state(A, 10, ["hA1", "hA2"]))
    ie.save_state(str(f), _state(B, 5, ["hB1"]))
    assert _read(f)["recent_hashes"] == ["hA1", "hA2", "hB1"]


def test_merged_hashes_have_no_duplicates_and_are_capped_at_100_newest(tmp_path):
    f = tmp_path / "state.json"
    ie.save_state(str(f), _state(A, 1, [f"h{i}" for i in range(90)]))
    ie.save_state(str(f), _state(B, 1, ["h50"] + [f"n{i}" for i in range(30)]))
    hashes = _read(f)["recent_hashes"]
    assert len(hashes) == 100
    assert hashes.count("h50") == 1
    assert hashes[-1] == "n29"


def test_sessions_are_pruned_to_the_cap_and_the_saving_session_stays(tmp_path):
    f = tmp_path / "state.json"
    sessions = {
        f"s{i}": {"last_extraction_time": f"2026-01-01T00:00:{i:02d}+00:00"}
        for i in range(ie._STATE_MAX_SESSIONS + 5)
    }
    f.write_text(json.dumps({"version": 2, "recent_hashes": [], "sessions": sessions}))
    ie.save_state(str(f), _state("s0", 9))
    kept = _read(f)["sessions"]
    assert len(kept) == ie._STATE_MAX_SESSIONS
    assert kept["s0"]["last_extracted_line"] == 9
