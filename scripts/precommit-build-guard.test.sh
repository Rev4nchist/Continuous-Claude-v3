#!/bin/bash
# precommit-build-guard.test.sh
# TDD harness for scripts/precommit-build-guard.sh.
# Drives a throwaway git repo + index through every guard branch and asserts exit codes.
# Usage: bash scripts/precommit-build-guard.test.sh   (exit 0 = all pass)
#
# Contract under test (see scripts/precommit-build-guard.sh):
#   - staged .claude/hooks/src/**/*.ts (excl __tests__/, *.d.ts) with NO staged dist/*.mjs  -> BLOCK (exit 1)
#   - same src staged WITH >=1 staged .claude/hooks/dist/*.mjs                                -> ALLOW (exit 0)
#   - docs-only / dist-only / test-only / d.ts-only staged                                    -> ALLOW (exit 0)
#   - SKIP_BUILD_GUARD=1                                                                       -> ALLOW (exit 0)
#   - no staged files                                                                          -> ALLOW (exit 0)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$SCRIPT_DIR/precommit-build-guard.sh"

PASS=0
FAIL=0

fail() { echo "  [FAIL] $1"; FAIL=$((FAIL + 1)); }
pass() { echo "  [PASS] $1"; PASS=$((PASS + 1)); }

# Create an isolated temp git repo for each case (clean index every time).
new_repo() {
  local d
  d="$(mktemp -d 2>/dev/null || mktemp -d -t guardtest)"
  git -C "$d" init -q
  git -C "$d" config user.email "t@t.t"
  git -C "$d" config user.name "t"
  git -C "$d" config commit.gpgsign false
  mkdir -p "$d/.claude/hooks/src/shared" "$d/.claude/hooks/src/__tests__" "$d/.claude/hooks/dist"
  echo "$d"
}

# run_guard <repo-dir> [extra env assignment] -> echoes exit code
run_guard() {
  local d="$1"; shift
  ( cd "$d" && env "$@" bash "$GUARD" >/dev/null 2>&1; echo $? )
}

assert_exit() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then pass "$desc (exit $actual)"; else fail "$desc: expected exit $expected, got $actual"; fi
}

# --- Case 1: no staged files -> ALLOW
d="$(new_repo)"
assert_exit "no staged files -> allow" 0 "$(run_guard "$d")"

# --- Case 2: docs-only staged -> ALLOW
d="$(new_repo)"
echo "x" > "$d/README.md"; git -C "$d" add README.md
assert_exit "docs-only staged -> allow" 0 "$(run_guard "$d")"

# --- Case 3: src .ts WITHOUT dist -> BLOCK
d="$(new_repo)"
echo "export const a=1;" > "$d/.claude/hooks/src/foo.ts"; git -C "$d" add .claude/hooks/src/foo.ts
assert_exit "src-only (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 4: src .ts + dist .mjs -> ALLOW
d="$(new_repo)"
echo "export const a=1;" > "$d/.claude/hooks/src/foo.ts"
echo "const a=1;" > "$d/.claude/hooks/dist/foo.mjs"
git -C "$d" add .claude/hooks/src/foo.ts .claude/hooks/dist/foo.mjs
assert_exit "src + dist staged -> allow" 0 "$(run_guard "$d")"

# --- Case 5: only __tests__ ts staged (excluded) -> ALLOW
d="$(new_repo)"
echo "test('x',()=>{});" > "$d/.claude/hooks/src/__tests__/foo.test.ts"
git -C "$d" add .claude/hooks/src/__tests__/foo.test.ts
assert_exit "test-only ts staged -> allow" 0 "$(run_guard "$d")"

# --- Case 6: only *.d.ts staged (excluded) -> ALLOW
d="$(new_repo)"
echo "declare const a:number;" > "$d/.claude/hooks/src/types.d.ts"
git -C "$d" add .claude/hooks/src/types.d.ts
assert_exit "d.ts-only staged -> allow" 0 "$(run_guard "$d")"

# --- Case 7: SKIP_BUILD_GUARD=1 escapes a src-only block -> ALLOW
d="$(new_repo)"
echo "export const a=1;" > "$d/.claude/hooks/src/foo.ts"; git -C "$d" add .claude/hooks/src/foo.ts
assert_exit "SKIP_BUILD_GUARD=1 -> allow" 0 "$(run_guard "$d" SKIP_BUILD_GUARD=1)"

# --- Case 8: dist-only staged (no src) -> ALLOW
d="$(new_repo)"
echo "const a=1;" > "$d/.claude/hooks/dist/foo.mjs"; git -C "$d" add .claude/hooks/dist/foo.mjs
assert_exit "dist-only staged -> allow" 0 "$(run_guard "$d")"

# --- Case 9: nested src dir .ts without dist -> BLOCK (recursive src match)
d="$(new_repo)"
echo "export const a=1;" > "$d/.claude/hooks/src/shared/util.ts"; git -C "$d" add .claude/hooks/src/shared/util.ts
assert_exit "nested src-only (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Comment-only allowance (scripts/hooks-src-comment-only.mjs). Each case commits a base
# version, then stages an edit and no dist. The guard must ALLOW only when the dist cannot change.
committed_repo() {  # $1 = repo-relative path, $2 = base content -> echoes repo dir with base committed
  local d; d="$(new_repo)"
  mkdir -p "$d/$(dirname "$1")"
  printf '%s\n' "$2" > "$d/$1"
  git -C "$d" add "$1" && git -C "$d" commit -q -m base
  echo "$d"
}
stage_edit() {  # $1 = repo dir, $2 = path, $3 = new content
  printf '%s\n' "$3" > "$1/$2"; git -C "$1" add "$2"
}
F=.claude/hooks/src/foo.ts

# --- Case 10: comment-only edit -> ALLOW (the PR #119 case)
d="$(committed_repo $F $'// old note\nexport const a = 1;')"
stage_edit "$d" $F $'// new note, reworded\nexport const a = 1; /* trailing */'
assert_exit "comment-only edit (no dist) -> allow" 0 "$(run_guard "$d")"

# --- Case 11: whitespace/format-only edit -> ALLOW
d="$(committed_repo $F $'export const a = 1;\nexport function f(x: number) { return x + a; }')"
stage_edit "$d" $F $'export const a=1;\n\nexport function f( x: number ) {\n  return x + a;\n}'
assert_exit "whitespace-only edit (no dist) -> allow" 0 "$(run_guard "$d")"

# --- Case 12: real code edit -> BLOCK
d="$(committed_repo $F $'export const a = 1;')"
stage_edit "$d" $F $'export const a = 2;'
assert_exit "code edit (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 13: legal comment change -> BLOCK (esbuild keeps /*! ... */ in the bundle)
d="$(committed_repo $F $'/*! v1 */\nexport const a = 1;')"
stage_edit "$d" $F $'/*! v2 */\nexport const a = 1;'
assert_exit "legal comment edit (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 14: a code change after a regex holding // -> BLOCK (a plain token scan reads the
# rest of the line as a comment and would miss it)
d="$(committed_repo $F $'const r = /a\\/\\//; export const x = r.test("a//") ? 1 : 0;')"
stage_edit "$d" $F $'const r = /a\\/\\//; export const x = r.test("a//") ? 2 : 0;'
assert_exit "code change after a // regex (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 15: two files, one comment-only and one code edit -> BLOCK
d="$(committed_repo $F $'export const a = 1;')"
mkdir -p "$d/.claude/hooks/src/shared"
printf '%s\n' 'export const b = 1;' > "$d/.claude/hooks/src/shared/b.ts"
git -C "$d" add .claude/hooks/src/shared/b.ts && git -C "$d" commit -q -m b
stage_edit "$d" $F $'// only a comment\nexport const a = 1;'
stage_edit "$d" .claude/hooks/src/shared/b.ts 'export const b = 3;'
assert_exit "comment-only + code edit together (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 16: a JSDoc header edit -> ALLOW (the exact PR #119 shape)
d="$(committed_repo $F $'/**\n * Widening is a tracked follow-up.\n */\nexport const a = 1;')"
stage_edit "$d" $F $'/**\n * Widening was closed on 2026-10-09.\n * See the proposal.\n */\nexport const a = 1;'
assert_exit "JSDoc-only edit (no dist) -> allow" 0 "$(run_guard "$d")"

# --- Case 17: a newline that changes meaning (ASI) -> BLOCK
d="$(committed_repo $F $'export function f(x: number) { return x; }')"
stage_edit "$d" $F $'export function f(x: number) { return\n x; }'
assert_exit "newline that changes meaning, return/x (no dist) -> BLOCK" 1 "$(run_guard "$d")"

echo ""
echo "precommit-build-guard tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
