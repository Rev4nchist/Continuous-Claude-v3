#!/usr/bin/env bash
# Fixture test for scripts/sync-claude.sh — the rules cross-name mapping.
#
# Why this exists: commit 9f9b9d4 renamed the repo rules tree to .claude/rules-src
# so Claude Code stops loading all 46 rules a second time as project scope (~61k
# tokens/session). c6594b7 taught sync-claude.sh the direction-aware mapping so a
# reverse-sync cannot silently recreate .claude/rules and undo it. That fix was
# originally verified by reading + `bash -n` only, because the dirty-tree
# pre-flight guard refuses to run against the live repo. This runs the REAL
# script against a throwaway tree with HOME overridden, which the guard permits.
#
# Usage: bash scripts/sync-claude-mapping.test.sh
set -u

SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"
REAL="$SCRIPT_DIR/sync-claude.sh"
FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT

mkdir -p "$FIX/repo/scripts" "$FIX/repo/.claude/rules-src" \
         "$FIX/home/.claude"/{rules,agents,skills}
cp "$REAL" "$FIX/repo/scripts/sync-claude.sh"

printf 'ACTIVE-ONLY\n' > "$FIX/home/.claude/rules/alpha.md"
printf 'REPO-ONLY\n'   > "$FIX/repo/.claude/rules-src/beta.md"
# agents/ and skills/ must be POPULATED and must sort before the rules copy,
# or the abort-after-first-dir regression is invisible: copy_dir returned 1 on a
# non-verbose run, so `set -e` killed the script after the FIRST non-empty dir.
# With only rules/ present, the rules copy still completed before the abort and
# every mapping assertion passed while the script was badly broken.
printf 'AGENT\n' > "$FIX/home/.claude/agents/an-agent.md"
printf 'SKILL\n' > "$FIX/home/.claude/skills/a-skill.md"

pass=0; fail=0
chk() { if [ "$2" = "1" ]; then echo "  PASS  $1"; pass=$((pass+1));
        else echo "  FAIL  $1"; fail=$((fail+1)); fi; }
ok()  { if [ -e "$1" ]; then echo 1; else echo 0; fi; }
no()  { if [ -e "$1" ]; then echo 0; else echo 1; fi; }

echo "=== T1: --to-repo maps active rules/ -> repo .claude/rules-src ==="
set +e
HOME="$FIX/home" bash "$FIX/repo/scripts/sync-claude.sh" --to-repo >"$FIX/t1.log" 2>&1
t1rc=$?
set -e
chk "exit 0 on success (regression guard: bare \`\$VERBOSE && echo\` exits 1)" \
    "$( [ "$t1rc" -eq 0 ] && echo 1 || echo 0 )"
chk "alpha.md landed in repo .claude/rules-src" "$(ok "$FIX/repo/.claude/rules-src/alpha.md")"
chk "repo .claude/rules NOT recreated (the ~61k duplicate)" "$(no "$FIX/repo/.claude/rules")"
chk "agents/ synced (first dir)" "$(ok "$FIX/repo/.claude/agents/an-agent.md")"
chk "skills/ synced too — does not abort after the first non-empty dir" \
    "$(ok "$FIX/repo/.claude/skills/a-skill.md")"

echo "=== T2: --from-repo maps repo rules-src -> active rules/ ==="
set +e
HOME="$FIX/home" bash "$FIX/repo/scripts/sync-claude.sh" --from-repo >"$FIX/t2.log" 2>&1
t2rc=$?
set -e
chk "exit 0 on success" "$( [ "$t2rc" -eq 0 ] && echo 1 || echo 0 )"
chk "beta.md landed in active rules/" "$(ok "$FIX/home/.claude/rules/beta.md")"
chk "active rules-src NOT created" "$(no "$FIX/home/.claude/rules-src")"

echo "=== T3: dirty-repo pre-flight guard refuses --to-repo ==="
git -C "$FIX/repo" init -q
git -C "$FIX/repo" -c user.email=t@t -c user.name=t add -A >/dev/null 2>&1
git -C "$FIX/repo" -c user.email=t@t -c user.name=t commit -qm base >/dev/null 2>&1
printf 'DIRTY EDIT\n' >> "$FIX/repo/.claude/rules-src/beta.md"
set +e
HOME="$FIX/home" bash "$FIX/repo/scripts/sync-claude.sh" --to-repo >"$FIX/t3.log" 2>&1
t3rc=$?
set -e
chk "aborts non-zero on dirty rules-src (got $t3rc)" "$( [ "$t3rc" -ne 0 ] && echo 1 || echo 0 )"
chk "abort message names the refusal" \
    "$(grep -q 'reverse-sync refused' "$FIX/t3.log" && echo 1 || echo 0)"

echo
echo "RESULT pass=$pass fail=$fail"
[ "$fail" -eq 0 ]
