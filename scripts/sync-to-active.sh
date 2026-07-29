#!/usr/bin/env bash
# Sync continuous-claude/.claude/ → ~/.claude/ (forward sync)
# Run after git pull or local edits in continuous-claude

set -e

SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
REPO_CLAUDE="$REPO_ROOT/.claude"
ACTIVE_CLAUDE="$HOME/.claude"

DRY_RUN=false
VERBOSE=false
CHANGED=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --dry-run) DRY_RUN=true; shift ;;
        --verbose) VERBOSE=true; shift ;;
        --changed) CHANGED=true; shift ;;
        --skip-build) shift ;;
        --help|-h)
            echo "Usage: $0 [--dry-run] [--verbose] [--changed] [--skip-build]"
            echo ""
            echo "Syncs continuous-claude/.claude/ → ~/.claude/"
            echo ""
            echo "Options:"
            echo "  --dry-run     Show what would be copied without copying"
            echo "  --verbose     Show detailed progress"
            echo "  --changed     Incremental: sync only files the latest commit"
            echo "                (HEAD diff) touched. Without it, the full mirror runs."
            echo "  --skip-build  Accepted for back-compat; no-op (build step was removed)"
            exit 0
            ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

$VERBOSE && echo "Syncing: $REPO_CLAUDE → $ACTIVE_CLAUDE" || true

# hooks/src excluded: dist/*.mjs is what runs; copying src stomps mtimes and breaks hook-dist-freshness.
#
# NOTE: `rules` is NOT in this list. The repo keeps them at .claude/rules-src/ and
# they land at ~/.claude/rules/ -- source name deliberately differs from dest name.
# Why: Claude Code auto-loads .claude/rules/*.md from BOTH user scope and project
# scope. With the repo copy at .claude/rules/, every session in this repo loaded all
# 46 rules TWICE, byte-identical. Measured with /context on 2026-07-29:
# 145.6k memory-file tokens here vs 82.1k in a project with no .claude/rules --
# a ~61k/session duplicate, 13% of the 1M window, carrying zero information.
# Renaming the SOURCE keeps the rules version-controlled and still fed to
# ~/.claude/rules/ (which 18 of 19 projects rely on as their ONLY copy) while
# removing the second load. See docs/harness-strategy/.
SYNC_DIRS="agents skills scripts docs"

# Explicit source->dest mapping for the rules tree (names differ, see above).
RULES_SRC_DIR="rules-src"
RULES_DST_DIR="rules"

NEVER_SYNC="CLAUDE.md RULES.md .env .credentials.json settings.json history.jsonl knowledge-tree.json"

# JSON-validated copy for .claude/project-registry.json (repo = canonical, active = mirror).
# Never propagates a corrupt registry: parse must succeed before the copy happens.
copy_registry() {
    local src="$REPO_CLAUDE/project-registry.json"
    local dst="$ACTIVE_CLAUDE/project-registry.json"
    [[ -f "$src" ]] || return 0
    if $DRY_RUN; then
        echo "[DRY RUN] Would copy: $src -> $dst"
        return 0
    fi
    if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$src" 2>/dev/null; then
        echo "  WARNING: repo project-registry.json is invalid JSON -- NOT synced"
        return 0
    fi
    mkdir -p "$ACTIVE_CLAUDE"
    cmp -s "$src" "$dst" 2>/dev/null || cp "$src" "$dst"
    $VERBOSE && echo "Copied: project-registry.json" || true
}

copy_dir() {
    local dir="$1"
    # Optional 2nd arg: dest dir name when it differs from the source name
    # (used by the rules-src -> rules mapping). Defaults to same-name.
    local dst_dir="${2:-$1}"
    local src_path="$REPO_CLAUDE/$dir"
    local dst_path="$ACTIVE_CLAUDE/$dst_dir"

    [[ ! -d "$src_path" ]] && return 0

    $DRY_RUN || mkdir -p "$dst_path"

    while IFS= read -r src_file; do
        local rel="${src_file#$src_path/}"
        local dst_file="$dst_path/$rel"

        local base=$(basename "$src_file")
        local skip_file=false
        for skip in $NEVER_SYNC; do
            [[ "$base" == "$skip" ]] && skip_file=true && break
        done
        $skip_file && continue

        if $DRY_RUN; then
            echo "[DRY RUN] Would copy: $src_file -> $dst_file"
        else
            mkdir -p "$(dirname "$dst_file")"
            cp "$src_file" "$dst_file"
            $VERBOSE && echo "Copied: $dir/$rel" || true
        fi
    done < <(find "$src_path" -type f ! -name "*.pid" ! -name "*.lock" ! -path "*/.tldr/*" ! -path "*/node_modules/*" ! -path "*/cache/*" ! -path "*/dist/*" 2>/dev/null)
}

# -----------------------------------------------------------------------------
# Single-flight lock (atomic mkdir). Concurrent invocations coalesce: a second
# sync sees the held lock and exits 0 quietly instead of running an overlapping
# mirror. Fail-open by design; dry-run never locks (read-only inspection).
# -----------------------------------------------------------------------------
LOCK_DIR="$ACTIVE_CLAUDE/.sync.lock"
LOCK_HELD=false

release_lock() {
    if $LOCK_HELD; then
        rmdir "$LOCK_DIR" 2>/dev/null || true
    fi
    return 0
}

if ! $DRY_RUN; then
    mkdir -p "$ACTIVE_CLAUDE" 2>/dev/null || true
    # Stale-lock guard: steal a lock older than ~120s (a prior run likely died).
    if [[ -d "$LOCK_DIR" ]]; then
        now_ts=$(date +%s 2>/dev/null || echo 0)
        lock_ts=$(stat -c %Y "$LOCK_DIR" 2>/dev/null || stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0)
        if [[ "$now_ts" -gt 0 && "$lock_ts" -gt 0 && $(( now_ts - lock_ts )) -gt 120 ]]; then
            rmdir "$LOCK_DIR" 2>/dev/null || true
        fi
    fi
    if mkdir "$LOCK_DIR" 2>/dev/null; then
        LOCK_HELD=true
        trap release_lock EXIT
    else
        $VERBOSE && echo "Another sync is already running (lock held); exiting." || true
        exit 0
    fi
fi

# -----------------------------------------------------------------------------
# Incremental mode (--changed): copy/delete ONLY what the latest commit touched,
# using the SAME source->dest mapping as the full mirror below. Skips the
# whole-tree walk (dominated by the skills/ subtree) so a docs-only commit never
# re-copies hundreds of unrelated skill files. Renames are not detected (no -M),
# so a moved file shows as D(old)+A(new) and is handled correctly. Full mode is
# left completely intact -- this branch exits before reaching it.
# -----------------------------------------------------------------------------
if $CHANGED; then
    SYNC_AGENT_JSON="$SCRIPT_DIR/sync-agent-json.py"
    AGENT_MD_PATHS=()
    SETTINGS_CHANGED=false

    # Excluded within the rules/agents/skills/scripts/docs subtree -- mirrors the
    # find filters in copy_dir() plus NEVER_SYNC by basename. Returns 0 = excluded.
    changed_is_excluded() {
        local p="$1" base="${1##*/}" skip
        case "$base" in
            *.pid|*.lock) return 0 ;;
        esac
        for skip in $NEVER_SYNC; do
            [[ "$base" == "$skip" ]] && return 0
        done
        case "/$p/" in
            */.tldr/*|*/node_modules/*|*/cache/*|*/dist/*) return 0 ;;
        esac
        return 1
    }

    # Map a repo-relative path to its active-tree dest, or echo nothing if the
    # path is not one full mode would sync. Order matters: SYNC_DIRS subtrees are
    # matched before the top-level .claude/*.md rule (case '*' spans '/').
    changed_map_target() {
        local p="$1" rest skip
        case "$p" in
            # rules-src -> rules. Must be matched BEFORE the same-name subtrees.
            # Deliberately NO `.claude/rules/*` case: that path is no longer a sync
            # source, so the 46 D-entries produced by the rules -> rules-src rename
            # map to nothing and cannot delete ~/.claude/rules/. That matters because
            # renames are not detected here (no -M): a move appears as D(old)+A(new),
            # and `.claude/rules-src/x` sorts BEFORE `.claude/rules/x` ('-' < '/'),
            # so the add would be copied and the delete would then remove it.
            .claude/rules-src/*)
                changed_is_excluded "$p" && return 0
                printf '%s\n' "$ACTIVE_CLAUDE/rules/${p#.claude/rules-src/}"
                ;;
            .claude/agents/*|.claude/skills/*|.claude/scripts/*|.claude/docs/*)
                changed_is_excluded "$p" && return 0
                printf '%s\n' "$ACTIVE_CLAUDE/${p#.claude/}"
                ;;
            .claude/hooks/dist/*.mjs)
                rest="${p#.claude/hooks/dist/}"
                [[ "$rest" == */* ]] && return 0   # top-level dist only
                printf '%s\n' "$ACTIVE_CLAUDE/hooks/dist/$rest"
                ;;
            .claude/hooks/*.sh|.claude/hooks/*.py|.claude/hooks/*.mjs|.claude/hooks/*.ps1|.claude/hooks/package.json|.claude/hooks/tsconfig.json)
                rest="${p#.claude/hooks/}"
                [[ "$rest" == */* ]] && return 0   # top-level hooks/ files only (hooks/src excluded)
                printf '%s\n' "$ACTIVE_CLAUDE/hooks/$rest"
                ;;
            .claude/templates/ralph/*)
                rest="${p#.claude/templates/ralph/}"
                [[ "$rest" == */* ]] && return 0   # files directly under templates/ralph
                printf '%s\n' "$ACTIVE_CLAUDE/templates/ralph/$rest"
                ;;
            .claude/*.md)
                rest="${p#.claude/}"
                [[ "$rest" == */* ]] && return 0   # top-level .claude/*.md only
                for skip in $NEVER_SYNC; do
                    [[ "$rest" == "$skip" ]] && return 0
                done
                printf '%s\n' "$ACTIVE_CLAUDE/$rest"
                ;;
            opc/scripts/core/project_memory.py)
                printf '%s\n' "$ACTIVE_CLAUDE/scripts/core/project_memory.py"
                ;;
            .claude/project-registry.json)
                printf '%s\n' "$ACTIVE_CLAUDE/project-registry.json"
                ;;
        esac
        return 0
    }

    # Content-guarded copy: only writes when src/dst differ (or dst is missing).
    changed_copy_one() {
        local src="$1" dst="$2"
        [[ -f "$src" ]] || return 0
        if $DRY_RUN; then
            echo "[DRY RUN] Would copy: $src -> $dst"
        else
            mkdir -p "$(dirname "$dst")"
            cmp -s "$src" "$dst" 2>/dev/null || cp "$src" "$dst"
            $VERBOSE && echo "Copied: ${dst#$ACTIVE_CLAUDE/}" || true
        fi
    }

    while IFS=$'\t' read -r status path _rest; do
        [[ -z "$status" || -z "$path" ]] && continue
        st="${status:0:1}"
        dst="$(changed_map_target "$path")"
        [[ -z "$dst" ]] && continue

        case "$path" in
            .claude/agents/*.md) AGENT_MD_PATHS+=("$path") ;;
        esac
        [[ "$path" == ".claude/settings.json" ]] && SETTINGS_CHANGED=true

        if [[ "$st" == "D" ]]; then
            # Load-bearing singleton: never auto-delete the active registry mirror
            # (memory scoping + roadmap contamination guard read it).
            if [[ "$path" == ".claude/project-registry.json" ]]; then
                echo "  WARNING: project-registry.json deleted in repo -- active mirror kept"
                continue
            fi
            # Conservative delete: only within the active subtree we just mapped.
            # (Full mode never deletes; this is a strict, scoped improvement.)
            case "$dst" in
                "$ACTIVE_CLAUDE"/*)
                    if [[ -e "$dst" ]]; then
                        if $DRY_RUN; then
                            echo "[DRY RUN] Would delete: $dst"
                        else
                            rm -f "$dst"
                            $VERBOSE && echo "Deleted: ${dst#$ACTIVE_CLAUDE/}" || true
                        fi
                    fi
                    ;;
            esac
        elif [[ "$path" == ".claude/project-registry.json" ]]; then
            copy_registry
        else
            changed_copy_one "$REPO_ROOT/$path" "$dst"
        fi
    done < <(git -C "$REPO_ROOT" diff-tree --no-commit-id --name-status -r HEAD 2>/dev/null)

    # Conditional agent .json sidecar regen -- only when an agent .md changed
    # (full mode runs it unconditionally). The regen writes .json into the repo
    # agents dir, which the diff set above does NOT include, so we then copy the
    # freshly-regenerated sibling .json sidecars into the active tree.
    if [[ ${#AGENT_MD_PATHS[@]} -gt 0 && -f "$SYNC_AGENT_JSON" ]]; then
        if $DRY_RUN; then
            echo "[DRY RUN] Would regenerate agent .json sidecars from .md frontmatter"
        else
            $VERBOSE && echo "Regenerating agent .json sidecars..." || true
            python "$SYNC_AGENT_JSON" --target "$REPO_CLAUDE/agents" --apply \
                $( $VERBOSE && echo "--verbose" || true ) 2>&1 \
                | python -c "import json,sys; d=json.load(sys.stdin); print(f'  agent-json-sync: {d[\"summary\"][\"updated\"]} updated, {d[\"summary\"][\"no_change\"]} unchanged')" \
                || echo "  Warning: agent .json sidecar sync failed (non-fatal)"
        fi
        for md_path in "${AGENT_MD_PATHS[@]}"; do
            json_dst="$(changed_map_target "${md_path%.md}.json")"
            [[ -n "$json_dst" ]] && changed_copy_one "$REPO_ROOT/${md_path%.md}.json" "$json_dst"
        done
    fi

    # Conditional mcpServers merge -- mirrors the full-mode merge block, run only
    # when .claude/settings.json changed (settings.json itself is NEVER_SYNC; only
    # its mcpServers key is merged into the active settings.json).
    if $SETTINGS_CHANGED && ! $DRY_RUN && command -v jq &> /dev/null; then
        REPO_SETTINGS="$REPO_CLAUDE/settings.json"
        ACTIVE_SETTINGS="$ACTIVE_CLAUDE/settings.json"
        if [[ -f "$REPO_SETTINGS" && -f "$ACTIVE_SETTINGS" ]]; then
            MCP_SERVERS=$(jq '.mcpServers // empty' "$REPO_SETTINGS" 2>/dev/null) || MCP_SERVERS=""
            if [[ -n "$MCP_SERVERS" && "$MCP_SERVERS" != "null" ]]; then
                TEMP_SETTINGS=$(mktemp)
                if jq --argjson mcp "$MCP_SERVERS" '.mcpServers = $mcp' "$ACTIVE_SETTINGS" > "$TEMP_SETTINGS" 2>/dev/null && [[ -s "$TEMP_SETTINGS" ]]; then
                    mv "$TEMP_SETTINGS" "$ACTIVE_SETTINGS"
                    $VERBOSE && echo "Merged mcpServers into ~/.claude/settings.json" || true
                else
                    rm -f "$TEMP_SETTINGS"
                    $VERBOSE && echo "Warning: Failed to merge mcpServers" || true
                fi
            fi
        fi
    fi

    $VERBOSE && echo "Incremental sync complete: continuous-claude -> ~/.claude" || true
    exit 0
fi

# Regenerate .json sidecars from .md frontmatter before copying agents.
# This ensures any .md edits are reflected in the .json files that claude_spawn.py reads.
SYNC_AGENT_JSON="$SCRIPT_DIR/sync-agent-json.py"
if [[ -f "$SYNC_AGENT_JSON" ]]; then
    if $DRY_RUN; then
        echo "[DRY RUN] Would regenerate agent .json sidecars from .md frontmatter"
    else
        $VERBOSE && echo "Regenerating agent .json sidecars..." || true
        python "$SYNC_AGENT_JSON" --target "$REPO_CLAUDE/agents" --apply \
            $( $VERBOSE && echo "--verbose" || true ) 2>&1 \
            | python -c "import json,sys; d=json.load(sys.stdin); print(f'  agent-json-sync: {d[\"summary\"][\"updated\"]} updated, {d[\"summary\"][\"no_change\"]} unchanged')" \
            || echo "  Warning: agent .json sidecar sync failed (non-fatal)"
    fi
fi

for dir in $SYNC_DIRS; do
    copy_dir "$dir"
done

# rules: repo .claude/rules-src/ -> active ~/.claude/rules/ (see SYNC_DIRS note).
copy_dir "$RULES_SRC_DIR" "$RULES_DST_DIR"

# Sync the project registry (repo canonical -> active mirror, JSON-validated)
copy_registry

# Sync top-level .claude/*.md files (canonical entry points / redirect stubs)
# mkdir -p the target root first -- a fresh-install machine may not have ~/.claude/
# yet, and `cp file dir/` requires the dir to exist.
$DRY_RUN || mkdir -p "$ACTIVE_CLAUDE"
for src_file in "$REPO_CLAUDE"/*.md; do
    [[ ! -f "$src_file" ]] && continue
    base=$(basename "$src_file")
    skip_file=false
    for skip in $NEVER_SYNC; do
        [[ "$base" == "$skip" ]] && skip_file=true && break
    done
    $skip_file && continue
    dst_file="$ACTIVE_CLAUDE/$base"
    if $DRY_RUN; then
        echo "[DRY RUN] Would copy: $src_file -> $dst_file"
    else
        cp "$src_file" "$dst_file"
        $VERBOSE && echo "Copied: $base" || true
    fi
done

for pattern in "hooks/*.sh" "hooks/*.py" "hooks/*.mjs" "hooks/*.ps1" "hooks/package.json" "hooks/tsconfig.json"; do
    for src_file in $REPO_CLAUDE/$pattern; do
        [[ ! -f "$src_file" ]] && continue
        rel="${src_file#$REPO_CLAUDE/}"
        dst_file="$ACTIVE_CLAUDE/$rel"

        if $DRY_RUN; then
            echo "[DRY RUN] Would copy: $src_file -> $dst_file"
        else
            mkdir -p "$(dirname "$dst_file")"
            cp "$src_file" "$dst_file"
            $VERBOSE && echo "Copied: $rel" || true
        fi
    done
done

# Sync hooks/dist/*.mjs (built hook bundles)
DIST_SRC="$REPO_CLAUDE/hooks/dist"
DIST_DST="$ACTIVE_CLAUDE/hooks/dist"
if [[ -d "$DIST_SRC" ]]; then
    $DRY_RUN || mkdir -p "$DIST_DST"
    for src_file in "$DIST_SRC"/*.mjs; do
        [[ ! -f "$src_file" ]] && continue
        local_name=$(basename "$src_file")
        dst_file="$DIST_DST/$local_name"
        if $DRY_RUN; then
            echo "[DRY RUN] Would copy: $src_file -> $dst_file"
        else
            cp "$src_file" "$dst_file"
            $VERBOSE && echo "Copied: hooks/dist/$local_name" || true
        fi
    done
fi

# Sync templates/ralph/ (prompt templates for Ralph agents)
TEMPLATES_SRC="$REPO_CLAUDE/templates/ralph"
TEMPLATES_DST="$ACTIVE_CLAUDE/templates/ralph"
if [[ -d "$TEMPLATES_SRC" ]]; then
    $DRY_RUN || mkdir -p "$TEMPLATES_DST"
    for src_file in "$TEMPLATES_SRC"/*; do
        [[ ! -f "$src_file" ]] && continue
        local_name=$(basename "$src_file")
        dst_file="$TEMPLATES_DST/$local_name"
        if $DRY_RUN; then
            echo "[DRY RUN] Would copy: $src_file -> $dst_file"
        else
            cp "$src_file" "$dst_file"
            $VERBOSE && echo "Copied: templates/ralph/$local_name" || true
        fi
    done
fi

# Sync opc/scripts/core/project_memory.py → scripts/core/ (needed by memory-awareness.ts)
CORE_SRC="$REPO_ROOT/opc/scripts/core/project_memory.py"
CORE_DST="$ACTIVE_CLAUDE/scripts/core/project_memory.py"
if [[ -f "$CORE_SRC" ]]; then
    $DRY_RUN || mkdir -p "$(dirname "$CORE_DST")"
    if $DRY_RUN; then
        echo "[DRY RUN] Would copy: $CORE_SRC -> $CORE_DST"
    else
        cp "$CORE_SRC" "$CORE_DST"
        $VERBOSE && echo "Copied: opc/scripts/core/project_memory.py -> scripts/core/project_memory.py" || true
    fi
fi

# Sync scripts/ralph/*.py (create target directory if needed for fresh installs)
RALPH_SRC="$REPO_CLAUDE/scripts/ralph"
RALPH_DST="$ACTIVE_CLAUDE/scripts/ralph"
if [[ -d "$RALPH_SRC" ]]; then
    $DRY_RUN || mkdir -p "$RALPH_DST"
    for src_file in "$RALPH_SRC"/*.py; do
        [[ ! -f "$src_file" ]] && continue
        local_name=$(basename "$src_file")
        dst_file="$RALPH_DST/$local_name"
        if $DRY_RUN; then
            echo "[DRY RUN] Would copy: $src_file -> $dst_file"
        else
            cp "$src_file" "$dst_file"
            $VERBOSE && echo "Copied: scripts/ralph/$local_name" || true
        fi
    done
fi

# Build step removed (CCv3 WS-0.3 structural fix): dist is pre-built in the repo and copied to active by the hooks/dist block above. No build-from-active-src.

# Merge mcpServers from repo settings.json into active settings.json
# This preserves machine-specific settings while syncing MCP server config
if ! $DRY_RUN && command -v jq &> /dev/null; then
    REPO_SETTINGS="$REPO_CLAUDE/settings.json"
    ACTIVE_SETTINGS="$ACTIVE_CLAUDE/settings.json"

    if [[ -f "$REPO_SETTINGS" && -f "$ACTIVE_SETTINGS" ]]; then
        # Extract mcpServers from repo and merge into active.
        # Both jq calls run under `set -e`, so a malformed JSON file would
        # abort the entire sync before reaching the cleanup paths below.
        # The `|| MCP_SERVERS=""` and `if jq ...; then` forms keep set -e
        # from killing the script on a non-zero jq exit -- we want a
        # graceful skip instead.
        MCP_SERVERS=$(jq '.mcpServers // empty' "$REPO_SETTINGS" 2>/dev/null) || MCP_SERVERS=""
        if [[ -n "$MCP_SERVERS" && "$MCP_SERVERS" != "null" ]]; then
            # Create temp file with merged content
            TEMP_SETTINGS=$(mktemp)
            if jq --argjson mcp "$MCP_SERVERS" '.mcpServers = $mcp' "$ACTIVE_SETTINGS" > "$TEMP_SETTINGS" 2>/dev/null && [[ -s "$TEMP_SETTINGS" ]]; then
                mv "$TEMP_SETTINGS" "$ACTIVE_SETTINGS"
                $VERBOSE && echo "Merged mcpServers into ~/.claude/settings.json" || true
            else
                rm -f "$TEMP_SETTINGS"
                $VERBOSE && echo "Warning: Failed to merge mcpServers" || true
            fi
        fi
    fi
elif ! $DRY_RUN; then
    $VERBOSE && echo "Note: jq not installed, skipping mcpServers merge" || true
fi

# Verification: compare file counts between source and target
if ! $DRY_RUN; then
    VERIFY_FAIL=0
    echo "Verification:"

    verify_dir() {
        local label="$1" src_dir="$2" dst_dir="$3" pattern="$4"
        if [[ ! -d "$src_dir" ]]; then
            return 0
        fi
        if [[ ! -d "$dst_dir" ]]; then
            echo "  $label: SKIPPED (target dir absent)"
            return 0
        fi
        local src_count dst_count
        if [[ -n "$pattern" ]]; then
            src_count=$(find "$src_dir" -maxdepth 1 -name "$pattern" -type f 2>/dev/null | wc -l)
            dst_count=$(find "$dst_dir" -maxdepth 1 -name "$pattern" -type f 2>/dev/null | wc -l)
        else
            src_count=$(find "$src_dir" -type f ! -name "*.pid" ! -name "*.lock" ! -path "*/.tldr/*" ! -path "*/node_modules/*" ! -path "*/cache/*" ! -path "*/dist/*" 2>/dev/null | wc -l)
            dst_count=$(find "$dst_dir" -type f ! -name "*.pid" ! -name "*.lock" ! -path "*/.tldr/*" ! -path "*/node_modules/*" ! -path "*/cache/*" ! -path "*/dist/*" 2>/dev/null | wc -l)
        fi
        src_count=$(echo "$src_count" | tr -d ' ')
        dst_count=$(echo "$dst_count" | tr -d ' ')
        if [[ "$src_count" -eq "$dst_count" ]]; then
            echo "  $label: OK ($src_count files)"
        else
            echo "  $label: MISMATCH (source=$src_count, target=$dst_count)"
            VERIFY_FAIL=1
        fi
    }

    for dir in $SYNC_DIRS; do
        verify_dir "$dir" "$REPO_CLAUDE/$dir" "$ACTIVE_CLAUDE/$dir"
    done
    verify_dir "hooks/dist (*.mjs)" "$REPO_CLAUDE/hooks/dist" "$ACTIVE_CLAUDE/hooks/dist" "*.mjs"
    verify_dir "scripts/ralph (*.py)" "$REPO_CLAUDE/scripts/ralph" "$ACTIVE_CLAUDE/scripts/ralph" "*.py"
    verify_dir "templates/ralph" "$REPO_CLAUDE/templates/ralph" "$ACTIVE_CLAUDE/templates/ralph"

    if [[ "$VERIFY_FAIL" -eq 1 ]]; then
        echo "  WARNING: Some directories have file count mismatches"
    fi
fi

$VERBOSE && echo "Sync complete: continuous-claude -> ~/.claude" || true
