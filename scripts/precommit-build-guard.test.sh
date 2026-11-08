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

# --- Case 18: adding an esbuild annotation -> BLOCK (/* @__PURE__ */ lets esbuild drop the call)
d="$(committed_repo $F $'declare function log(): number;\nexport const a = log();')"
stage_edit "$d" $F $'declare function log(): number;\nexport const a = /* @__PURE__ */ log();'
assert_exit "added @__PURE__ annotation (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 19: moving an annotation to another call -> BLOCK
d="$(committed_repo $F $'declare function f(): number;\nexport const a = /* @__PURE__ */ f();\nexport const b = f();')"
stage_edit "$d" $F $'declare function f(): number;\nexport const a = f();\nexport const b = /* @__PURE__ */ f();'
assert_exit "moved @__PURE__ annotation (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 20: editing a continuation line of a multi-line legal comment -> BLOCK
d="$(committed_repo $F $'/*!\n * old notice\n */\nexport const a = 1;')"
stage_edit "$d" $F $'/*!\n * new notice\n */\nexport const a = 1;'
assert_exit "multi-line legal comment body edit (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 21: changing the #! line -> BLOCK (esbuild copies it into the bundle)
d="$(committed_repo $F $'#!/usr/bin/env node\nexport const a = 1;')"
stage_edit "$d" $F $'#!/usr/bin/env -S node --no-warnings\nexport const a = 1;'
assert_exit "shebang change (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 22: an ordinary comment next to an unchanged annotation -> ALLOW
d="$(committed_repo $F $'declare function f(): number;\n// old\nexport const a = /* @__PURE__ */ f();')"
stage_edit "$d" $F $'declare function f(): number;\n// reworded note\nexport const a = /* @__PURE__ */ f();'
assert_exit "ordinary comment beside unchanged annotation (no dist) -> allow" 0 "$(run_guard "$d")"

# --- Case 23: a real hook's shape, unchanged #! plus a JSDoc header edit -> ALLOW
d="$(committed_repo $F $'#!/usr/bin/env node\n/**\n * Scan guard. Widening is a tracked follow-up.\n */\nexport const a = 1;')"
stage_edit "$d" $F $'#!/usr/bin/env node\n/**\n * Scan guard. Widening was closed on 2026-10-09.\n */\nexport const a = 1;'
assert_exit "shebang file, JSDoc-only edit (no dist) -> allow" 0 "$(run_guard "$d")"

# --- Case 24: a newline moved before an unchanged annotation -> ALLOW (same gap between tokens)
d="$(committed_repo $F $'declare function f(): number;\nexport const a = /* @__PURE__ */ f();')"
stage_edit "$d" $F $'declare function f(): number;\nexport const a =\n  /* @__PURE__ */ f();'
assert_exit "newline before unchanged annotation (no dist) -> allow" 0 "$(run_guard "$d")"

# --- Type-only allowance: types are erased before the bundle, so an edit that leaves the emitted
# JavaScript unchanged cannot change the dist. Same shape as the #400 edits.

# --- Case 25: a field added to an interface -> ALLOW
d="$(committed_repo $F $'interface Out { result?: string; }\nexport const a: Out = {};')"
stage_edit "$d" $F $'interface Out { result?: \x27continue\x27 | \x27block\x27; message?: string; }\nexport const a: Out = {};'
assert_exit "interface field added (no dist) -> allow" 0 "$(run_guard "$d")"

# --- Case 26: a type annotation and a source union widened -> ALLOW
d="$(committed_repo $F $'export function f(s: \x27a\x27 | \x27b\x27): number { return s === \x27a\x27 ? 1 : 2; }')"
stage_edit "$d" $F $'export function f(s: \x27a\x27 | \x27b\x27 | \x27cli\x27): number { return s === \x27a\x27 ? 1 : 2; }'
assert_exit "union widened (no dist) -> allow" 0 "$(run_guard "$d")"

# --- Case 27: a // @ts-expect-error line added -> ALLOW
d="$(committed_repo $F $'import { readFileSync } from \x27node:fs\x27;\nexport const a = readFileSync;')"
stage_edit "$d" $F $'// @ts-expect-error TS7016 no types\nimport { readFileSync } from \x27node:fs\x27;\nexport const a = readFileSync;'
assert_exit "ts-expect-error comment added (no dist) -> allow" 0 "$(run_guard "$d")"

# --- Case 28: an import type line added, never used as a value -> ALLOW
d="$(committed_repo $F $'export const a = 1;')"
stage_edit "$d" $F $'import type { Foo } from \x27./foo.js\x27;\nexport const a = 1;\nexport type B = Foo;'
assert_exit "import type + type alias added (no dist) -> allow" 0 "$(run_guard "$d")"

# --- Case 29: a type edit together with a code edit -> BLOCK
d="$(committed_repo $F $'interface Out { r?: string; }
export const a = 1;')"
stage_edit "$d" $F $'interface Out { r?: string; m?: string; }
export const a = 2;'
assert_exit "type edit + code edit together (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 30: a value import path changed -> BLOCK (the bundle follows the path)
d="$(committed_repo $F $'import { x } from \x27./lib/a\x27;\nexport const a = x;')"
stage_edit "$d" $F $'import { x } from \x27./lib/a.js\x27;\nexport const a = x;'
assert_exit "value import path changed (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 31: a cast turned into a call -> BLOCK
d="$(committed_repo $F $'declare const v: unknown;
export const a = v as number;')"
stage_edit "$d" $F $'declare const v: unknown;
export const a = Number(v);'
assert_exit "cast replaced by a call (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 32: an enum member added -> BLOCK (enums emit code, so the guard does not trust erasure)
d="$(committed_repo $F $'export enum E { A = 1 }')"
stage_edit "$d" $F $'export enum E { A = 1, B = 2 }'
assert_exit "enum member added (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 33: a constructor parameter property added -> BLOCK (it emits an assignment)
d="$(committed_repo $F $'export class C { constructor(x: number) {} }')"
stage_edit "$d" $F $'export class C { constructor(private x: number) {} }'
assert_exit "parameter property added (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 34: a type-only edit in a file that does not parse -> BLOCK (fail closed)
d="$(committed_repo $F $'export const a = (1;')"
stage_edit "$d" $F $'export const a: number = (1;'
assert_exit "unparseable file, type edit (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Import paths. A relative path that resolves to the same file before and after cannot change
# the bundle. Helper: a repo with src/lib/a.ts, b.ts and lib2/index.ts committed next to foo.ts.
import_repo() {  # $1 = base content of foo.ts -> echoes repo dir
  local r; r="$(committed_repo $F "$1")"
  mkdir -p "$r/.claude/hooks/src/lib" "$r/.claude/hooks/src/lib2"
  printf '%s\n' 'export const x = 1;' > "$r/.claude/hooks/src/lib/a.ts"
  printf '%s\n' 'export const x = 2;' > "$r/.claude/hooks/src/lib/b.ts"
  printf '%s\n' 'export const x = 3;' > "$r/.claude/hooks/src/lib2/index.ts"
  git -C "$r" add .claude/hooks/src/lib .claude/hooks/src/lib2 && git -C "$r" commit -q -m libs
  echo "$r"
}

# --- Case 35: ./lib/a becomes ./lib/a.js, same file -> ALLOW (the #400 tldr-read-enforcer shape)
d="$(import_repo $'import { x } from \x27./lib/a\x27;\nexport const a = x;')"
stage_edit "$d" $F $'import { x } from \x27./lib/a.js\x27;\nexport const a = x;'
assert_exit "import path gains .js, same file (no dist) -> allow" 0 "$(run_guard "$d")"

# --- Case 36: ./lib/a becomes ./lib/b, another file -> BLOCK
d="$(import_repo $'import { x } from \x27./lib/a\x27;\nexport const a = x;')"
stage_edit "$d" $F $'import { x } from \x27./lib/b\x27;\nexport const a = x;'
assert_exit "import path points at another file (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 37: gains .js but the file does not exist -> BLOCK (cannot prove it, fail closed)
d="$(import_repo $'import { x } from \x27./lib/zzz\x27;\nexport const a = x;')"
stage_edit "$d" $F $'import { x } from \x27./lib/zzz.js\x27;\nexport const a = x;'
assert_exit "import path gains .js, file missing (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 38: .js added plus a code edit -> BLOCK
d="$(import_repo $'import { x } from \x27./lib/a\x27;\nexport const a = x;')"
stage_edit "$d" $F $'import { x } from \x27./lib/a.js\x27;\nexport const a = x + 1;'
assert_exit "import .js plus code edit (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 39: a package name changes -> BLOCK (only relative paths are compared by file)
d="$(import_repo $'import { readFileSync } from \x27node:fs\x27;\nexport const a = readFileSync;')"
stage_edit "$d" $F $'import { readFileSync } from \x27fs\x27;\nexport const a = readFileSync;'
assert_exit "package specifier changed (no dist) -> BLOCK" 1 "$(run_guard "$d")"

# --- Case 40: a folder import becomes the index file path -> ALLOW (same file)
d="$(import_repo $'import { x } from \x27./lib2\x27;\nexport const a = x;')"
stage_edit "$d" $F $'import { x } from \x27./lib2/index.js\x27;\nexport const a = x;'
assert_exit "folder import becomes index.js, same file (no dist) -> allow" 0 "$(run_guard "$d")"

# --- Case 41: a re-export path gains .js -> ALLOW
d="$(import_repo $'export { x } from \x27./lib/a\x27;')"
stage_edit "$d" $F $'export { x } from \x27./lib/a.js\x27;'
assert_exit "re-export path gains .js, same file (no dist) -> allow" 0 "$(run_guard "$d")"

# --- Case 42: a dynamic import path gains .js -> ALLOW
d="$(import_repo $'export const load = () => import(\x27./lib/a\x27);')"
stage_edit "$d" $F $'export const load = () => import(\x27./lib/a.js\x27);'
assert_exit "dynamic import path gains .js, same file (no dist) -> allow" 0 "$(run_guard "$d")"

echo ""
echo "precommit-build-guard tests: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
