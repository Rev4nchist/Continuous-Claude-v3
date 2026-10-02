#!/usr/bin/env bash
# Stub. The forward sync lives in scripts/sync-to-active.sh at the repo root.
#
# This file was an older 272-line copy of that script: raw `cp`, no clobber guard, no link guard,
# no branch guard, no cursor. It wrote through symlinks and junctions in ~/.claude (the PR #75
# find-skills incident). Nothing in the repo calls it (grep 2026-10-01: every doc, hook, test and
# land-pr.ps1 names scripts/sync-to-active.sh). It also gets copied to ~/.claude/scripts/, where
# its repo root does not exist. So it now hands every call to the real script, with the same args.
set -e

SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"
# .claude/scripts -> .claude -> repo root
REAL="$(dirname "$(dirname "$SCRIPT_DIR")")/scripts/sync-to-active.sh"

if [[ ! -f "$REAL" ]]; then
    echo "ERROR: .claude/scripts/sync-to-active.sh is a stub and cannot find $REAL." >&2
    echo "       Run the real forward sync from the continuous-claude repo in Git Bash:" >&2
    echo "       bash ~/continuous-claude/scripts/sync-to-active.sh" >&2
    exit 1
fi

echo "NOTE: .claude/scripts/sync-to-active.sh is a stub; running scripts/sync-to-active.sh instead." >&2
exec bash "$REAL" "$@"
