# Hook Catalog

## By Lifecycle

### SessionStart
| Hook | Purpose | Blocks |
|------|---------|--------|
| session-start-docker | Ensure Docker services running | No |
| session-start-parallel | Parallel setup tasks | No |

### UserPromptSubmit
| Hook | Purpose | Blocks |
|------|---------|--------|
| heartbeat | Session keepalive to database | No |
| memory-awareness | Inject relevant memories | No |
| skill-activation | Detect skill triggers | No |

### PreToolUse
| Hook | Matches | Purpose | Blocks |
|------|---------|---------|--------|
| file-claims | Edit | Distributed file locking | **Yes** |
| task-router | Task | Suggest better agent | No |
| explore-to-scout | Task | Redirect Explore→scout | No |
| hook-auto-execute | * | Auto-run blocked commands | No |

### PostToolUse
| Hook | Matches | Purpose | Blocks |
|------|---------|---------|--------|
| epistemic-reminder | Grep | Warn about grep claims | No |
| roadmap-completion | Edit | Track roadmap progress | No |

## Blocking Hooks

Only PreToolUse hooks can block. When blocked:

```json
{
  "decision": "block",
  "reason": "File claimed by another session"
}
```

The tool execution is prevented and reason shown.

## File Locations

```
~/.claude/hooks/
├── src/              # TypeScript source
├── dist/             # Compiled JS (run these)
├── build.sh          # Compiler script
└── package.json
```

## Registration

In `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit",
        "hooks": ["node ~/.claude/hooks/dist/file-claims.js"]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Grep",
        "hooks": ["node ~/.claude/hooks/dist/epistemic-reminder.js"]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": ["node ~/.claude/hooks/dist/memory-awareness.js"]
      }
    ]
  }
}
```

## Common Hook Patterns

| Pattern | Example | Use Case |
|---------|---------|----------|
| Block + reason | file-claims | Prevent conflicts |
| Inject message | memory-awareness | Add context |
| Log + continue | heartbeat | Tracking |
| Modify input | task-router | Redirect |

## Debugging

```bash
# Test hook manually
echo '{"tool_name":"Edit","tool_input":{}}' | \
  node ~/.claude/hooks/dist/my-hook.js

# Hook stderr visible in terminal
# Check for JSON parse errors
```

## Creating New Hooks

1. Create `src/my-hook.ts`
2. Export lifecycle function
3. Run `./build.sh`
4. Add to settings.json
5. Test with echo | node
