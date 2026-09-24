#!/usr/bin/env bash
# Fixture test for scripts/sync-to-active.sh: branch guard, sync cursor, lock
# queueing and empty-dir pruning (2026-09-23 Opus 5.5 eval, proposal P25).
#
# Runs the REAL script inside a throwaway git repo with HOME pointed at a
# throwaway ~/.claude, the same way sync-claude-mapping.test.sh does.
#
# Usage (Git Bash, not WSL): bash scripts/sync-to-active-cursor.test.sh
set -u

SCRIPT_DIR="$( cd "$( dirname "$0" )" && pwd )"
REAL="$SCRIPT_DIR/sync-to-active.sh"
FIX="$(mktemp -d)"
trap 'rm -rf "$FIX"' EXIT

REPO="$FIX/repo"; HOMEDIR="$FIX/home"; ACT="$HOMEDIR/.claude"
mkdir -p "$REPO/scripts" "$REPO/.claude/rules-src" "$REPO/.claude/skills" "$ACT"
cp "$REAL" "$REPO/scripts/sync-to-active.sh"

g() { git -C "$REPO" -c user.name=fixture -c user.email=fixture@example.invalid "$@" >/dev/null 2>&1; }
sync() { HOME="$HOMEDIR" bash "$REPO/scripts/sync-to-active.sh" "$@" 2>&1; }
commit() { g add -A; g commit -q -m "$1"; }

pass=0; fail=0
chk() { if [ "$2" = "1" ]; then echo "  PASS  $1"; pass=$((pass+1));
        else echo "  FAIL  $1"; fail=$((fail+1)); fi; }
has() { [ -e "$1" ] && echo 1 || echo 0; }
not() { [ -e "$1" ] && echo 0 || echo 1; }

g init -q -b main
printf 'seed\n' > "$REPO/.claude/rules-src/seed.md"
commit seed
sync >/dev/null   # full mirror; writes the first cursor

echo "=== T1: cursor catches up every commit since the last sync ==="
printf 'b\n' > "$REPO/.claude/rules-src/b.md"; commit b
printf 'c\n' > "$REPO/.claude/rules-src/c.md"; commit c
sync --changed >/dev/null
chk "b.md synced (the old HEAD^1..HEAD diff missed it)" "$(has "$ACT/rules/b.md")"
chk "c.md synced" "$(has "$ACT/rules/c.md")"
chk "cursor = HEAD" "$( [ "$(tr -d '\r\n' < "$ACT/state/sync-cursor")" = "$(git -C "$REPO" rev-parse HEAD)" ] && echo 1 || echo 0)"

echo "=== T2: a feature branch does not sync ==="
g checkout -q -b feat
printf 'feat\n' > "$REPO/.claude/rules-src/feat.md"; commit feat
out="$(sync --changed)"
chk "skip message printed" "$(printf '%s' "$out" | grep -q 'Sync skipped' && echo 1 || echo 0)"
chk "feat.md NOT live before merge" "$(not "$ACT/rules/feat.md")"
SYNC_ALLOW_BRANCH=1 sync --changed >/dev/null
chk "SYNC_ALLOW_BRANCH=1 overrides" "$(has "$ACT/rules/feat.md")"
rm -f "$ACT/rules/feat.md"
g checkout -q main
g merge -q --no-ff feat -m "merge feat"
sync --changed >/dev/null
chk "after merge to main, the first sync brings feat.md in" "$(has "$ACT/rules/feat.md")"

echo "=== T3: a linked worktree on main does not sync ==="
g checkout -q -b dev
g worktree add -q "$FIX/wt" main
printf 'wt\n' > "$FIX/wt/.claude/rules-src/wt.md"
git -C "$FIX/wt" -c user.name=f -c user.email=f@example.invalid add -A >/dev/null 2>&1
git -C "$FIX/wt" -c user.name=f -c user.email=f@example.invalid commit -q -m wt >/dev/null 2>&1
out="$(HOME="$HOMEDIR" bash "$FIX/wt/scripts/sync-to-active.sh" --changed 2>&1)"
chk "worktree run skipped" "$(printf '%s' "$out" | grep -q 'Sync skipped' && echo 1 || echo 0)"
chk "wt.md NOT live" "$(not "$ACT/rules/wt.md")"
g worktree remove --force "$FIX/wt"
g checkout -q main

echo "=== T4: a held lock queues the commit instead of dropping it ==="
printf 'd\n' > "$REPO/.claude/rules-src/d.md"; commit d
mkdir "$ACT/.sync.lock"
sync --changed >/dev/null
chk "locked-out run leaves the pending marker" "$(has "$ACT/.sync.pending")"
chk "nothing copied while locked" "$(not "$ACT/rules/d.md")"
rmdir "$ACT/.sync.lock"
printf 'e\n' > "$REPO/.claude/rules-src/e.md"; commit e
sync --changed >/dev/null
chk "next run syncs the queued commit (d.md)" "$(has "$ACT/rules/d.md")"
chk "and its own commit (e.md)" "$(has "$ACT/rules/e.md")"
chk "pending marker cleared" "$(not "$ACT/.sync.pending")"

echo "=== T5: deleting a skill removes its now-empty folder ==="
mkdir -p "$REPO/.claude/skills/gone"
printf -- '---\nname: gone\n---\n' > "$REPO/.claude/skills/gone/SKILL.md"; commit add-skill
sync --changed >/dev/null
chk "skill synced" "$(has "$ACT/skills/gone/SKILL.md")"
rm -rf "$REPO/.claude/skills/gone"; commit del-skill
sync --changed >/dev/null
chk "skill file deleted" "$(not "$ACT/skills/gone/SKILL.md")"
chk "empty skills/gone/ folder removed" "$(not "$ACT/skills/gone")"
chk "skills/ itself kept" "$(has "$ACT/skills")"

echo "=== T6: a cursor that is not an ancestor falls back to the full mirror ==="
printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n' > "$ACT/state/sync-cursor"
printf 'f\n' > "$REPO/.claude/rules-src/f.md"; commit f
out="$(sync --changed)"
chk "fallback message printed" "$(printf '%s' "$out" | grep -q 'running the full mirror' && echo 1 || echo 0)"
chk "full mirror synced f.md" "$(has "$ACT/rules/f.md")"
chk "cursor repaired to HEAD" "$( [ "$(tr -d '\r\n' < "$ACT/state/sync-cursor")" = "$(git -C "$REPO" rev-parse HEAD)" ] && echo 1 || echo 0)"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
