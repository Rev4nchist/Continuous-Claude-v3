#!/usr/bin/env python3
"""Cleanup stale sessions older than 24 hours.

USAGE:
    cd ~/.claude/scripts/core && uv run python core/cleanup_sessions.py
    cd ~/.claude/scripts/core && uv run python core/cleanup_sessions.py --hours 12  # 12 hour cutoff
    cd ~/.claude/scripts/core && uv run python core/cleanup_sessions.py --dry-run   # Preview only
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

global_env = Path.home() / ".claude" / ".env"
if global_env.exists():
    load_dotenv(global_env)
load_dotenv()

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


async def cleanup_sessions(hours: int = 24, dry_run: bool = False) -> int:
    """Remove stale sessions older than specified hours.

    Args:
        hours: Cutoff age in hours (default 24)
        dry_run: If True, only show what would be deleted

    Returns:
        Number of sessions cleaned up
    """
    from db.postgres_pool import get_pool

    pool = await get_pool()

    async with pool.acquire() as conn:
        if dry_run:
            row = await conn.fetchrow(
                f"""
                SELECT COUNT(*) as count
                FROM sessions
                -- GREATEST, not bare last_heartbeat: the heartbeat is written on
                -- UserPromptSubmit only, so an unattended run (Ralph, a scheduled
                -- job) can work for more than {hours}h without one and would be
                -- DELETED here while still live, orphaning its file claims.
                WHERE GREATEST(last_heartbeat, last_activity_at) < NOW() - INTERVAL '{hours} hours'
                """
            )
            count = row["count"]
            print(f"Would delete {count} stale sessions (older than {hours} hours)")
            return count
        else:
            result = await conn.execute(
                f"""
                DELETE FROM sessions
                -- GREATEST, not bare last_heartbeat: the heartbeat is written on
                -- UserPromptSubmit only, so an unattended run (Ralph, a scheduled
                -- job) can work for more than {hours}h without one and would be
                -- DELETED here while still live, orphaning its file claims.
                WHERE GREATEST(last_heartbeat, last_activity_at) < NOW() - INTERVAL '{hours} hours'
                """
            )
            count = int(result.split()[-1]) if result else 0
            print(f"Cleaned up {count} stale sessions (older than {hours} hours)")
            return count


async def cleanup_file_claims(hours: int = 24, dry_run: bool = False) -> int:
    """Remove orphaned file claims from deleted sessions.

    Args:
        hours: Cutoff age in hours (default 24)
        dry_run: If True, only show what would be deleted

    Returns:
        Number of file claims cleaned up
    """
    from db.postgres_pool import get_pool

    pool = await get_pool()

    async with pool.acquire() as conn:
        if dry_run:
            row = await conn.fetchrow(
                f"""
                SELECT COUNT(*) as count
                FROM file_claims fc
                WHERE NOT EXISTS (
                    SELECT 1 FROM sessions s WHERE s.id = fc.session_id
                )
                OR fc.claimed_at < NOW() - INTERVAL '{hours} hours'
                """
            )
            count = row["count"]
            print(f"Would delete {count} orphaned file claims")
            return count
        else:
            result = await conn.execute(
                f"""
                DELETE FROM file_claims
                WHERE NOT EXISTS (
                    SELECT 1 FROM sessions s WHERE s.id = session_id
                )
                OR claimed_at < NOW() - INTERVAL '{hours} hours'
                """
            )
            count = int(result.split()[-1]) if result else 0
            print(f"Cleaned up {count} orphaned file claims")
            return count


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Cleanup stale sessions and orphaned file claims",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--hours",
        type=int,
        default=24,
        help="Cutoff age in hours (default: 24)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Preview what would be deleted without actually deleting",
    )
    parser.add_argument(
        "--sessions-only",
        action="store_true",
        help="Only cleanup sessions, not file claims",
    )

    args = parser.parse_args()

    print(f"Continuous Claude Cleanup (cutoff: {args.hours} hours)")
    print("-" * 50)

    sessions_count = await cleanup_sessions(args.hours, args.dry_run)

    if not args.sessions_only:
        claims_count = await cleanup_file_claims(args.hours, args.dry_run)
    else:
        claims_count = 0

    print("-" * 50)
    total = sessions_count + claims_count
    if args.dry_run:
        print(f"Total: {total} items would be cleaned up")
    else:
        print(f"Total: {total} items cleaned up")

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
