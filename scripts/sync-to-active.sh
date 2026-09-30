#!/usr/bin/env bash
# Sync continuous-claude/.claude/ → ~/.claude/ (forward sync)
# Run after git pull or local edits in continuous-claude

set -e

# Git exports GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE into hooks. Every git call below
# names its repo with -C, so inherited values could only point it at the wrong one.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX GIT_NAMESPACE

SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
REPO_CLAUDE="$REPO_ROOT/.claude"
ACTIVE_CLAUDE="$HOME/.claude"

# WSL refusal: on this machine `bash` on PATH is the WSL launcher (HOME=/home/<user>),
# so a manual `bash scripts/sync-to-active.sh` from PowerShell syncs into the WSL
# filesystem and prints plausible OK lines while the Windows ~/.claude is untouched
# (proven 2026-08-14, commit 32e8d47 memory). It would also build a bogus clobber-guard
# manifest there. Refuse outright; plain non-WSL Linux still passes.
if [[ "$(uname -s 2>/dev/null)" == Linux* ]] && grep -qi microsoft /proc/version 2>/dev/null; then
    echo "ERROR: running under WSL bash -- this would sync into the WSL filesystem, not the Windows ~/.claude." >&2
    echo "       Re-run under Git Bash (it has node and the real \$HOME), e.g.:" >&2
    echo "       \"C:\\Users\\<you>\\AppData\\Local\\Programs\\Git\\bin\\bash.exe\" scripts/sync-to-active.sh" >&2
    exit 1
fi

# The clobber guard hashes every file it touches; sha256sum ships with Git Bash.
if ! command -v sha256sum >/dev/null 2>&1; then
    echo "ERROR: sha256sum not found -- the clobber guard cannot run. Use Git Bash." >&2
    exit 1
fi

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

# -----------------------------------------------------------------------------
# Branch guard: only `main` in the primary checkout syncs to ~/.claude.
# The post-commit hook runs this script from whatever checkout made the commit,
# so a commit on a feature branch -- or in a linked worktree -- used to push that
# branch's hooks and rules live before anyone reviewed them (found by the
# 2026-09-23 Opus 5.5 eval). Now those runs are skipped; merge to main, then
# sync. The cursor below makes that first sync on main pick up everything the
# merge brought in. Override for a deliberate branch sync: SYNC_ALLOW_BRANCH=1.
# A REPO_ROOT that is not a git checkout (a fixture, an unpacked copy) passes.
# -----------------------------------------------------------------------------
SYNC_ON_MAIN=true
if git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    sync_branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
    sync_gitdir="$(git -C "$REPO_ROOT" rev-parse --git-dir 2>/dev/null || echo '')"
    sync_common="$(git -C "$REPO_ROOT" rev-parse --git-common-dir 2>/dev/null || echo '')"
    [[ "$sync_branch" == "main" && "$sync_gitdir" == "$sync_common" ]] || SYNC_ON_MAIN=false
    # SYNC_MAIN_DETACHED=1 (set by land-pr.ps1): a detached linked worktree checked out AT the
    # commit main points to counts as main, so it syncs AND moves the cursor. land-pr uses one
    # when the primary checkout sits on a feature branch. A named branch, or a detached HEAD at any
    # other commit, is still skipped. Unlike SYNC_ALLOW_BRANCH this is safe to advance the cursor:
    # the content is exactly main's.
    if ! $SYNC_ON_MAIN && [[ "${SYNC_MAIN_DETACHED:-0}" == "1" && "$sync_branch" == "HEAD" ]]; then
        sync_head_sha="$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo '')"
        sync_main_sha="$(git -C "$REPO_ROOT" rev-parse refs/heads/main 2>/dev/null || echo 'none')"
        [[ -n "$sync_head_sha" && "$sync_head_sha" == "$sync_main_sha" ]] && SYNC_ON_MAIN=true
    fi
fi
if ! $SYNC_ON_MAIN && [[ "${SYNC_ALLOW_BRANCH:-0}" != "1" ]] && ! $DRY_RUN; then
    echo "Sync skipped: '$sync_branch' is not main in the primary checkout. Merge to main, then run scripts/sync-to-active.sh --changed (override: SYNC_ALLOW_BRANCH=1)."
    exit 0
fi

# Last commit this script synced successfully. --changed diffs from here to HEAD,
# so commits that a skipped or locked-out run missed are caught up next time.
CURSOR_FILE="$ACTIVE_CLAUDE/state/sync-cursor"
PENDING_FILE="$ACTIVE_CLAUDE/.sync.pending"

repo_head() { git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || true; }

# Written only after a run finishes copying, so a killed run leaves the old cursor
# and the next run simply redoes the range (copies are idempotent). Only a run on
# main moves it: an override sync from a branch must not, or the later sync of the
# merge would diff from the branch commit and skip what the branch brought in.
write_cursor() {
    local sha="$1"
    [[ -z "$sha" ]] && return 0
    $DRY_RUN && return 0
    $SYNC_ON_MAIN || return 0
    mkdir -p "$(dirname "$CURSOR_FILE")" 2>/dev/null || true
    printf '%s\n' "$sha" > "$CURSOR_FILE.tmp" && mv -f "$CURSOR_FILE.tmp" "$CURSOR_FILE"
}

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
# `commands` added 2026-07-29. The 59 slash commands had existed ONLY in
# ~/.claude/commands -- one untracked copy on one machine. They are now committed,
# but a committed copy that nothing propagates is a second source of truth waiting
# to drift, which is the exact failure the rules-src rename above was fixing.
# Safe to add: repo and active were verified hash-identical (58/58) when the backup
# landed, so the first forward sync copies nothing.
# rules-ondemand (2026-09-24): tool-specific rules the rule-router hook loads at the action.
# Same name in repo and active, and deliberately NOT under rules/, so nothing auto-loads them.
SYNC_DIRS="agents skills scripts docs commands rules-ondemand"

# Explicit source->dest mapping for the rules tree (names differ, see above).
RULES_SRC_DIR="rules-src"
RULES_DST_DIR="rules"

NEVER_SYNC="CLAUDE.md RULES.md .env .credentials.json settings.json history.jsonl knowledge-tree.json"

# -----------------------------------------------------------------------------
# Clobber guard (2026-08-31, harness-security lane).
#
# The forward sync destroyed active-only rule edits on 2026-08-30 (recovered in
# e56c343): every copy site blindly overwrote the active file, so an edit made
# directly in ~/.claude was silently lost on the next sync. The guard keeps a
# manifest of the sha256 each destination had the last time THIS script wrote it.
# On the next sync, three cases per file:
#   dst == src                      -> identical, record hash, no copy
#   dst == manifest entry           -> active is merely stale; normal forward copy
#   dst != src AND != manifest (or  -> ACTIVE WAS EDITED SINCE LAST SYNC:
#     no entry; fail-safe)             quarantine the active copy, THEN copy,
#                                      report loudly. Never silently overwrite.
# Sequencing is crash-safe (Codex premortem finding): the repo version is staged
# as dst.sync-tmp first, the quarantine copy is hash-verified, and only then is
# the staged file atomically renamed over dst. The active file is never missing
# or half-written; if quarantine fails the active file is left untouched.
# The quarantine dir is the ONLY copy of a clobbered edit -- never auto-purged.
# Manifest: TAB-separated "sha256<TAB>active-relative-path", pruned (full mode
# only) to paths visited this run so retired sync sources can't go stale.
# -----------------------------------------------------------------------------
MANIFEST_FILE="$ACTIVE_CLAUDE/state/sync-manifest.txt"
QUARANTINE_ROOT="$ACTIVE_CLAUDE/.sync-quarantine/$(date +%Y-%m-%d-%H%M%S)"
QUARANTINED=0
GUARD_ERRORS=0
declare -A MANIFEST
declare -A SEEN

file_hash() {
    sha256sum "$1" | cut -d' ' -f1
}

load_manifest() {
    [[ -f "$MANIFEST_FILE" ]] || return 0
    local h r
    while IFS=$'\t' read -r h r; do
        [[ "$h" == \#* || -z "$h" || -z "$r" ]] && continue
        MANIFEST["$r"]="$h"
    done < "$MANIFEST_FILE"
}

manifest_set() {
    MANIFEST["$1"]="$2"
    SEEN["$1"]=1
}

manifest_unset() {
    unset "MANIFEST[$1]" 2>/dev/null || true
}

save_manifest() {
    $DRY_RUN && return 0
    mkdir -p "$(dirname "$MANIFEST_FILE")"
    local tmp="$MANIFEST_FILE.tmp.$$" r
    {
        echo $'# sync-manifest v1 -- sha256\tactive-relative-path (written by sync-to-active.sh)'
        if $CHANGED; then
            # Incremental run only visits changed files -- merge, never prune.
            for r in "${!MANIFEST[@]}"; do printf '%s\t%s\n' "${MANIFEST[$r]}" "$r"; done
        else
            # Full mirror visits every sync source -- prune to what was visited.
            for r in "${!SEEN[@]}"; do printf '%s\t%s\n' "${MANIFEST[$r]}" "$r"; done
        fi
    } | sort -t$'\t' -k2 > "$tmp"
    mv -f "$tmp" "$MANIFEST_FILE"
}

# guarded_copy <src> <dst> -- the ONLY way this script writes a destination file.
guarded_copy() {
    local src="$1" dst="$2"
    [[ -f "$src" ]] || return 0
    local rel="${dst#$ACTIVE_CLAUDE/}"
    if $DRY_RUN; then
        echo "[DRY RUN] Would copy: $src -> $dst"
        return 0
    fi
    mkdir -p "$(dirname "$dst")"
    if [[ ! -f "$dst" ]]; then
        cp "$src" "$dst"
        manifest_set "$rel" "$(file_hash "$dst")"
        $VERBOSE && echo "Copied: $rel" || true
        return 0
    fi
    if cmp -s "$src" "$dst"; then
        # Identical: keep the existing manifest entry instead of rehashing --
        # a sha256sum spawn per file made the full mirror take >10 min on this
        # box (spawn latency, see windows-platform.md). A stale entry is
        # harmless in the fail-safe direction: a later divergence that doesn't
        # match it quarantines rather than clobbers.
        if [[ -n "${MANIFEST[$rel]-}" ]]; then
            SEEN["$rel"]=1
        else
            manifest_set "$rel" "$(file_hash "$src")"
        fi
        return 0
    fi
    local src_hash dst_hash known
    src_hash=$(file_hash "$src")
    dst_hash=$(file_hash "$dst")
    known="${MANIFEST[$rel]-}"
    if [[ -n "$known" && "$dst_hash" == "$known" ]]; then
        # Active copy is exactly what we last wrote -- normal forward update.
        cp "$src" "$dst.sync-tmp"
        mv -f "$dst.sync-tmp" "$dst"
        manifest_set "$rel" "$src_hash"
        $VERBOSE && echo "Copied: $rel" || true
        return 0
    fi
    # CLOBBER RISK: active file was edited since last sync (or is unknown to the
    # manifest -- fail-safe treats unknown as edited). Quarantine, then copy.
    cp "$src" "$dst.sync-tmp"
    mkdir -p "$QUARANTINE_ROOT/$(dirname "$rel")"
    cp "$dst" "$QUARANTINE_ROOT/$rel"
    if [[ "$(file_hash "$QUARANTINE_ROOT/$rel")" != "$dst_hash" ]]; then
        rm -f "$dst.sync-tmp"
        echo "  CLOBBER-GUARD ERROR: quarantine copy failed for $rel -- active file left untouched, NOT synced"
        GUARD_ERRORS=$((GUARD_ERRORS + 1))
        return 0
    fi
    mv -f "$dst.sync-tmp" "$dst"
    manifest_set "$rel" "$src_hash"
    echo "  CLOBBER-GUARD: active copy of $rel had diverged -- preserved at $QUARANTINE_ROOT/$rel"
    QUARANTINED=$((QUARANTINED + 1))
}

print_guard_summary() {
    if [[ "$QUARANTINED" -gt 0 || "$GUARD_ERRORS" -gt 0 ]]; then
        echo ""
        echo "CLOBBER-GUARD SUMMARY: $QUARANTINED file(s) had diverged active edits, preserved under:"
        echo "  $QUARANTINE_ROOT"
        [[ "$GUARD_ERRORS" -gt 0 ]] && echo "  $GUARD_ERRORS file(s) NOT synced (quarantine failed) -- resolve manually"
        echo "  Review, salvage what you need, then delete that dir yourself. It is never auto-purged."
    fi
    # A quarantine FAILURE means files were left unsynced -- automated callers
    # (health_check drift remediation) must see a non-zero exit, not success.
    [[ "$GUARD_ERRORS" -gt 0 ]] && return 1
    return 0
}

load_manifest

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
    # Distinguish "cannot validate" from "invalid". Conflating them cost a real
    # diagnosis on 2026-07-29: this printed "invalid JSON" for a file that node
    # and PowerShell both parse fine. The actual cause is which bash is running.
    # On this machine `bash` on PATH is WSL (C:\WINDOWS\system32\bash.exe), which
    # has NO node and uses /mnt/c paths; git's hooks use Git Bash, which has node
    # at /c/Program Files/nodejs. So a manual `bash scripts/sync-to-active.sh`
    # silently skipped the registry while blaming the file, and the post-commit
    # path synced it correctly -- which is why nobody noticed.
    if ! command -v node >/dev/null 2>&1; then
        echo "  WARNING: node not on PATH in this shell -- cannot validate project-registry.json, NOT synced"
        echo "           (if this is WSL bash, re-run under Git Bash: it has node)"
        return 0
    fi
    if ! node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$src" 2>/dev/null; then
        echo "  WARNING: repo project-registry.json is invalid JSON -- NOT synced"
        return 0
    fi
    mkdir -p "$ACTIVE_CLAUDE"
    guarded_copy "$src" "$dst"
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

        guarded_copy "$src_file" "$dst_file"
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
        LOCK_HELD=false
    fi
    return 0
}

# End of every run. The cursor moves only when the clobber guard reported no failed
# copy (a failed file would otherwise never be retried). Then the lock is released and,
# if a commit queued itself (pending marker) while we held it, this script runs again
# for it -- checked AFTER the release, so no commit can slip in between the last check
# and the release and wait for some later, unrelated sync.
finish_sync() {
    local target="$1" guard_rc=0
    save_manifest
    print_guard_summary || guard_rc=$?
    [[ $guard_rc -eq 0 ]] && write_cursor "$target"
    release_lock
    [[ $guard_rc -ne 0 ]] && exit 3
    if ! $DRY_RUN && [[ -e "$PENDING_FILE" ]]; then
        rm -f "$PENDING_FILE"
        $VERBOSE && echo "A commit queued during this run; syncing it now." || true
        exec bash "$SCRIPT_DIR/$(basename "$0")" --changed $( $VERBOSE && echo --verbose || true )
    fi
    exit 0
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
        # Leave a marker instead of dropping this commit: the lock holder re-checks
        # it before exiting and syncs whatever landed meanwhile (cursor..HEAD).
        : > "$PENDING_FILE" 2>/dev/null || true
        # The holder may have released the lock (and made its final pending check) between our
        # failed mkdir and the marker write. Then nobody would see the marker, so take the lock
        # and do the sync ourselves (CodeRabbit #46).
        if [[ ! -d "$LOCK_DIR" ]] && mkdir "$LOCK_DIR" 2>/dev/null; then
            LOCK_HELD=true
            trap release_lock EXIT
            rm -f "$PENDING_FILE"
        else
            $VERBOSE && echo "Another sync is already running (lock held); queued for it." || true
            exit 0
        fi
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
            .claude/agents/*|.claude/skills/*|.claude/scripts/*|.claude/docs/*|.claude/rules-ondemand/*)
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

    # Content- AND clobber-guarded copy (routes through guarded_copy).
    changed_copy_one() {
        guarded_copy "$1" "$2"
    }

    # Sync every path that changed between two commits ($1 = base, $2 = target).
    changed_sync_range() {
    local range_base="$1" range_target="$2"
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
                            manifest_unset "${dst#$ACTIVE_CLAUDE/}"
                            $VERBOSE && echo "Deleted: ${dst#$ACTIVE_CLAUDE/}" || true
                            # Remove parent dirs the delete left empty (a deleted skill
                            # used to leave an empty skills/<name>/ behind). Stops below
                            # the top-level subtree, so ~/.claude/skills itself is kept.
                            prune_dir="$(dirname "$dst")"
                            while [[ "$prune_dir" == "$ACTIVE_CLAUDE"/*/* ]] && rmdir "$prune_dir" 2>/dev/null; do
                                prune_dir="$(dirname "$prune_dir")"
                            done
                        fi
                    fi
                    ;;
            esac
        elif [[ "$path" == ".claude/project-registry.json" ]]; then
            copy_registry
        else
            changed_copy_one "$REPO_ROOT/$path" "$dst"
        fi
    # Explicit HEAD^1..HEAD: a plain `diff-tree HEAD` prints NOTHING for a merge
    # commit, so after fast-forwarding to a PR merge this synced 0 of 177
    # changed files (2026-09-22, PR #39). Do not use `-m --first-parent`:
    # diff-tree ignores --first-parent and -m then diffs against EVERY parent
    # (merge 2f5c761: 32 paths vs 10 from the first parent). Two explicit trees
    # give exactly what the commit or merge brought in; for an ordinary commit
    # this equals the old form. A root commit has no HEAD^1 and syncs nothing,
    # as before. The base is now the sync cursor when it is valid (see below).
    done < <(git -C "$REPO_ROOT" diff-tree --no-commit-id --name-status -r "$range_base" "$range_target" 2>/dev/null)
    }

    # Base: the cursor when it is an ancestor of HEAD, else HEAD^1 (first run, or
    # the cursor file is missing). A cursor that is NOT an ancestor (main was reset
    # or rewritten) means the diff cannot be trusted, so fall back to the full
    # mirror below instead of guessing.
    sync_target="$(repo_head)"
    sync_base=""
    if [[ -s "$CURSOR_FILE" ]]; then
        sync_cursor="$(tr -d '\r\n ' < "$CURSOR_FILE")"
        if git -C "$REPO_ROOT" merge-base --is-ancestor "$sync_cursor" HEAD 2>/dev/null; then
            sync_base="$sync_cursor"
        else
            echo "  Sync cursor $sync_cursor is not an ancestor of HEAD; running the full mirror instead."
            echo "  The full mirror never deletes: files removed from main since that cursor may remain in ~/.claude. Run /sync-drift to find them."
            CHANGED=false
        fi
    else
        sync_base="HEAD^1"
    fi
fi

if $CHANGED; then
    changed_sync_range "$sync_base" "$sync_target"

    # Commits that landed while we held the lock left a pending marker. Sync them
    # now rather than dropping them (the old lock-contention loss).
    while [[ -e "$PENDING_FILE" ]] && ! $DRY_RUN; do
        rm -f "$PENDING_FILE"
        next_target="$(repo_head)"
        [[ -z "$next_target" || "$next_target" == "$sync_target" ]] && break
        $VERBOSE && echo "Catching up queued commits: ${sync_target:0:7}..${next_target:0:7}" || true
        changed_sync_range "$sync_target" "$next_target"
        sync_target="$next_target"
    done

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
    finish_sync "$sync_target"
fi

# Full mirror: record the commit we START from. A commit that lands while the tree is
# being copied queues itself (pending marker) and is synced by finish_sync's re-run;
# recording HEAD at the END would mark that commit synced when some of its files
# were visited before it landed.
FULL_START="$(repo_head)"

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
    guarded_copy "$src_file" "$dst_file"
done

for pattern in "hooks/*.sh" "hooks/*.py" "hooks/*.mjs" "hooks/*.ps1" "hooks/package.json" "hooks/tsconfig.json"; do
    for src_file in $REPO_CLAUDE/$pattern; do
        [[ ! -f "$src_file" ]] && continue
        rel="${src_file#$REPO_CLAUDE/}"
        dst_file="$ACTIVE_CLAUDE/$rel"
        guarded_copy "$src_file" "$dst_file"
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
        guarded_copy "$src_file" "$dst_file"
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
        guarded_copy "$src_file" "$dst_file"
    done
fi

# Sync opc/scripts/core/project_memory.py → scripts/core/ (needed by memory-awareness.ts)
CORE_SRC="$REPO_ROOT/opc/scripts/core/project_memory.py"
CORE_DST="$ACTIVE_CLAUDE/scripts/core/project_memory.py"
guarded_copy "$CORE_SRC" "$CORE_DST"

# Sync scripts/ralph/*.py (create target directory if needed for fresh installs)
RALPH_SRC="$REPO_CLAUDE/scripts/ralph"
RALPH_DST="$ACTIVE_CLAUDE/scripts/ralph"
if [[ -d "$RALPH_SRC" ]]; then
    $DRY_RUN || mkdir -p "$RALPH_DST"
    for src_file in "$RALPH_SRC"/*.py; do
        [[ ! -f "$src_file" ]] && continue
        local_name=$(basename "$src_file")
        dst_file="$RALPH_DST/$local_name"
        guarded_copy "$src_file" "$dst_file"
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
finish_sync "$FULL_START"
