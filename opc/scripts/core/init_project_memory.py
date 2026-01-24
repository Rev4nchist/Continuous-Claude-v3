#!/usr/bin/env python3
"""Initialize project memory by indexing existing handoffs.

Walks thoughts/shared/handoffs/ and builds index.json.

Usage:
    uv run python init_project_memory.py --project-dir .
    uv run python init_project_memory.py --project-dir . --reindex  # Force reindex all
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

from project_memory import init_project_index, update_index, load_index


def find_handoffs(project_dir: str) -> list[Path]:
    """Find all handoff files in thoughts/shared/handoffs/."""
    handoffs_dir = Path(project_dir) / "thoughts" / "shared" / "handoffs"
    if not handoffs_dir.exists():
        return []

    handoffs = []
    for session_dir in handoffs_dir.iterdir():
        if not session_dir.is_dir():
            continue
        for f in session_dir.iterdir():
            if f.suffix in (".yaml", ".yml", ".md"):
                handoffs.append(f)

    handoffs.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return handoffs


async def init_memory(project_dir: str, reindex: bool = False) -> dict:
    """Initialize project memory from existing handoffs."""
    index = init_project_index(project_dir)

    if not reindex and index.get("sessions"):
        return {
            "success": True,
            "message": "Index already exists. Use --reindex to rebuild.",
            "session_count": len(index["sessions"]),
        }

    handoffs = find_handoffs(project_dir)
    if not handoffs:
        return {
            "success": True,
            "message": "No handoffs found in thoughts/shared/handoffs/",
            "indexed": 0,
        }

    indexed = 0
    errors = []

    for handoff_path in handoffs:
        try:
            result = update_index(project_dir, str(handoff_path))
            if result:
                indexed += 1
                print(f"  Indexed: {handoff_path.parent.name}/{handoff_path.name}")
            else:
                errors.append(str(handoff_path))
        except Exception as e:
            errors.append(f"{handoff_path}: {e}")

    index = load_index(project_dir)

    return {
        "success": True,
        "indexed": indexed,
        "errors": errors[:5],
        "session_count": len(index.get("sessions", {})),
        "topic_count": len(index.get("topic_index", {})),
    }


async def main():
    parser = argparse.ArgumentParser(description="Initialize project memory index")
    parser.add_argument("--project-dir", default=".", help="Project directory")
    parser.add_argument("--reindex", action="store_true", help="Force reindex all handoffs")
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    result = await init_memory(args.project_dir, reindex=args.reindex)

    if args.json:
        print(json.dumps(result))
    else:
        if result["success"]:
            print(f"\nProject memory initialized:")
            print(f"  Indexed: {result.get('indexed', 0)} handoffs")
            print(f"  Sessions: {result.get('session_count', 0)}")
            print(f"  Topics: {result.get('topic_count', 0)}")
            if result.get("errors"):
                print(f"  Errors: {len(result['errors'])}")
        else:
            print(f"Failed: {result.get('error', 'unknown')}", file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
