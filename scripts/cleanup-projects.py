#!/usr/bin/env python3
"""
cleanup-projects.py - Clean old session JSONLs from .claude/projects/

Uses age-based cleanup: files older than min-age days are safe to delete
because the memory daemon extracts within minutes of session going stale.

USAGE:
    uv run python scripts/cleanup-projects.py [--dry-run] [--min-age DAYS]

OPTIONS:
    --dry-run       Show what would be deleted without deleting
    --min-age DAYS  Only delete files older than N days (default: 3)
    --quiet         Only output if files are deleted

SAFETY:
    - Default 3-day threshold gives plenty of margin for extraction
    - Memory daemon extracts when session is stale (5 min idle)
    - Active sessions have recent files (always < 1 day old)
"""

import argparse
from datetime import datetime, timedelta
from pathlib import Path


def find_old_jsonl_files(projects_dir: Path, min_age_days: int) -> list[tuple[Path, int, int]]:
    """Find JSONL files older than min_age_days.

    Returns: list of (path, size_bytes, age_days)
    """
    cutoff = datetime.now() - timedelta(days=min_age_days)
    files = []

    for jsonl in projects_dir.rglob("*.jsonl"):
        try:
            stat = jsonl.stat()
            mtime = datetime.fromtimestamp(stat.st_mtime)
            if mtime < cutoff:
                age_days = (datetime.now() - mtime).days
                files.append((jsonl, stat.st_size, age_days))
        except OSError:
            continue

    return sorted(files, key=lambda x: x[2], reverse=True)  # Oldest first


def format_size(size_bytes: int) -> str:
    """Format bytes to human-readable size."""
    for unit in ['B', 'KB', 'MB', 'GB']:
        if size_bytes < 1024:
            return f"{size_bytes:.1f}{unit}"
        size_bytes /= 1024
    return f"{size_bytes:.1f}TB"


def main():
    parser = argparse.ArgumentParser(description="Clean old session JSONLs")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be deleted")
    parser.add_argument("--min-age", type=int, default=3, help="Min age in days (default: 3)")
    parser.add_argument("--quiet", action="store_true", help="Only output if files deleted")
    args = parser.parse_args()

    projects_dir = Path.home() / ".claude" / "projects"
    if not projects_dir.exists():
        if not args.quiet:
            print("No projects directory found")
        return

    # Find old files
    files = find_old_jsonl_files(projects_dir, args.min_age)

    if not files:
        if not args.quiet:
            print(f"No JSONL files older than {args.min_age} days.")
        return

    total_size = sum(size for _, size, _ in files)

    if args.dry_run:
        print(f"DRY RUN - would delete {len(files)} files ({format_size(total_size)})")
        print(f"Oldest: {files[0][2]} days, Newest: {files[-1][2]} days")
        print(f"\nSample files:")
        for path, size, age in files[:10]:
            print(f"  {path.parent.name}/{path.name} ({format_size(size)}, {age}d)")
        if len(files) > 10:
            print(f"  ... and {len(files) - 10} more")
        print(f"\nRun without --dry-run to delete.")
    else:
        # Delete files
        deleted = 0
        for path, _, _ in files:
            try:
                path.unlink()
                deleted += 1
            except OSError:
                pass

        if deleted > 0 or not args.quiet:
            print(f"Cleaned {deleted} old JSONLs ({format_size(total_size)})")


if __name__ == "__main__":
    main()
