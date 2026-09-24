# Hook Subsystem

## Lifecycle

```
SessionStart ──────→ Runs once when Claude session begins
                     • session-start-docker (ensure services)
                     • session-start-parallel (setup tasks)
                     • hook-health-monitor [BT: hook_health_ratio]

UserPromptSubmit ──→ Runs when user sends a message
                     • heartbeat (session keepalive)
                     • memory-awareness (inject memories) [BT: memory_recall_*]
                     • skill-activation (detect skill triggers)

PreToolUse ────────→ Runs BEFORE each tool execution
                     • file-claims (distributed locking) [CAN BLOCK]
                     • package-install-guard:Bash (supply-chain) [CAN BLOCK]
                     • task-router (suggest better agent)
                     • explore-to-scout (redirect Explore→scout)

PostToolUse ───────→ Runs AFTER each tool execution
                     • epistemic-reminder (verify grep claims)
                     • roadmap-completion (track progress)
                     • git-commit-roadmap (log commits to ROADMAP)
                     • post-plan-roadmap (update ROADMAP on plan exit)
                     • prd-roadmap-sync (sync PRD files to ROADMAP)
                     • telemetry-tracker:Skill|Task [BT: tool_call_success,
                       skill_trigger_accuracy]
                     • plan-exit-premortem-prompt:ExitPlanMode

[BT: …] = Braintrust deterministic emit site (see Braintrust Emit Hooks below)
```

## Hook Response Schema

Output contracts are event-specific. The two most common:

```typescript
// PreToolUse — allow or block the tool call
interface PreToolUseOutput {
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny";
    permissionDecisionReason?: string;
  };
}

// PostToolUse / UserPromptSubmit / SessionStart — inject context
interface PostToolUseOutput {
  hookSpecificOutput?: {
    hookEventName: "PostToolUse";
    additionalContext: string; // reliable inject pattern
  };
}
```

| Event | Output contract |
|-------|-----------------|
| PreToolUse | `{ hookSpecificOutput: { permissionDecision: "allow" \| "deny" } }` |
| PostToolUse | `{ hookSpecificOutput: { additionalContext: "..." } }` |
| SessionStart | `{ hookSpecificOutput: { additionalContext: "..." } }` |
| UserPromptSubmit | `{ hookSpecificOutput: { additionalContext: "..." } }` |
| SessionEnd | `{}` |

## Key Hooks

| Hook | Trigger | Can Block | Purpose |
|------|---------|-----------|---------|
| file-claims | PreToolUse:Edit | Yes | Prevent file conflicts |
| task-router | PreToolUse:Task | No | Suggest better agent |
| explore-to-scout | PreToolUse:Task | No | Redirect Explore→scout |
| memory-awareness | UserPromptSubmit | No | Inject relevant memories |
| heartbeat | UserPromptSubmit | No | Session keepalive |
| epistemic-reminder | PostToolUse:Grep | No | Verify before claiming |

## Braintrust Emit Hooks

Four TypeScript hooks emit Braintrust deterministic scores by calling
`await emitBraintrustScore(...)` from the shared helper
`hooks/src/shared/braintrust-score.ts`. These are the live, in-path half of
the [Braintrust observability subsystem](braintrust.md).

| Hook | Lifecycle event | Dimension(s) emitted |
|------|-----------------|----------------------|
| `memory-awareness` | UserPromptSubmit | `memory_recall_relevance`, `memory_recall_hit` |
| `telemetry-tracker` | PostToolUse:Skill\|Task | `tool_call_success`, `skill_trigger_accuracy` |
| `hook-health-monitor` | SessionStart | `hook_health_ratio` |

(A fifth dimension, `memory_store_quality`, is emitted by the Python
`store_learning.py`, not a hook.)

### The audit invariant

`scripts/audit-braintrust-emits.sh` greps `hooks/src/` for
`await emitBraintrustScore(` and asserts an exact count of awaited emit
sites. **Run it after ANY TypeScript hook edit.**

- The emit MUST be `await` (not `void`) on a single line. A `void` call is
  fire-and-forget — SessionStart-class hooks exit before the HTTPS POST
  lands, dropping the score. The grep matches `await` only, so a `void`
  revert or a line-split trips the check.
- Never lower the invariant to silence a failure — fix the code it points at.
  (The emit sites regressed ~8 times in May 2026; root cause was a rogue
  Ralph loop plus an asymmetric reverse-sync, both since fixed — see the
  Braintrust subsystem doc for the corrected history.)

### Sync exclusion for `hooks/src/`

The TypeScript hook **source** is no longer carried by sync in either
direction — the active hooks run from compiled `dist/*.mjs`:

| Direction | Script | `hooks/src/` carried? |
|-----------|--------|-----------------------|
| Forward (repo → `~/.claude/`) | `sync-to-active.sh` | No — only `dist/*.mjs` |
| Reverse (`~/.claude/` → repo) | `sync-claude.sh --to-repo` | No (since `ddc0641`) + pre-flight audit gate |

Edit hook source in the repo, build, then sync `dist/`.

## File Locations

```
~/.claude/hooks/
├── src/                 # TypeScript source (edited in the repo, NOT mirrored — see below)
│   ├── file-claims.ts
│   ├── memory-awareness.ts
│   └── ...
├── dist/                # Compiled ESM bundles (esbuild) — this is what runs
│   └── *.mjs
└── package.json         # scripts: build (esbuild), check (tsc --noEmit), test (vitest)
```

## Creating a Hook

1. Create `~/.claude/hooks/src/my-hook.ts`
2. Implement hook logic matching the lifecycle event (read stdin, print the output contract)
3. Build: `cd .claude/hooks && npm run build` → produces `dist/my-hook.mjs`
4. Register in `~/.claude/settings.json`

```typescript
// Example PreToolUse hook — reads JSON from stdin, prints decision to stdout
const input = JSON.parse(await readStdin());
if (input.tool_name === "Edit") {
  // Check something, then allow or deny
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow", // or "deny" to block
    },
  }));
}
```

## Registration

In `~/.claude/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit",
        "hooks": [
          { "type": "command", "command": "node ~/.claude/hooks/dist/file-claims.mjs" }
        ]
      }
    ]
  }
}
```

## Debugging Hooks

```bash
# Test hook directly (pass session_id so state-file paths match)
echo '{"tool_name":"Edit","tool_input":{},"session_id":"test"}' | node ~/.claude/hooks/dist/my-hook.mjs

# Run hook tests (vitest, NOT jest)
cd .claude/hooks && npx vitest run src/__tests__/my-hook.test.ts

# Check hook output in Claude
# Hooks log to stderr, visible in terminal
```

## Common Patterns

| Pattern | Use Case |
|---------|----------|
| Block + suggest | PreToolUse blocks, suggests alternative |
| Inject context | UserPromptSubmit adds info to message |
| Log + continue | PostToolUse logs without modifying |
| Redirect | PreToolUse modifies tool input |

## Deep Dive

For comprehensive hook documentation (718 lines) with exit codes, MCP patterns, and examples:
→ `~/continuous-claude/docs/hooks/README.md`
