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

## Reverse Sync is MANUAL-ONLY (root-cause fix, 2026-06-01)

**The repo is the single source of truth.** Forward sync (repo → active) is the ONLY automatic direction. Reverse sync (active → repo) is **manual-only** — run it deliberately, and only when you edited `~/.claude/` directly and want those edits captured in the repo:

```bash
bash ~/continuous-claude/scripts/sync-claude.sh --to-repo
```

**Why manual-only:** two *automatic* reverse-sync triggers used to race the background forward-sync and **clobber fresh repo edits with stale active copies** (they reverted `rules/codex-adversarial.md` twice on 2026-06-01; the emit-only audit gate doesn't protect non-emit docs). Both were disabled at the root:

| Trigger | Fix |
|---------|-----|
| `~/.claude/.git/hooks/post-commit` (hand-rolled, ran `sync-claude.sh --to-repo` on every active commit) | **Neutered to a no-op.** Backup at `post-commit.bak.2026-05-31`. |
| `sync-to-repo` PostToolUse:Write\|Edit hook (`hooks/src/sync-to-repo.ts`, ran the FULL reverse-sync on any edit touching `~/.claude/{hooks,skills,rules,scripts,agents}` — so an edit to ANY active file clobbered ALL uncommitted repo edits in those dirs) | **Unregistered** from active + repo `settings.json`. Source retained (unused). |

**Defense in depth:** `sync-claude.sh --to-repo` now **aborts if the repo has uncommitted changes** in the synced dirs (`rules/agents/skills/scripts/docs/hooks`) — so even a re-introduced or accidental reverse-sync can't clobber fresh repo work. Commit or stash repo edits before reverse-syncing.

## Quick Workflow

```bash
# 1. Make changes in continuous-claude
cd ~/continuous-claude
# edit files...

# 2. Commit (auto-syncs to ~/.claude)
git add .claude/
git commit -m "feat: description"

# 3. Push to remote
git push
```

## Pull from Team

```bash
cd ~/continuous-claude && git pull
# If post-commit didn't run, manual sync:
bash ~/continuous-claude/scripts/sync-to-active.sh
```

## Quick Fixes in ~/.claude

For urgent fixes made directly in ~/.claude:

```bash
# 1. Fix is auto-committed by git-auto-commit hook

# 2. Sync back to repo when ready
bash ~/continuous-claude/scripts/sync-claude.sh --to-repo

# 3. Commit in repo
cd ~/continuous-claude && git add .claude/ && git commit -m "fix: description"
```

## Branching in continuous-claude

| Scenario | Branch? |
|----------|---------|
| Quick fix, simple rule | No |
| New hook development | Yes |
| Major refactor | Yes |
| Experimental feature | Yes |

```bash
cd ~/continuous-claude
git checkout -b feature/name
# develop...
git checkout main && git merge feature/name
git branch -d feature/name
```

## Key Commands

| Task | Command |
|------|---------|
| Manual forward sync | `bash ~/continuous-claude/scripts/sync-to-active.sh` |
| Manual reverse sync | `bash ~/continuous-claude/scripts/sync-claude.sh --to-repo` |
| Rebuild hooks | `cd ~/.claude/hooks && npm run build` |
| Check repo status | `cd ~/continuous-claude && git status` |
