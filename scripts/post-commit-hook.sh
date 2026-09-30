#!/usr/bin/env bash
# Post-commit hook: auto-sync continuous-claude repo to ~/.claude/
# Canonical source: scripts/post-commit-hook.sh
# Installed to .git/hooks/post-commit by the setup wizard (install-hooks.sh, install-only-if-absent).
# --changed: incremental sync of ONLY the files this commit touched (HEAD diff), NOT a full
#   .claude mirror (the full mirror is pathologically slow on Windows). The full mirror still
#   runs for manual sync / git-pull catch-up / fresh installs (`bash scripts/sync-to-active.sh`).
#
# Visibility (2026-09-30): the sync runs detached, so nobody saw its "Sync skipped" line and a
# worktree commit looked synced when it was not. Now:
#   - the cheap branch check runs in the FOREGROUND and prints the skip line to stderr;
#   - the detached sync appends its output to ~/.claude/logs/post-commit-sync.log.

# Git exports GIT_DIR and friends into hooks; every git call below names its repo with -C.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX GIT_NAMESPACE

REPO_ROOT="$(git rev-parse --show-toplevel)"
SYNC_SCRIPT="$REPO_ROOT/scripts/sync-to-active.sh"
LOG_FILE="$HOME/.claude/logs/post-commit-sync.log"

[[ -f "$SYNC_SCRIPT" ]] || exit 0

# Same rule as the branch guard in scripts/sync-to-active.sh (search "SYNC_ON_MAIN"): only
# `main` in the primary checkout syncs. Keep the two in step. SYNC_ALLOW_BRANCH=1 overrides.
branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
gitdir="$(git -C "$REPO_ROOT" rev-parse --git-dir 2>/dev/null || echo '')"
common="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || echo '')"
if [[ "${SYNC_ALLOW_BRANCH:-0}" != "1" ]] && ! [[ "$branch" == "main" && "$gitdir" == "$common" ]]; then
    echo "Sync skipped: ${branch:-unknown} is not main in the primary checkout (sync runs after merge)" >&2
    exit 0
fi

echo "Syncing to ~/.claude (background; log: $LOG_FILE)..."
mkdir -p "$(dirname "$LOG_FILE")" 2>/dev/null || true
printf '=== %s post-commit sync (%s @ %s) ===\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$branch" "$REPO_ROOT" >> "$LOG_FILE" 2>/dev/null || true
# Fire-and-forget: fully detach so the sync can't linger attached to the commit shell /
# terminal. The output redirect (to the log file, not the shell's pipe) is the real fix for a
# lingering bg proc on Windows Git Bash; nohup survives shell exit; disown drops it from the
# job table (best-effort — job control is off in a non-interactive hook shell, hence the guard).
nohup bash "$SYNC_SCRIPT" --changed >> "$LOG_FILE" 2>&1 & disown 2>/dev/null || true
