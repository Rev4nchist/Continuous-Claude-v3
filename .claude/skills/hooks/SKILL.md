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

A bare worktree gets `pg` through the shared resolver (scripts/lib/resolve-deps.mjs) and NODE_PATH. The shared store link (`.claude/worktrees/node_modules`) serves vitest, the hooks build and the bins from every nested worktree. Run `node scripts/worktree/shared-deps.mjs --check` in the primary. The one-time `--apply` needs Dave's yes. Run it in the primary, never in a worktree. pre-pr names a missing package in one ENV line.

Use the hand junction only for a worktree outside the primary. Link `.claude/hooks/node_modules` to the primary checkout's copy. Do not run `npm install` there. Run the command from the worktree root and replace `<primary>` with the primary checkout path:
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
