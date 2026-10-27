"""A failed memory write leaves one masked line in the failure log.

Ways it can fail, one test each:
1. The log line keeps a database URL (password leak).
2. A long error is not cut to 300 characters.
3. The logger raises when the state folder cannot be written (a log must never break a store).
4. store_learning_v2 fails (the factory raises) and nothing is logged.
5. store_learning_v2 hits the "Memory service not available" early return and nothing is logged.
6. Two failures overwrite each other instead of appending.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

import memory_write_log  # noqa: E402

SECRET_URL = "postgresql://claude:hunter2@localhost:5432/continuous_claude"
CONTENT = "Fabric capacity throttling: fail fast and cap throttle waits at 15 minutes."


def _home(monkeypatch, tmp_path):
    # These tests check the default path under the home folder, so drop the
    # conftest override and move home instead.
    monkeypatch.delenv("CCV3_MEMORY_FAILURE_LOG", raising=False)
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    return tmp_path / ".claude" / "state" / "memory-write-failures.jsonl"


def _lines(path: Path) -> list[dict]:
    return [json.loads(x) for x in path.read_text(encoding="utf-8").splitlines()]


def test_mask_urls_hides_both_schemes():
    text = f"connect failed {SECRET_URL} and postgres://u:p@h/db too"
    masked = memory_write_log.mask_urls(text)
    assert "hunter2" not in masked and "u:p@h" not in masked
    assert masked.count("<db-url>") == 2


def test_record_masks_and_truncates(monkeypatch, tmp_path):
    path = _home(monkeypatch, tmp_path)
    memory_write_log.record_write_failure("store_learning", f"{SECRET_URL} " + "x" * 900, "sess-1")
    (row,) = _lines(path)
    assert "hunter2" not in row["error"]
    assert len(row["error"]) <= 300
    assert row["source"] == "store_learning" and row["session_id"] == "sess-1"
    assert row["ts"].endswith("Z") or "+" in row["ts"]


def test_record_appends_not_overwrites(monkeypatch, tmp_path):
    path = _home(monkeypatch, tmp_path)
    memory_write_log.record_write_failure("store_learning", "one", "a")
    memory_write_log.record_write_failure("index_handoffs", "two", "b")
    assert [r["error"] for r in _lines(path)] == ["one", "two"]


def test_record_never_raises(monkeypatch, tmp_path):
    blocker = tmp_path / ".claude"
    blocker.write_text("a file where the folder should be", encoding="utf-8")
    _home(monkeypatch, tmp_path)
    memory_write_log.record_write_failure("store_learning", "boom", "s")  # must not raise


def test_store_learning_failure_is_logged_and_masked(monkeypatch, tmp_path):
    path = _home(monkeypatch, tmp_path)
    monkeypatch.setenv("CONTINUOUS_CLAUDE_DB_URL", SECRET_URL)
    import db.memory_factory as factory
    import store_learning

    async def fake_create(backend, **_kwargs):
        raise RuntimeError(f"could not connect to {SECRET_URL}")

    monkeypatch.setattr(factory, "create_memory_service", fake_create)
    result = asyncio.run(store_learning.store_learning_v2("sess-9", CONTENT, "WORKING_SOLUTION"))
    assert result["success"] is False
    (row,) = _lines(path)
    assert row["source"] == "store_learning" and row["session_id"] == "sess-9"
    assert "hunter2" not in row["error"] and "<db-url>" in row["error"]


def test_store_learning_service_unavailable_is_logged(monkeypatch, tmp_path):
    path = _home(monkeypatch, tmp_path)
    import builtins

    import store_learning

    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "db.memory_factory":
            raise ImportError("no module named factory")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    result = asyncio.run(store_learning.store_learning_v2("sess-3", CONTENT, "WORKING_SOLUTION"))
    monkeypatch.setattr(builtins, "__import__", real_import)
    assert "Memory service not available" in result["error"]
    (row,) = _lines(path)
    assert row["session_id"] == "sess-3" and "Memory service not available" in row["error"]
