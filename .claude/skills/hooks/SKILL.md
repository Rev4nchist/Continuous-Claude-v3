---
name: hooks
description: 'Use when writing or changing a hook under .claude/hooks: the TypeScript source, the build to dist, registration and tests.'
metadata:
  user-invocable: false
---

# Hook Development Rules

When working with files in `.claude/hooks/`:

## Pattern
Shell wrapper (.sh) → TypeScript (.ts) via `npx tsx`

## Shell Wrapper Template
```bash
#!/bin/bash
set -e
cd "$CLAUDE_PROJECT_DIR/.claude/hooks"
cat | npx tsx <handler>.ts
```

## TypeScript Handler Pattern
```typescript
interface HookInput {
  // Event-specific fields
}

async function main() {
  const input: HookInput = JSON.parse(await readStdin());

  // Process input

  const output = {
    result: 'continue',  // or 'block'
    message: 'Optional system reminder'
  };

  console.log(JSON.stringify(output));
}
```

## Hook Events
- **PreToolUse** - Before tool execution (can block)
- **PostToolUse** - After tool execution
- **UserPromptSubmit** - Before processing user prompt
- **PreCompact** - Before context compaction
- **SessionStart** - On session start/resume/compact
- **Stop** - When agent finishes

## Testing
Test hooks manually:
```bash
echo '{"type": "resume"}' | .claude/hooks/session-start-continuity.sh
```

A bare worktree now gets `pg` through the shared resolver (scripts/lib/resolve-deps.mjs) and NODE_PATH, so the coordination and migration-gate tests run with no link. The junction below is still needed for the hooks build and vitest until the shared store lands (PR2). pre-pr names a missing package in one ENV line.

In a git worktree, link `.claude/hooks/node_modules` to the primary checkout's copy. Do not run `npm install` there. Run the command from the worktree root and replace `<primary>` with the primary checkout path:
- Windows: `New-Item -ItemType Junction -Path .claude\hooks\node_modules -Target <primary>\.claude\hooks\node_modules`
- macOS or Linux: `ln -s <primary>/.claude/hooks/node_modules .claude/hooks/node_modules`

The build uses `--preserve-symlinks`. With a Windows junction and this repo's flat npm `node_modules`, the link changes no `dist/*.mjs` file. The POSIX symlink case is untested. After a worktree build, check `git status` for `dist/` changes.

## Registration
Add hooks to `.claude/settings.json`:
```json
{
  "hooks": {
    "EventName": [{
      "matcher": ["pattern"],  // Optional
      "hooks": [{
        "type": "command",
        "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/hook.sh"
      }]
    }]
  }
}
```
