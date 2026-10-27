"""Unit checks for memory_backup. The round trip on a real database is an E2E check.

Ways it can fail, one test each:
1. Rotation keeps more or fewer than 7 files.
2. Rotation deletes a file that is not a memory backup, or reaches outside its folder.
3. Restore writes into a table that already has rows and --yes was not given.
4. Restore refuses an empty table (the normal recovery case).
5. Restore with --yes into a non-empty table does not run.
6. Restore counts a conflicting id as inserted.
7. Restore prints or raises the database URL.
8. A bad line in the backup file leaves a half-restored table.
9. Backup of an empty table writes a file (and rotates good backups out).
"""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import pytest

OPC = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(OPC))
sys.path.insert(0, str(OPC / "scripts" / "core"))

import memory_backup  # noqa: E402

ROW = {
    "id": "11111111-1111-1111-1111-111111111111",
    "session_id": "s",
    "agent_id": None,
    "project_id": None,
    "scope": "GLOBAL",
    "content": "lesson",
    "metadata": {"type": "session_learning"},
    "embedding": None,
    "created_at": "2026-10-01T00:00:00+00:00",
    "valid_from": "2026-10-01T00:00:00+00:00",
    "valid_until": None,
}


class FakeTx:
    def __init__(self, conn):
        self.conn = conn

    async def __aenter__(self):
        self.conn.tx_open += 1

    async def __aexit__(self, *exc):
        self.conn.tx_open -= 1
        self.conn.tx_failed = exc[0] is not None


class FakeConn:
    def __init__(self, existing, conflict_ids=()):
        self.existing = existing
        self.conflict_ids = set(conflict_ids)
        self.executed = []
        self.tx_open = 0
        self.tx_failed = False
        self.events = []

    async def fetchval(self, sql, *args):
        self.events.append(("count", self.tx_open > 0))
        return self.existing

    def transaction(self):
        return FakeTx(self)

    async def execute(self, sql, *args):
        if sql.startswith("LOCK TABLE"):
            self.events.append(("lock", self.tx_open > 0))
            return "LOCK TABLE"
        self.executed.append(args)
        return "INSERT 0 0" if args[0] in self.conflict_ids else "INSERT 0 1"


def _touch(folder: Path, name: str) -> Path:
    p = folder / name
    p.write_text("x", encoding="utf-8")
    return p


def test_rotate_keeps_newest_seven(tmp_path):
    for day in range(1, 11):
        _touch(tmp_path, f"archival_memory-202610{day:02d}.jsonl")
    memory_backup.rotate(tmp_path, keep=7)
    left = sorted(p.name for p in tmp_path.iterdir())
    assert len(left) == 7
    assert left[0] == "archival_memory-20261004.jsonl"
    assert left[-1] == "archival_memory-20261010.jsonl"


def test_rotate_leaves_other_files_alone(tmp_path):
    for day in range(1, 10):
        _touch(tmp_path, f"archival_memory-202610{day:02d}.jsonl")
    keep_me = _touch(tmp_path, "notes.txt")
    other = tmp_path / "other"
    other.mkdir()
    outside = _touch(other, "archival_memory-20200101.jsonl")
    memory_backup.rotate(tmp_path, keep=7)
    assert keep_me.exists() and outside.exists()


def test_restore_refuses_nonempty_without_yes():
    conn = FakeConn(existing=5)
    with pytest.raises(memory_backup.RestoreRefusedError):
        asyncio.run(memory_backup.restore(conn, [ROW], yes=False))
    assert conn.executed == []


def test_restore_locks_before_the_empty_check_inside_the_transaction():
    """A writer must not slip a row in between the empty check and the inserts."""
    conn = FakeConn(existing=0)
    asyncio.run(memory_backup.restore(conn, [ROW], yes=False))
    assert conn.events[:2] == [("lock", True), ("count", True)]


def test_backup_uses_a_unique_temp_file_and_leaves_none_behind(tmp_path):
    class Conn:
        async def fetch(self, sql, *args):
            return [{**ROW, "embedding": "[0.1]", "metadata": json.dumps(ROW["metadata"])}]

    count, target = asyncio.run(memory_backup.backup(Conn(), tmp_path, day="20261027"))
    assert count == 1 and target.exists()
    assert list(tmp_path.glob("*.tmp")) == []


def test_restore_into_empty_table_needs_no_yes():
    conn = FakeConn(existing=0)
    assert asyncio.run(memory_backup.restore(conn, [ROW], yes=False)) == (1, 0)
    assert conn.executed[0][0] == ROW["id"]


def test_restore_with_yes_runs_on_nonempty_table():
    conn = FakeConn(existing=5)
    assert asyncio.run(memory_backup.restore(conn, [ROW], yes=True)) == (1, 0)


def test_restore_counts_conflicts_as_skipped():
    conn = FakeConn(existing=3, conflict_ids=[ROW["id"]])
    assert asyncio.run(memory_backup.restore(conn, [ROW], yes=True)) == (0, 1)


def test_load_rows_rejects_a_bad_line_before_any_insert(tmp_path):
    f = tmp_path / "archival_memory-20261001.jsonl"
    f.write_text(json.dumps(ROW) + "\n{not json\n", encoding="utf-8")
    with pytest.raises(ValueError) as err:
        memory_backup.load_rows(f)
    assert "line 2" in str(err.value)


def test_restore_error_does_not_leak_url(capsys, monkeypatch, tmp_path):
    secret = "postgresql://claude:hunter2@localhost:5432/continuous_claude"
    monkeypatch.setenv("CONTINUOUS_CLAUDE_DB_URL", secret)
    f = tmp_path / "archival_memory-20261001.jsonl"
    f.write_text(json.dumps(ROW) + "\n", encoding="utf-8")

    async def boom(_url):
        raise OSError(f"cannot connect to {secret}")

    monkeypatch.setattr(memory_backup, "_connect", boom)
    code = memory_backup.main(["restore", "--file", str(f)])
    out = capsys.readouterr()
    assert code != 0
    assert "hunter2" not in out.out + out.err


def test_backup_of_empty_table_writes_nothing(tmp_path):
    class Empty:
        async def fetch(self, sql, *args):
            return []

    count, path = asyncio.run(memory_backup.backup(Empty(), tmp_path, day="20261027"))
    assert count == 0 and path is None
    assert list(tmp_path.iterdir()) == []


def test_backup_writes_every_column_and_load_rows_reads_it_back(tmp_path):
    when = datetime(2026, 10, 1, tzinfo=UTC)

    class One:
        async def fetch(self, sql, *args):
            return [{**ROW, "metadata": '{"type": "session_learning"}',
                     "embedding": "[0.1,0.2]", "created_at": when, "valid_from": when}]

    count, path = asyncio.run(memory_backup.backup(One(), tmp_path, day="20261027"))
    assert count == 1 and path.name == "archival_memory-20261027.jsonl"
    (row,) = memory_backup.load_rows(path)
    assert set(row) == set(ROW)
    assert row["embedding"] == "[0.1,0.2]" and row["metadata"] == {"type": "session_learning"}
    assert row["created_at"] == when.isoformat()
