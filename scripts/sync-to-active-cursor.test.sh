#!/usr/bin/env bash
# Fixture test for scripts/sync-to-active.sh: branch guard, sync cursor, lock
# queueing and empty-dir pruning (2026-09-23 Opus 5.5 eval, proposal P25).
#
# Runs the REAL script inside a throwaway git repo with HOME pointed at a
# throwaway ~/.claude, the same way sync-claude-mapping.test.sh does.
#
# Usage (Git Bash, not WSL): bash scripts/sync-to-active-cursor.test.sh
set -u
# Never let an inherited GIT_DIR (e.g. when run from a git hook) point the fixture's
# git calls at the caller's repository.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX GIT_NAMESPACE

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

echo "=== T7: a pending marker left at the end triggers one more run, then clears ==="
printf 'g\n' > "$REPO/.claude/rules-src/g.md"; commit g
: > "$ACT/.sync.pending"
sync --changed >/dev/null; rc=$?
chk "exit 0" "$( [ "$rc" -eq 0 ] && echo 1 || echo 0)"
chk "g.md synced" "$(has "$ACT/rules/g.md")"
chk "marker cleared by the re-run" "$(not "$ACT/.sync.pending")"
chk "lock released" "$(not "$ACT/.sync.lock")"

echo "=== T8: an inherited GIT_DIR (as in a git hook) does not redirect the checks ==="
OTHER="$FIX/other"; mkdir -p "$OTHER"
git -C "$OTHER" init -q -b feature-elsewhere >/dev/null 2>&1
printf 'h\n' > "$REPO/.claude/rules-src/h.md"; commit h
out="$(GIT_DIR="$OTHER/.git" HOME="$HOMEDIR" bash "$REPO/scripts/sync-to-active.sh" --changed 2>&1)"
chk "not skipped as 'feature-elsewhere'" "$(printf '%s' "$out" | grep -q 'Sync skipped' && echo 0 || echo 1)"
chk "h.md synced from the fixture repo" "$(has "$ACT/rules/h.md")"

echo "=== T9: the post-commit hook shows a skip off main and logs the detached sync on main ==="
# The REAL scripts/post-commit-hook.sh, installed in the fixture repo, fired by real commits.
cp "$SCRIPT_DIR/post-commit-hook.sh" "$REPO/.git/hooks/post-commit"; chmod +x "$REPO/.git/hooks/post-commit"
LOG="$HOMEDIR/.claude/logs/post-commit-sync.log"
hook_commit() {  # hook_commit <message>: real commit, HOME in the fixture, hook output returned
    git -C "$REPO" add -A >/dev/null 2>&1
    HOME="$HOMEDIR" git -C "$REPO" -c user.name=fixture -c user.email=fixture@example.invalid commit -q -m "$1" 2>&1
}
g checkout -q -b feat9
printf 'i\n' > "$REPO/.claude/rules-src/i.md"
out="$(hook_commit i)"
chk "feature-branch commit prints 'Sync skipped' from the hook" "$(printf '%s' "$out" | grep -q 'Sync skipped: feat9 is not main' && echo 1 || echo 0)"
sleep 2
chk "feature-branch commit writes no sync log" "$(not "$LOG")"
chk "i.md NOT live" "$(not "$ACT/rules/i.md")"
g checkout -q main
printf 'j\n' > "$REPO/.claude/rules-src/j.md"
out="$(hook_commit j)"
chk "main commit does not print 'Sync skipped'" "$(printf '%s' "$out" | grep -q 'Sync skipped' && echo 0 || echo 1)"
for _ in $(seq 1 50); do
    [ "$(tr -d '\r\n' < "$ACT/state/sync-cursor" 2>/dev/null)" = "$(git -C "$REPO" rev-parse HEAD)" ] && break
    sleep 0.2
done
chk "main commit appends a timestamped header to the log" "$(grep -qE '^=== [0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]+.* post-commit sync \(main' "$LOG" 2>/dev/null && echo 1 || echo 0)"
chk "detached sync ran and moved the cursor to HEAD" "$( [ "$(tr -d '\r\n' < "$ACT/state/sync-cursor")" = "$(git -C "$REPO" rev-parse HEAD)" ] && echo 1 || echo 0)"
chk "j.md synced by the hook" "$(has "$ACT/rules/j.md")"
rm -f "$REPO/.git/hooks/post-commit"

echo "=== T10: a detached worktree at main syncs from a feature-branch checkout (land-pr.ps1 path) ==="
# The primary checkout sits on a feature branch; main moved on (a PR merged). land-pr.ps1 adds a
# detached worktree of main and runs the sync there with SYNC_MAIN_DETACHED=1.
g checkout -q -b feat10
printf 'only-on-feat10\n' > "$REPO/.claude/rules-src/feat10-only.md"; commit feat10
g checkout -q main
printf 'k\n' > "$REPO/.claude/rules-src/k.md"; commit k
g checkout -q feat10
WT10="$FIX/land-pr-sync"
g worktree add --detach "$WT10" main
wt_sync() { ( cd "$WT10" && HOME="$HOMEDIR" SYNC_MAIN_DETACHED=1 bash "$WT10/scripts/sync-to-active.sh" --changed 2>&1 ); }
out="$(wt_sync)"
chk "run not skipped" "$(printf '%s' "$out" | grep -q 'Sync skipped' && echo 0 || echo 1)"
chk "k.md (new on main) synced" "$(has "$ACT/rules/k.md")"
chk "feat10-only.md (feature branch) NOT live" "$(not "$ACT/rules/feat10-only.md")"
chk "cursor = main (the worktree run moves it)" "$( [ "$(tr -d '\r\n' < "$ACT/state/sync-cursor")" = "$(git -C "$REPO" rev-parse main)" ] && echo 1 || echo 0)"
chk "no quarantine dir" "$(not "$ACT/.sync-quarantine")"
chk "primary checkout still on feat10" "$( [ "$(git -C "$REPO" rev-parse --abbrev-ref HEAD)" = "feat10" ] && echo 1 || echo 0)"
# Guard, part 1: no flag. The worktree is detached EXACTLY at main, so only the missing
# SYNC_MAIN_DETACHED flag can cause the skip (HEAD == main would otherwise pass the guard). The
# cursor is parked one commit behind so a wrongly passing run would visibly move it.
git -C "$WT10" checkout -q --detach main >/dev/null 2>&1
chk "fixture: worktree is exactly at main" "$( [ "$(git -C "$WT10" rev-parse HEAD)" = "$(git -C "$REPO" rev-parse main)" ] && echo 1 || echo 0)"
git -C "$REPO" rev-parse 'main~1' > "$ACT/state/sync-cursor"
out="$( cd "$WT10" && HOME="$HOMEDIR" bash "$WT10/scripts/sync-to-active.sh" --changed 2>&1 )"
chk "no flag: a detached worktree AT main is skipped" "$(printf '%s' "$out" | grep -q 'Sync skipped' && echo 1 || echo 0)"
chk "no flag: cursor did not move" "$( [ "$(tr -d '\r\n' < "$ACT/state/sync-cursor")" = "$(git -C "$REPO" rev-parse 'main~1')" ] && echo 1 || echo 0)"
git -C "$REPO" rev-parse main > "$ACT/state/sync-cursor"
# Guard, part 2: with the flag, a detached HEAD that is not main's commit is skipped.
printf 'l\n' > "$REPO/.claude/rules-src/l.md"; g checkout -q main; commit l; g checkout -q feat10
git -C "$WT10" checkout -q --detach feat10 >/dev/null 2>&1
out2="$(wt_sync)"
chk "detached at a non-main commit is skipped even with the flag" "$(printf '%s' "$out2" | grep -q 'Sync skipped' && echo 1 || echo 0)"
chk "feat10-only.md still NOT live" "$(not "$ACT/rules/feat10-only.md")"
chk "cursor did not move to the feature commit" "$( [ "$(tr -d '\r\n' < "$ACT/state/sync-cursor")" != "$(git -C "$REPO" rev-parse feat10)" ] && echo 1 || echo 0)"

# X4: a queued .sync.pending must survive a detached-worktree run when main moved past the worktree.
# The worktree sits at main (commit l). A sha256sum shim moves main to commit m and queues the marker
# after the guard passed, the way a second land-pr run would mid-sync.
g checkout -q -b side10 main; printf 'm\n' > "$REPO/.claude/rules-src/m.md"; commit m; g checkout -q feat10
git -C "$WT10" checkout -q --detach main >/dev/null 2>&1
SHIM="$FIX/shim"; mkdir -p "$SHIM"
SHIM_REAL_SHA="$(command -v sha256sum)"; SHIM_MSHA="$FIX/shim-msha"; SHIM_DONE="$FIX/shim-done"
git -C "$REPO" rev-parse side10 > "$SHIM_MSHA"
cat > "$SHIM/sha256sum" <<'SHIMEOF'
#!/usr/bin/env bash
if [ ! -e "$SHIM_DONE" ]; then
    : > "$SHIM_DONE"
    git -C "$SHIM_REPO" update-ref refs/heads/main "$(cat "$SHIM_MSHA")"
    : > "$SHIM_ACT/.sync.pending"
fi
exec "$SHIM_REAL_SHA" "$@"
SHIMEOF
chmod +x "$SHIM/sha256sum"
git -C "$REPO" rev-parse 'main~1' > "$ACT/state/sync-cursor"
out="$( cd "$WT10" && PATH="$SHIM:$PATH" SHIM_REPO="$REPO" SHIM_ACT="$ACT" SHIM_MSHA="$SHIM_MSHA" SHIM_DONE="$SHIM_DONE" SHIM_REAL_SHA="$SHIM_REAL_SHA" \
    HOME="$HOMEDIR" SYNC_MAIN_DETACHED=1 bash "$WT10/scripts/sync-to-active.sh" --changed 2>&1 )"
chk "X4 fixture: the shim moved main to m" "$( [ "$(git -C "$REPO" rev-parse main)" = "$(cat "$SHIM_MSHA")" ] && echo 1 || echo 0)"
chk "X4: run synced the worktree's own commit (l.md)" "$(has "$ACT/rules/l.md")"
chk "X4: queued marker kept (main moved past the worktree)" "$(has "$ACT/.sync.pending")"
chk "X4: m.md not claimed synced" "$(not "$ACT/rules/m.md")"
chk "X4: cursor stays at the worktree's commit, behind main" "$( [ "$(tr -d '\r\n' < "$ACT/state/sync-cursor")" != "$(git -C "$REPO" rev-parse main)" ] && echo 1 || echo 0)"
# Control: worktree exactly at main and a marker present: consumed as before.
git -C "$WT10" checkout -q --detach main >/dev/null 2>&1
out="$(wt_sync)"
chk "X4 control: HEAD == main consumes the marker" "$(not "$ACT/.sync.pending")"
chk "X4 control: m.md now synced, cursor = main" "$( [ -e "$ACT/rules/m.md" ] && [ "$(tr -d '\r\n' < "$ACT/state/sync-cursor")" = "$(git -C "$REPO" rev-parse main)" ] && echo 1 || echo 0)"
g worktree remove --force "$WT10"
g checkout -q main

echo "=== T11: clobber guard quarantines real edits, not hand copies or EOL-only differences ==="
MAN="$ACT/state/sync-manifest.txt"
QROOT="$ACT/.sync-quarantine"
man_hash() { awk -F'\t' -v p="$1" '$2 == p { print $1 }' "$MAN"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
chk "T11 fixture: no quarantine dir before the scenarios" "$(not "$QROOT")"

# (a) hand copy: active already holds the repo's new content before the sync runs.
printf 'v1\n' > "$REPO/.claude/rules-src/t11a.md"; commit t11a-v1
sync --changed >/dev/null
printf 'v2\n' > "$REPO/.claude/rules-src/t11a.md"; commit t11a-v2
cp "$REPO/.claude/rules-src/t11a.md" "$ACT/rules/t11a.md"          # the hand copy
out="$(sync --changed)"
chk "(a) hand copy equal to the repo: no quarantine dir" "$(not "$QROOT")"
chk "(a) no CLOBBER-GUARD line printed" "$(printf '%s' "$out" | grep -q 'CLOBBER-GUARD' && echo 0 || echo 1)"
chk "(a) manifest entry refreshed to the hand copy's hash" "$( [ "$(man_hash rules/t11a.md)" = "$(sha "$ACT/rules/t11a.md")" ] && echo 1 || echo 0)"
# The stale entry used to bite on the NEXT repo change: the old hand copy matched nothing.
printf 'v3\n' > "$REPO/.claude/rules-src/t11a.md"; commit t11a-v3
sync --changed >/dev/null
chk "(a) next repo update: no quarantine dir" "$(not "$QROOT")"
chk "(a) next repo update lands" "$( [ "$(cat "$ACT/rules/t11a.md")" = "v3" ] && echo 1 || echo 0)"

# (c) EOL-only: active holds the repo's new text with CRLF endings.
printf 'one\ntwo\n' > "$REPO/.claude/rules-src/t11c.md"; commit t11c-v1
sync --changed >/dev/null
printf 'one\ntwo\nthree\n' > "$REPO/.claude/rules-src/t11c.md"; commit t11c-v2
printf 'one\r\ntwo\r\nthree\r\n' > "$ACT/rules/t11c.md"            # CRLF copy of the new text
out="$(sync --changed)"
chk "(c) CRLF-only difference: no quarantine dir" "$(not "$QROOT")"
chk "(c) active converges to the repo bytes (LF)" "$(cmp -s "$REPO/.claude/rules-src/t11c.md" "$ACT/rules/t11c.md" && echo 1 || echo 0)"
chk "(c) manifest entry = repo hash" "$( [ "$(man_hash rules/t11c.md)" = "$(sha "$REPO/.claude/rules-src/t11c.md")" ] && echo 1 || echo 0)"
# A CRLF file that also differs in text is a real edit.
printf 'one\ntwo\nthree\nfour\n' > "$REPO/.claude/rules-src/t11c.md"; commit t11c-v3
printf 'one\r\ntwo\r\nEDITED\r\nfour\r\n' > "$ACT/rules/t11c.md"
out="$(sync --changed)"
chk "(c) CRLF plus a text edit: quarantined" "$(printf '%s' "$out" | grep -q 'CLOBBER-GUARD: active copy of rules/t11c.md' && echo 1 || echo 0)"
rm -rf "$QROOT"

# (b) real divergent edit: must still be quarantined, with its content kept.
printf 'b1\n' > "$REPO/.claude/rules-src/t11b.md"; commit t11b-v1
sync --changed >/dev/null
printf 'hand edit in active\n' > "$ACT/rules/t11b.md"
printf 'b2\n' > "$REPO/.claude/rules-src/t11b.md"; commit t11b-v2
out="$(sync --changed)"
chk "(b) real edit: CLOBBER-GUARD line printed" "$(printf '%s' "$out" | grep -q 'CLOBBER-GUARD: active copy of rules/t11b.md' && echo 1 || echo 0)"
qfile="$(find "$QROOT" -name t11b.md -type f 2>/dev/null | head -n 1)"
chk "(b) quarantine dir holds the hand edit" "$( [ -n "$qfile" ] && [ "$(cat "$qfile")" = "hand edit in active" ] && echo 1 || echo 0)"
chk "(b) repo version landed" "$( [ "$(cat "$ACT/rules/t11b.md")" = "b2" ] && echo 1 || echo 0)"
chk "(b) manifest = repo hash" "$( [ "$(man_hash rules/t11b.md)" = "$(sha "$ACT/rules/t11b.md")" ] && echo 1 || echo 0)"

echo
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
