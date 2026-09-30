---
paths:
  - ".claude/rules-src/**"
  - ".claude/rules-ondemand/**"
  - ".claude/hooks/**"
  - ".claude/skills/**"
  - ".claude/agents/**"
  - ".claude/templates/**"
  - ".claude/settings.json"
  - ".claude/settings.json.template"
  - ".claude/project-registry.json"
  - "scripts/sync-to-active.sh"
  - "scripts/sync-claude.sh"
---

# Git Sync Workflow: continuous-claude → ~/.claude

## Primary Flow (Forward Sync)

```
continuous-claude (repo)  →  ~/.claude (active)
        ↓                         ↓
    Edit here                 Auto-receives
        ↓                         ↓
    git commit              post-commit hook (background)
        ↓                         ↓
    git push                Hooks rebuilt
```

**Note:** Post-commit sync runs in the background (`&`) so `git commit` returns instantly. Sync completes asynchronously.

## Only `main` goes live (2026-09-23)

`sync-to-active.sh` syncs only from `main` in the primary checkout. A commit on a feature branch
or in a linked worktree prints `Sync skipped` and changes nothing in `~/.claude`, so a PR's hooks
and rules are not live before review. After a PR merges and local `main` advances (a fast-forward
fires no commit hook), run `bash scripts/sync-to-active.sh --changed` from `main`.

The post-commit hook prints "Sync skipped" off `main` and logs the background sync to
`~/.claude/logs/post-commit-sync.log`. After a commit on `main`, confirm `~/.claude/state/sync-cursor`
equals `git rev-parse main`.

`--changed` diffs from a cursor (`~/.claude/state/sync-cursor`, the last commit synced from main)
to `HEAD`, so one run picks up every merged commit. A run that finds the lock held leaves
`~/.claude/.sync.pending`, and the lock holder syncs those commits before it exits. A cursor that
is not an ancestor of `HEAD` falls back to the full mirror. Override for a deliberate branch sync:
`SYNC_ALLOW_BRANCH=1` (it never moves the cursor). `SYNC_MAIN_DETACHED=1` accepts a detached HEAD at
exactly `main`'s commit and does move the cursor; `land-pr.ps1` uses it from a temp worktree. Test: `bash scripts/sync-to-active-cursor.test.sh`.

## Reverse Sync is MANUAL-ONLY (root-cause fix, 2026-06-01)

**The repo is the single source of truth.** Forward sync (repo → active) is the ONLY automatic direction. Reverse sync (active → repo) is **manual-only** — run it deliberately, and only when you edited `~/.claude/` directly and want those edits captured in the repo:

```bash
bash ~/continuous-claude/scripts/sync-claude.sh --to-repo
```

**Why manual-only:** two *automatic* reverse-sync triggers used to race the background forward-sync and **clobber fresh repo edits with stale active copies** (they reverted `rules-ondemand/codex-adversarial.md` twice on 2026-06-01; the emit-only audit gate doesn't protect non-emit docs). Both were disabled at the root:

| Trigger | Fix |
|---------|-----|
| `~/.claude/.git/hooks/post-commit` (hand-rolled, ran `sync-claude.sh --to-repo` on every active commit) | **Neutered to a no-op.** Backup at `post-commit.bak.2026-05-31`. |
| `sync-to-repo` PostToolUse:Write\|Edit hook (`hooks/src/sync-to-repo.ts`, ran the FULL reverse-sync on any edit touching `~/.claude/{hooks,skills,rules,scripts,agents}` — so an edit to ANY active file clobbered ALL uncommitted repo edits in those dirs) | **Unregistered** from active + repo `settings.json`. Source retained (unused). |

**Defense in depth:** `sync-claude.sh --to-repo` now **aborts if the repo has uncommitted changes** in the synced dirs (`rules/agents/skills/scripts/docs/hooks`) — so even a re-introduced or accidental reverse-sync can't clobber fresh repo work. Commit or stash repo edits before reverse-syncing.

## Workflow

1. Branch off `main`: `git checkout -b feature/name`. No feature work on `main`.
2. Commit on the branch. The hook prints "Sync skipped".
3. Push to `fork` and open a PR.
4. After Dave says merge, run `pwsh -File scripts/github/land-pr.ps1 -Pr <N>`.
5. Confirm the sync: `~/.claude/state/sync-cursor` equals `git rev-parse main`.

## Pull from Team

```bash
cd ~/continuous-claude && git pull
# If post-commit didn't run, manual sync:
bash ~/continuous-claude/scripts/sync-to-active.sh
```

## Edits in ~/.claude

The next sync quarantines a direct edit or a hand copy in `~/.claude`, even when it is identical to
the repo. Edit the repo instead. To keep an urgent active edit, run the reverse sync (above), then
commit it on a branch.

## Key Commands

| Task | Command |
|------|---------|
| Manual forward sync | `bash ~/continuous-claude/scripts/sync-to-active.sh` |
| Manual reverse sync | `bash ~/continuous-claude/scripts/sync-claude.sh --to-repo` |
| Rebuild hooks | `cd ~/continuous-claude/.claude/hooks && npm run build` (never in `~/.claude/hooks`: stale `src`) |
| Check repo status | `cd ~/continuous-claude && git status` |
