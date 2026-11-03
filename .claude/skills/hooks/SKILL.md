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

In a git worktree, link `.claude/hooks/node_modules` to the primary checkout's copy. Do not run `npm install` there. On Windows, use a junction (`New-Item -ItemType Junction`). On macOS or Linux, use a symlink (`ln -s`). The build uses `--preserve-symlinks`, so the link does not change any `dist/*.mjs` file.

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
