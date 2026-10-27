#!/usr/bin/env python3
"""Back up and restore the archival_memory table.

Usage:
    uv run python scripts/core/memory_backup.py backup
    uv run python scripts/core/memory_backup.py restore --file <path> [--yes]

backup:  writes ~/.claude/state/memory-backup/archival_memory-YYYYMMDD.jsonl,
         keeps the newest 7 files, prints "backup: N rows -> <file>".
         An empty table writes nothing, so it can never rotate out good backups.
restore: refuses unless archival_memory is empty or --yes is given. Inserts rows
         with their original ids (ON CONFLICT DO NOTHING) in one transaction and
         prints "restore: N inserted, M skipped". Never prints the database URL.

The connection uses no pgvector codec: embeddings travel as text and are cast
back to vector in SQL.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import tempfile
from datetime import date, datetime
from pathlib import Path

from dotenv import load_dotenv

global_env = Path.home() / ".claude" / ".env"
if global_env.exists():
    load_dotenv(global_env)
load_dotenv()

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
sys.path.insert(0, os.path.dirname(__file__))

from memory_write_log import mask_urls  # noqa: E402

KEEP_BACKUPS = 7
FILE_GLOB = "archival_memory-*.jsonl"
COLUMNS = (
    "id", "session_id", "agent_id", "project_id", "scope", "content",
    "metadata", "embedding", "created_at", "valid_from", "valid_until",
)
EXPORT_SQL = (
    "SELECT id::text AS id, session_id, agent_id, project_id, scope, content, "
    "metadata::text AS metadata, embedding::text AS embedding, "
    "created_at, valid_from, valid_until FROM archival_memory ORDER BY created_at, id"
)
INSERT_SQL = (
    "INSERT INTO archival_memory (id, session_id, agent_id, project_id, scope, content, "
    "metadata, embedding, created_at, valid_from, valid_until) VALUES "
    "($1::text::uuid, $2, $3, $4, $5, $6, $7::text::jsonb, $8::text::vector, $9, $10, $11) "
    "ON CONFLICT (id) DO NOTHING"
)


class RestoreRefusedError(RuntimeError):
    """The table has rows and --yes was not given."""


def backup_dir() -> Path:
    return Path.home() / ".claude" / "state" / "memory-backup"


def rotate(folder: Path, keep: int = KEEP_BACKUPS) -> list[Path]:
    """Delete all but the newest `keep` backup files in `folder` only."""
    files = sorted(p for p in folder.glob(FILE_GLOB) if p.is_file())
    stale = files[:-keep] if keep > 0 else files
    for path in stale:
        path.unlink()
    return stale


def _iso(value: object) -> object:
    return value.isoformat() if isinstance(value, (datetime, date)) else value


def _to_line(record: dict) -> str:
    row = {name: _iso(record[name]) for name in COLUMNS}
    if row["metadata"] is not None:
        row["metadata"] = json.loads(row["metadata"])
    return json.dumps(row, ensure_ascii=False)


async def backup(conn, folder: Path, day: str | None = None) -> tuple[int, Path | None]:
    """Write all rows to a dated file. Returns (row count, file or None when empty)."""
    records = await conn.fetch(EXPORT_SQL)
    if not records:
        return 0, None
    # Owner-only: the backup holds every lesson in plain text.
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = folder / f"archival_memory-{day or datetime.now().strftime('%Y%m%d')}.jsonl"
    # A unique temp file per run (mkstemp creates it 0600), so two sessions that
    # back up on the same day never write into one file; os.replace is atomic.
    fd, partial = tempfile.mkstemp(prefix=f"{target.stem}.", suffix=".tmp", dir=folder)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            for record in records:
                handle.write(_to_line(record) + "\n")
        os.replace(partial, target)
    except BaseException:
        Path(partial).unlink(missing_ok=True)
        raise
    rotate(folder)
    return len(records), target


def load_rows(path: Path) -> list[dict]:
    """Read the whole file first, so a bad line aborts before any insert."""
    rows = []
    with path.open(encoding="utf-8") as handle:
        for number, line in enumerate(handle, start=1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                missing = [name for name in COLUMNS if name not in row]
            except json.JSONDecodeError as exc:
                raise ValueError(f"line {number}: not valid JSON ({exc.msg})") from exc
            if missing:
                raise ValueError(f"line {number}: missing {', '.join(missing)}")
            rows.append(row)
    return rows


def _when(value: str | None) -> datetime | None:
    return datetime.fromisoformat(value) if value else None


def _args(row: dict) -> tuple:
    metadata = row["metadata"]
    return (
        row["id"], row["session_id"], row["agent_id"], row["project_id"], row["scope"],
        row["content"], None if metadata is None else json.dumps(metadata),
        row["embedding"], _when(row["created_at"]), _when(row["valid_from"]),
        _when(row["valid_until"]),
    )


async def restore(conn, rows: list[dict], yes: bool) -> tuple[int, int]:
    """Insert rows in one transaction. Returns (inserted, skipped).

    The table is locked against writers before the empty check, and the lock
    holds through the inserts, so no row can slip in between check and restore.
    """
    inserted = 0
    async with conn.transaction():
        await conn.execute("LOCK TABLE archival_memory IN SHARE ROW EXCLUSIVE MODE")
        existing = await conn.fetchval("SELECT count(*) FROM archival_memory")
        if existing and not yes:
            raise RestoreRefusedError(
                f"archival_memory has {existing} rows; pass --yes to restore into it"
            )
        for row in rows:
            status = await conn.execute(INSERT_SQL, *_args(row))
            inserted += 1 if status.endswith(" 1") else 0
    return inserted, len(rows) - inserted


async def _connect(url: str):
    import asyncpg

    return await asyncpg.connect(url)


def _url() -> str:
    from scripts.core.db.postgres_pool import configured_url

    url = configured_url()
    if not url:
        raise RuntimeError("no database URL set (CONTINUOUS_CLAUDE_DB_URL)")
    return url


async def _run(args: argparse.Namespace) -> int:
    rows = load_rows(Path(args.file)) if args.command == "restore" else []
    conn = await _connect(_url())
    try:
        if args.command == "backup":
            count, target = await backup(conn, backup_dir())
            print(f"backup: {count} rows -> {target}" if target else "backup: 0 rows, no file")
            return 0
        inserted, skipped = await restore(conn, rows, args.yes)
        print(f"restore: {inserted} inserted, {skipped} skipped")
        return 0
    finally:
        await conn.close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Back up and restore archival_memory")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("backup", help="export all rows to a dated JSONL file")
    restore_cmd = sub.add_parser("restore", help="insert rows from a backup file")
    restore_cmd.add_argument("--file", required=True)
    restore_cmd.add_argument("--yes", action="store_true", help="restore into a non-empty table")
    args = parser.parse_args(argv)
    try:
        return asyncio.run(_run(args))
    except Exception as exc:  # noqa: BLE001 - one masked line, non-zero exit
        print(f"{args.command}: failed: {mask_urls(str(exc))[:300]}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
