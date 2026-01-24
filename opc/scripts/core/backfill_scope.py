#!/usr/bin/env python3
"""Backfill scope classification for existing archival_memory rows.

Classifies existing learnings as PROJECT or GLOBAL based on content analysis.

Usage:
    uv run python backfill_scope.py --dry-run     # Preview changes
    uv run python backfill_scope.py               # Apply changes
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

global_env = Path.home() / ".claude" / ".env"
if global_env.exists():
    load_dotenv(global_env)
load_dotenv()

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from core.store_learning import GLOBAL_KEYWORDS, PROJECT_KEYWORDS, classify_scope


async def backfill_scope(dry_run: bool = True) -> dict:
    """Backfill scope for all archival_memory rows without scope set."""
    try:
        from db.postgres_pool import get_transaction
    except ImportError as e:
        return {"success": False, "error": f"Database not available: {e}"}

    stats = {"total": 0, "global": 0, "project": 0, "skipped": 0}

    async with get_transaction() as conn:
        rows = await conn.fetch(
            """
            SELECT id, content, metadata
            FROM archival_memory
            WHERE scope IS NULL OR scope = ''
            ORDER BY created_at DESC
            """
        )

        stats["total"] = len(rows)

        for row in rows:
            content = row["content"] or ""
            metadata = row["metadata"]

            if isinstance(metadata, str):
                try:
                    metadata = json.loads(metadata)
                except json.JSONDecodeError:
                    metadata = {}

            tags = metadata.get("tags", [])
            context = metadata.get("context", "")

            scope = classify_scope(content, tags, context)

            if scope == "GLOBAL":
                stats["global"] += 1
            else:
                stats["project"] += 1

            if not dry_run:
                await conn.execute(
                    "UPDATE archival_memory SET scope = $1 WHERE id = $2",
                    scope,
                    row["id"],
                )

            if stats["total"] <= 20 or (stats["total"] > 20 and (stats["global"] + stats["project"]) <= 10):
                preview = content[:60].replace("\n", " ")
                print(f"  [{scope}] {preview}...")

    return {
        "success": True,
        "dry_run": dry_run,
        "stats": stats,
    }


async def main():
    parser = argparse.ArgumentParser(description="Backfill scope for archival_memory")
    parser.add_argument("--dry-run", action="store_true", help="Preview without changes")
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    result = await backfill_scope(dry_run=args.dry_run)

    if args.json:
        print(json.dumps(result))
    else:
        if result["success"]:
            stats = result["stats"]
            mode = "DRY RUN" if result["dry_run"] else "APPLIED"
            print(f"\n[{mode}] Backfill complete:")
            print(f"  Total rows: {stats['total']}")
            print(f"  GLOBAL: {stats['global']}")
            print(f"  PROJECT: {stats['project']}")
            if result["dry_run"]:
                print("\nRun without --dry-run to apply changes.")
        else:
            print(f"Failed: {result.get('error', 'unknown')}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
