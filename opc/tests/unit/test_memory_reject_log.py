"""Rejected-candidate hash log.

Ways it can fail, one test each:
1. The env override is ignored, so tests write to the real state dir.
2. A line holds the candidate content instead of only its hash.
3. The file is created world-readable (POSIX only).
4. Rotation keeps the oldest lines, or never runs.
5. An unwritable path raises into a store.
6. load_rejected_hashes dies on a corrupt line, or on a missing file.
7. content_hash changes (it must stay the existing sha256[:16] of normalized text).
8. incremental_extract no longer re-exports content_hash.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

import memory_reject_log as rl  # noqa: E402


def _lines(path: Path) -> list[dict]:
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines()]


def test_env_override_path_is_used(monkeypatch, tmp_path):
    target = tmp_path / "custom.jsonl"
    monkeypatch.setenv("CCV3_MEMORY_REJECT_LOG", str(target))
    assert rl.reject_log_path() == target
    rl.record_reject("0123456789abcdef", "gate_b_noise", "NOISE score=2", "hook", "s1")
    assert target.exists()


def test_default_path_is_under_state_dir(monkeypatch, tmp_path):
    monkeypatch.delenv("CCV3_MEMORY_REJECT_LOG", raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    assert rl.reject_log_path() == (
        tmp_path / ".claude" / "state" / "memory-rejected-candidates.jsonl"
    )


def test_line_has_the_hash_and_no_content(tmp_path):
    path = rl.reject_log_path()
    rl.record_reject("0123456789abcdef", "gate_a", "too_short (5<30)", "hook", "sess-1")
    (row,) = _lines(path)
    assert row["hash"] == "0123456789abcdef"
    assert row["hash_basis"] == "raw-normalized-sha256-16"
    assert row["stage"] == "gate_a" and row["session_id"] == "sess-1"
    assert row["source"] == "hook" and row["reason"].startswith("too_short")
    assert "content" not in row and "ts" in row


@pytest.mark.skipif(sys.platform == "win32", reason="Windows does not enforce mode bits")
def test_file_is_owner_only(tmp_path):
    path = rl.reject_log_path()
    rl.record_reject("0123456789abcdef", "gate_a", "r", "hook", "s")
    assert (os.stat(path).st_mode & 0o777) == 0o600


def test_rotation_keeps_the_newest_lines(monkeypatch):
    monkeypatch.setattr(rl, "MAX_LINES", 20)
    monkeypatch.setattr(rl, "KEEP_LINES", 10)
    monkeypatch.setattr(rl, "CHECK_BYTES", 0)
    path = rl.reject_log_path()
    for i in range(21):
        rl.record_reject(f"{i:016x}", "gate_a", "r", "hook", "s")
    rows = _lines(path)
    assert len(rows) == 10
    assert rows[0]["hash"] == f"{11:016x}" and rows[-1]["hash"] == f"{20:016x}"


def test_unwritable_path_never_raises(monkeypatch, tmp_path):
    blocker = tmp_path / "blocker"
    blocker.write_text("a file where a folder should be", encoding="utf-8")
    monkeypatch.setenv("CCV3_MEMORY_REJECT_LOG", str(blocker / "sub" / "log.jsonl"))
    rl.record_reject("0123456789abcdef", "gate_a", "r", "hook", "s")  # must not raise


def test_load_skips_corrupt_lines_and_missing_file(monkeypatch, tmp_path):
    assert rl.load_rejected_hashes() == set()  # no file yet
    path = rl.reject_log_path()
    good = {"hash": "aaaaaaaaaaaaaaaa", "stage": "gate_a"}
    path.write_text(
        json.dumps(good) + "\n{not json\n\n" + json.dumps({"no_hash": 1}) + "\n"
        + json.dumps({"hash": "bbbbbbbbbbbbbbbb"}) + "\n",
        encoding="utf-8",
    )
    assert rl.load_rejected_hashes() == {"aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"}


def test_content_hash_is_the_existing_normalized_sha256_16():
    assert rl.content_hash("  Hello   WORLD\n") == rl.content_hash("hello world")
    assert len(rl.content_hash("x")) == 16
    import hashlib

    assert rl.content_hash("hello world") == hashlib.sha256(b"hello world").hexdigest()[:16]


def test_incremental_extract_reexports_content_hash():
    import incremental_extract

    assert incremental_extract.content_hash is rl.content_hash
