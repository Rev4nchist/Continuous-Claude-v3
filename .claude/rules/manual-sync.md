# Manual Sync to continuous-claude

The auto-sync via git post-commit hooks doesn't work reliably in all environments.

## Manual Sync Command

Run this after making changes to ~/.claude:

```bash
cp -r ~/.claude/rules/* ~/continuous-claude/.claude/rules/ && \
cp -r ~/.claude/hooks/src/* ~/continuous-claude/.claude/hooks/src/ && \
cp -r ~/.claude/skills/* ~/continuous-claude/.claude/skills/ && \
cp -r ~/.claude/agents/* ~/continuous-claude/.claude/agents/ && \
cd ~/continuous-claude && git add .claude/ && git status
```

Or use the sync script:

```bash
bash ~/continuous-claude/scripts/sync-claude.sh --to-repo
```

## When to Sync

- After creating/editing rules
- After modifying hooks
- After adding skills or agents
- Before pushing to continuous-claude
