#!/bin/bash
# precommit-build-guard.sh
# Purpose: catch the "build-forget" deploy gap -- committing changed hook SOURCE
#          (.claude/hooks/src/**/*.ts) without the rebuilt dist (.claude/hooks/dist/*.mjs),
#          which leaves stale .mjs in ~/.claude/ after sync. See docs/ccv3-ws2-phaseB-plan.
#
# Contract (STATIC staleness check -- deliberately does NOT run `npm run build`):
#   `npm run build` HANGS in a git-hook shell on Windows (documented in .git/hooks/post-commit,
#   which is why post-commit passes --skip-build). A building guard would wedge every commit.
#   esbuild bundles shared/*.ts into the top-level entrypoints, so there is NO 1:1 src->dist map
#   -- hence the rule is "if any src .ts is staged, require >=1 dist .mjs ALSO staged", not per-file.
#
#   - staged .claude/hooks/src/**/*.ts (excluding __tests__/ and *.d.ts) AND no staged
#     .claude/hooks/dist/*.mjs                                              -> BLOCK (exit 1)
#   - same src staged WITH >=1 staged .claude/hooks/dist/*.mjs              -> ALLOW (exit 0)
#   - every staged src change leaves the emitted code unchanged vs HEAD      -> ALLOW (exit 0)
#     (scripts/hooks-src-comment-only.mjs runs both versions through esbuild's transform, the tool
#     that builds the dist. Comments, layout and TypeScript types are erased, so the dist cannot
#     change. Needs node + esbuild; a file that does not transform keeps the block.)
#   - anything else (docs-only, dist-only, test-only, d.ts-only, nothing)  -> ALLOW (exit 0)
#
# Escape hatch:  SKIP_BUILD_GUARD=1 git commit ...   (or `git commit --no-verify`)
# Fail-open: any internal/git error -> ALLOW (never wedge a commit).
# No toolchain dependency: pure git plumbing + bash (works even if node/npm are absent).
#
# Known limitations (accepted -- inherent to the "no npm build in-hook" constraint):
#   - Coarse satisfaction: any staged dist .mjs satisfies the check; it does NOT verify the
#     staged .mjs actually corresponds to the staged .ts. Staging an unrelated dist tweak
#     alongside a fresh src change would pass. Closing this would need a build-stamp manifest
#     (a checksum of src/*.ts written by the build + verified here) -- out of scope here.
#   - Diff filter is ACMR: a pure DELETION of a src .ts is not guarded (deleting source does
#     not require a NEW dist; the stale .mjs is cleaned on the next real build). Type-changes
#     (T) are likewise out of scope.
#   - Newline-in-filename paths (legal but exotic) are not handled by the line-based match;
#     this codebase has none. Use `git diff -z` + NUL processing if that ever changes.

# Escape hatch -- explicit opt-out.
if [ -n "${SKIP_BUILD_GUARD:-}" ]; then
  exit 0
fi

# Fail-open if we're somehow not in a git work tree.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  exit 0
fi

# Staged, present files (Added/Copied/Modified/Renamed). Fail-open on git error.
staged="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null)" || exit 0

# -----------------------------------------------------------------------------
# Ratchets that already existed but that nothing ran (2026-09-23 Opus 5.5 eval,
# P21). Each runs only when its paths are staged, and only if node is on PATH
# (fail-open otherwise). Escape hatch: SKIP_RATCHETS=1 git commit ...
#   - rules-src, CLAUDE/RULES templates, .claude/docs, project CLAUDE/AGENTS/CONTEXT/local, .claude/rules ->
#                    scripts/rules/context-budget-guard.mjs --repo --staged (counts the
#                    chars of the always-loaded set in the STAGED blobs)
#   - agents      -> scripts/check-agent-model-drift.mjs (two-tier model policy)
#   - skills      -> scripts/skills/audit-skills.mjs --staged (rules G01-G32, audits the INDEX)
# The agents check reads the working tree; if it differs from what is staged in
# those paths, the result is labelled as a working-tree check. The skills check
# exports the index, so an unstaged edit can neither block nor excuse a commit.
# -----------------------------------------------------------------------------
if [ "${SKIP_RATCHETS:-0}" != "1" ] && command -v node >/dev/null 2>&1; then
  root="$(git rev-parse --show-toplevel 2>/dev/null)"
  ratchet_fail=0
  run_ratchet() {  # $1 = label, $2 = pathspec for the unstaged-diff note, rest = command
    label="$1"; spec="$2"; shift 2
    # mktemp, not a predictable $$ path (a pre-created symlink could redirect the write).
    out="$(mktemp 2>/dev/null)" || { "$@" >/dev/null 2>&1 || ratchet_fail=1; return; }
    if ! "$@" >"$out" 2>&1; then
      echo "" >&2
      echo "BLOCKED by $label:" >&2
      sed 's/^/    /' "$out" >&2
      if [ -n "$spec" ] && ! git diff --quiet -- "$spec" 2>/dev/null; then
        echo "    (checked the working tree; it has unstaged changes under $spec)" >&2
      fi
      ratchet_fail=1
    fi
    rm -f "$out"
  }
  if printf '%s\n' "$staged" | grep -qE '^(AGENTS|CLAUDE|CONTEXT|CLAUDE\.local)\.md$|^\.claude/(CLAUDE\.md$|rules/|rules-src/|templates/(CLAUDE|RULES)\.md\.template|docs/)|^scripts/rules/context-budget'; then
    run_ratchet "context-budget-guard" "" node "$root/scripts/rules/context-budget-guard.mjs" --repo --staged
  fi
  if printf '%s\n' "$staged" | grep -qE '^\.claude/rules-ondemand/|^\.claude/rules-src/on-demand-rules\.md$|^scripts/rules/ondemand-index-check'; then
    run_ratchet "ondemand-index-check" ".claude/rules-ondemand" node "$root/scripts/rules/ondemand-index-check.mjs"
  fi
  if printf '%s\n' "$staged" | grep -q '^\.claude/agents/'; then
    run_ratchet "check-agent-model-drift" ".claude/agents" node "$root/scripts/check-agent-model-drift.mjs" "$root"
  fi
  if printf '%s\n' "$staged" | grep -qE '^\.claude/skills/|^scripts/skills/|^\.claude/settings\.json\.template$|^\.claude/agents/|^\.mcp\.json$'; then
    # --staged audits the git index (exported to a temp dir), not the working tree. The trigger
    # list must match STAGED_PATHS in scripts/skills/audit-skills.mjs: every input the gate reads
    # (G17 reads .claude/agents, G28 reads .mcp.json and the settings template).
    run_ratchet "audit-skills" "" node "$root/scripts/skills/audit-skills.mjs" --staged --quiet
  fi
  if [ "$ratchet_fail" -ne 0 ]; then
    echo "" >&2
    echo "  Fix the above, or bypass deliberately: SKIP_RATCHETS=1 git commit ..." >&2
    exit 1
  fi
fi

# Staged hook SOURCE .ts, excluding test files and type declarations.
src_ts="$(printf '%s\n' "$staged" \
  | grep -E '^\.claude/hooks/src/.*\.ts$' \
  | grep -v '/__tests__/' \
  | grep -v '\.d\.ts$')"

# No hook source staged -> nothing to guard.
if [ -z "$src_ts" ]; then
  exit 0
fi

# At least one src .ts staged -> require at least one rebuilt dist .mjs staged too.
dist_mjs="$(printf '%s\n' "$staged" | grep -E '^\.claude/hooks/dist/.*\.mjs$')"
if [ -n "$dist_mjs" ]; then
  exit 0
fi

# A change that only touches comments, whitespace or TypeScript types cannot change the built dist
# (esbuild erases all three), so there is nothing to rebuild or stage. The helper proves it by
# comparing the esbuild output of both versions; anything it cannot prove (code change, import path
# change, new file, legal comment, no node/esbuild) keeps the block below.
helper="$(dirname "${BASH_SOURCE[0]}")/hooks-src-comment-only.mjs"
if command -v node >/dev/null 2>&1 && [ -f "$helper" ]; then
  mapfile -t src_files <<< "$src_ts"
  if node "$helper" "${src_files[@]}" >/dev/null 2>&1; then
    echo "precommit-build-guard: staged hook source changes are comment, whitespace or type-only; dist cannot change." >&2
    exit 0
  fi
fi

# A NEW hook module that no bundle imports yet. Its build changes only dist/.build-inputs.json: one line
# "<path under src/>": "<sha256 of the file with CR removed>" (.claude/hooks/scripts/write-build-inputs.mjs). So the commit
# is correct when ALL of these hold; any miss keeps the block below (fail closed, pure git and bash, no import parsing):
#   a) every staged hook source file is new (status A), and no other file under src/ (not a test, not a .d.ts) is staged;
#   b) the STAGED .build-inputs.json is changed and holds the hash line of each new file, computed from the staged blob
#      (this proves the build ran on the staged tree);
#   c) no dist/*.mjs differs from HEAD, in the index or in the working tree. A bundle that imports the new file would
#      change in that build, so an unchanged bundle set means nothing imports it.
BUILD_INPUTS=".claude/hooks/dist/.build-inputs.json"
new_module_only() {
  command -v sha256sum >/dev/null 2>&1 || return 1
  local added others p rel want
  added="$(git diff --cached --name-only --diff-filter=A 2>/dev/null)" || return 1
  while IFS= read -r p; do
    printf '%s\n' "$added" | grep -qxF -- "$p" || return 1
  done <<< "$src_ts"
  # (a) any other staged file under src/ (modified, renamed, deleted, or not a .ts) blocks.
  others="$(git diff --cached --name-only --diff-filter=ACMRTD 2>/dev/null | grep -E '^\.claude/hooks/src/' | grep -v '/__tests__/' | grep -v '\.d\.ts$')" || true
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    printf '%s\n' "$src_ts" | grep -qxF -- "$p" || return 1
  done <<< "$others"
  [ -z "$(git diff --cached --name-only --diff-filter=D 2>/dev/null | grep -E '^\.claude/hooks/src/' | grep -v '/__tests__/' | grep -v '\.d\.ts$')" ] || return 1
  # (b) the staged manifest changed, and lists the staged hash of each new file.
  git diff --cached --name-only 2>/dev/null | grep -qxF -- "$BUILD_INPUTS" || return 1
  while IFS= read -r p; do
    rel="${p#.claude/hooks/src/}"
    want="$(git show ":$p" 2>/dev/null | tr -d '\r' | sha256sum | cut -d' ' -f1)"
    [ -n "$want" ] || return 1
    git show ":$BUILD_INPUTS" 2>/dev/null | grep -qF -- "\"$rel\": \"$want\"" || return 1
  done <<< "$src_ts"
  # (c) no bundle changed in the index or the working tree (an error, such as no HEAD, is not a pass).
  git diff --quiet HEAD -- '.claude/hooks/dist/*.mjs' 2>/dev/null || return 1
  return 0
}
if new_module_only; then
  echo "precommit-build-guard: staged hook source is new module(s) that no bundle imports; the staged .build-inputs.json holds their hashes and no bundle changed." >&2
  exit 0
fi

# BLOCK: source changed but no rebuilt dist staged.
echo "" >&2
echo "BLOCKED by precommit-build-guard: staged hook source without rebuilt dist." >&2
echo "" >&2
echo "  Staged .claude/hooks/src/*.ts (no matching .claude/hooks/dist/*.mjs staged):" >&2
printf '%s\n' "$src_ts" | sed 's/^/    - /' >&2
echo "" >&2
echo "  Rebuild and stage the compiled output, then re-commit:" >&2
echo "    cd .claude/hooks && npm run build" >&2
echo "    git add .claude/hooks/dist/" >&2
echo "" >&2
echo "  (Escape: SKIP_BUILD_GUARD=1 git commit ...   or   git commit --no-verify)" >&2
echo "" >&2
exit 1
