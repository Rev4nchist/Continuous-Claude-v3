# Manual Sync from continuous-claude

The forward sync workflow: continuous-claude (repo) → ~/.claude (active).

## Quick Sync Command

Run this after making changes in continuous-claude:

```bash
bash ~/continuous-claude/scripts/sync-to-active.sh
```

Or with verbose output:

```bash
bash ~/continuous-claude/scripts/sync-to-active.sh --verbose
```

## Automatic Sync

A git post-commit hook auto-syncs after every commit in continuous-claude.

## When to Sync Manually

- After `git pull` in continuous-claude
- After editing files directly in continuous-claude
- After switching branches in continuous-claude

## What Gets Synced

| Directory | Synced |
|-----------|--------|
| hooks/src/ | ✓ |
| rules/ | ✓ |
| agents/ | ✓ |
| skills/ | ✓ |
| settings.json | ✗ (local only) |
| CLAUDE.md | ✗ (local only) |

## Quick Edits in ~/.claude

For quick fixes made directly in ~/.claude:
- `git-auto-commit.mjs` still creates safety commits
- Sync back to repo: `bash ~/continuous-claude/scripts/sync-claude.sh --to-repo`
