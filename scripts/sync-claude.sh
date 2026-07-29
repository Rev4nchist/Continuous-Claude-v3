#!/usr/bin/env bash
# Sync script for Continuous Claude
# Syncs shareable files between ~/.claude and continuous-claude/.claude

set -e

SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
REPO_CLAUDE="$REPO_ROOT/.claude"
USER_CLAUDE="$HOME/.claude"

# Parse args
DIRECTION="to-repo"
DRY_RUN=false
VERBOSE=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --to-repo) DIRECTION="to-repo"; shift ;;
        --from-repo) DIRECTION="from-repo"; shift ;;
        --dry-run) DRY_RUN=true; shift ;;
        --verbose) VERBOSE=true; shift ;;
        --help|-h)
            echo "Usage: $0 [--to-repo|--from-repo] [--dry-run] [--verbose]"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Set source and destination
if [[ "$DIRECTION" == "to-repo" ]]; then
    SRC="$USER_CLAUDE"
    DST="$REPO_CLAUDE"
else
    SRC="$REPO_CLAUDE"
    DST="$USER_CLAUDE"
fi

$VERBOSE && echo "Syncing: $SRC -> $DST"

# Pre-flight: refuse reverse-sync if repo audit invariant violated.
# Reverse-sync used to propagate fossilized ~/.claude/hooks/src/ back to repo,
# silently undoing every emit-site fix. Audit gate stops that propagation.
if [[ "$DIRECTION" == "to-repo" ]]; then
    AUDIT_SCRIPT="$REPO_ROOT/scripts/audit-braintrust-emits.sh"
    if [ -f "$AUDIT_SCRIPT" ]; then
        if ! bash "$AUDIT_SCRIPT" > /tmp/sync-claude-audit.log 2>&1; then
            echo "ABORT: reverse-sync refused -- repo audit invariant violated." >&2
            echo "       Reverse-sync would propagate corruption to ~/.claude/." >&2
            cat /tmp/sync-claude-audit.log >&2
            exit 1
        fi
    fi

    # Pre-flight 2 (2026-06-01): refuse reverse-sync if the REPO has uncommitted
    # changes in the synced dirs. Reverse-sync (active -> repo) would overwrite
    # fresh repo edits with the active copy -- the exact clobber that reverted
    # rules/codex-adversarial.md twice on 2026-06-01 (the emit-only gate above
    # does not protect non-emit docs). The repo is the source of truth: commit
    # or stash repo edits first, or let the forward-sync handle repo -> active.
    # This makes an accidental or re-introduced automatic reverse-sync safe.
    if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
        DIRTY="$(git -C "$REPO_ROOT" status --porcelain -- \
            .claude/rules-src .claude/agents .claude/skills .claude/scripts \
            .claude/docs .claude/hooks 2>/dev/null)"
        if [ -n "$DIRTY" ]; then
            echo "ABORT: reverse-sync refused -- repo has uncommitted changes in synced dirs:" >&2
            echo "$DIRTY" | head -20 >&2
            echo "       Reverse-sync would clobber these fresh repo edits. Commit or stash" >&2
            echo "       them first (the repo is the source of truth)." >&2
            exit 1
        fi
    fi
fi

# Directories to sync
# Note: hooks/src removed from SYNC_DIRS (was the propagation vector for
# regressions #1-#7). Forward sync-to-active.sh also excludes hooks/src --
# both scripts are now symmetric. hooks/dist/*.mjs is what runs at hook time
# and is synced by sync-to-active.sh's dedicated dist branch.
# `rules` is NOT here: the two sides use DIFFERENT names. Active is
# ~/.claude/rules/ (what Claude Code loads as user scope); repo is
# .claude/rules-src/ so Claude Code does NOT also auto-load it as project scope.
# Same-name copying would recreate the ~61k/session duplicate that commit 9f9b9d4
# removed -- a reverse-sync would silently undo it. See sync-to-active.sh.
SYNC_DIRS="agents skills scripts docs"

# Direction-aware mapping for the rules tree (active name != repo name).
if [[ "$DIRECTION" == "to-repo" ]]; then
    RULES_SRC_DIR="rules"; RULES_DST_DIR="rules-src"
else
    RULES_SRC_DIR="rules-src"; RULES_DST_DIR="rules"
fi

# Files/patterns to never sync
NEVER_SYNC="CLAUDE.md RULES.md .env .credentials.json settings.json history.jsonl knowledge-tree.json"

# Copy function
copy_dir() {
    local dir="$1"
    # Optional 2nd arg: dest dir name when it differs from the source name
    # (used by the rules mapping above). Defaults to same-name.
    local dst_dir="${2:-$1}"
    local src_path="$SRC/$dir"
    local dst_path="$DST/$dst_dir"

    [[ ! -d "$src_path" ]] && return 0

    $DRY_RUN || mkdir -p "$dst_path"

    # Use cp -r with exclusions simulated via find
    find "$src_path" -type f ! -name "*.pid" ! -name "*.lock" ! -path "*/.tldr/*" ! -path "*/node_modules/*" ! -path "*/cache/*" 2>/dev/null | while IFS= read -r src_file; do
        local rel="${src_file#$src_path/}"
        local dst_file="$dst_path/$rel"

        # Skip never-sync files
        local base=$(basename "$src_file")
        for skip in $NEVER_SYNC; do
            [[ "$base" == "$skip" ]] && continue 2
        done

        if $DRY_RUN; then
            echo "Would copy: $dir/$rel"
        else
            mkdir -p "$(dirname "$dst_file")"
            cp "$src_file" "$dst_file"
            $VERBOSE && echo "Copied: $dir/$rel"
        fi
    done
}

# Sync each directory
for dir in $SYNC_DIRS; do
    copy_dir "$dir"
done

# rules, with its cross-name mapping (see RULES_*_DIR above).
copy_dir "$RULES_SRC_DIR" "$RULES_DST_DIR"

# Copy specific hook files
for pattern in "hooks/*.sh" "hooks/*.py" "hooks/*.mjs" "hooks/*.ps1" "hooks/package.json" "hooks/tsconfig.json"; do
    for src_file in $SRC/$pattern; do
        [[ ! -f "$src_file" ]] && continue
        rel="${src_file#$SRC/}"
        dst_file="$DST/$rel"

        if $DRY_RUN; then
            echo "Would copy: $rel"
        else
            mkdir -p "$(dirname "$dst_file")"
            cp "$src_file" "$dst_file"
            $VERBOSE && echo "Copied: $rel"
        fi
    done
done

$VERBOSE && echo "Sync complete"
