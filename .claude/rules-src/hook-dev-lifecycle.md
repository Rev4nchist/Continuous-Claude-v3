---
paths:
  - ".claude/hooks/**"
---

# Hook Development Lifecycle

## Full Workflow

1. **Scaffold** — use `/hook-scaffold` skill or create `.claude/hooks/src/<name>.ts` manually
2. **Implement** — write hook logic in TypeScript (see Event Types below)
3. **Build** — `cd ~/continuous-claude/.claude/hooks && npm run build` → produces `dist/<name>.mjs`. Never build in `~/.claude/hooks`: its `src` is a stale copy.
4. **Register** — add entry to `~/.claude/settings.json` using Node.js atomic write (never Edit tool)
5. **Test** — `cd .claude/hooks && npx vitest run src/__tests__/<name>.test.ts`
6. **Sync** — `bash scripts/sync-to-active.sh` (or commit triggers auto-sync)
7. **Verify** — start a new session, confirm hook runs

## Event Types and Output Contracts

| Event | When | Output |
|-------|------|--------|
| PreToolUse | Before tool executes | `{ permissionDecision: "allow"\|"deny" }` |
| PostToolUse | After tool executes | `{ hookSpecificOutput: { additionalContext: "..." } }` |
| SessionStart | Session begins | `{ hookSpecificOutput: { additionalContext: "..." } }` |
| SessionEnd | Session closes | `{}` |
| UserPromptSubmit | User sends message | `{ hookSpecificOutput: { additionalContext: "..." } }` |

## Common Failure Modes

| Failure | Cause | Fix |
|---------|-------|-----|
| Hook silently doesn't run | Missing registration in settings.json | Run `/hook-audit` to find unregistered hooks |
| Widening a matcher changes nothing | **Two gates.** The hook's own `main()` still rejects the new tool (`if (data.tool_name !== 'Bash') return;`). The matcher lets the event in; the runtime check drops it, so the symptom does not move and the matcher edit looks wrong. Hit 2026-08-05 across all 4 PowerShell-registered hooks. | Widen the runtime check in the SAME change. Gate on a `COMMAND_TOOLS` set. Guard: `hook-matcher-runtime-consistency.test.ts` |
| Hook runs forever and never does its job | **Both gates agree with each other and BOTH are wrong.** The matcher and the runtime check name the same tool, so `hook-matcher-runtime-consistency.test.ts` passes — but that tool no longer exists under that name. `tldr-context-inject` was registered on matcher `Task` and opened with `if (input.tool_name !== 'Task') return;` while the live subagent tool is named **`Agent`**. It returned `{}` on every spawn for ~159 days and injected exactly zero times. Commit `d8d7343` (2026-03-06, "Task→Agent rename") widened ~10 sibling hooks and missed it. Deleted 2026-08-17. | **No guard covers this today.** A green consistency test is not evidence the hook fires. Verify against REALITY: grep recent transcripts in `~/.claude/projects/*/` for `"name":"<Tool>"` to confirm the matcher names a tool that actually appears, and check the hook's own telemetry sink for a non-zero row count. |
| dist file missing | Never built or build failed | `cd ~/continuous-claude/.claude/hooks && npm run build` |
| Stale behavior | src changed but dist not rebuilt | `cd ~/continuous-claude/.claude/hooks && npm run build` |
| Hook errors in stderr | Logic error in TS code | Check `~/.claude/hooks/dist/<name>.mjs` output |
| settings.json race | Used Edit tool on settings.json | Use Node.js atomic read-modify-write instead |
| Sync gap | Changed in repo, not in ~/.claude | `bash scripts/sync-to-active.sh` |
| Windows encoding crash | Unicode/emoji in Python hooks | Use ASCII only |
| SessionEnd "Hook cancelled" | Blocking spawnSync exceeds timeout | Use fire-and-forget spawn (detached, unref'd) for long operations; bump timeout to 30-60s in settings.json |
| Prior-phase code silently missing | Later agent regenerated whole file from context, lost the addition (NOT a linter — confirmed no formatter exists). Known instances. | After any TS hook edit, run `npx vitest run` and `npm run build` in `.claude/hooks`, and review `git diff` for deleted lines |

## Key Architecture Notes

- Hooks are TypeScript in `.claude/hooks/src/`, compiled by esbuild to `dist/*.mjs`
- Test framework: **vitest** (NOT jest) — `npm test` or `npx vitest run`
- Settings.json is NOT auto-synced — update in both repo and `~/.claude/`
- Context injection: `PostToolUse additionalContext` is the reliable inject pattern
- Permission blocking: `PreToolUse permissionDecision: "deny"` blocks the tool call
- Pass `session_id` in all test inputs — without it, child processes get PID-based IDs that break state file matching

## Registering a Hook (settings.json)

```bash
node -e "
const fs = require('fs');
const p = process.env.HOME+'/.claude/settings.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
s.hooks.PostToolUse = s.hooks.PostToolUse || [];
s.hooks.PostToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: 'node ~/.claude/hooks/dist/<name>.mjs' }] });
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
"
```

## References

- Hook health check: `/hook-audit` skill
- Hook scaffold: `/hook-scaffold` skill
- Sync drift check: `/sync-drift` skill
- Full hook catalog: `.claude/docs/architecture/quick-ref/hook-catalog.md`
