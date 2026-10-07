# ccv3-mods

CCv3 function-hook mods for Claude Code 2.1.292+. One plugin, one module per mod.
Plan: `.claudedocs/2026-10-07-mods-plan.md` in the primary checkout.

## Mods

| Module | What it does |
|---|---|
| `hooks/agentic-os/` | Captures this session's tasks (`TaskCreate`, `TaskUpdate`, `TodoWrite`), plan (`ExitPlanMode`), current step and context %. Draws one band above the prompt. Writes `~/.claude/state/agentic-os/<session-id>.json` after each task, plan or turn change. Observer only: it never denies or rewrites a call. |
| `/os` (same module) | Opens the Agentic OS pane: PLAN, TASKS (finished tasks fold first), NOW, AGENTS, LANE, ctx %. Zero model tokens. Reads this session's lanes with `lane.mjs mine --json` from `~/continuous-claude` when present. Elapsed times redraw every 5 s while a turn runs. |

## Load

- Development, one session, from the repo root: `claude --plugin-dir .claude/plugins/ccv3-mods`
- Every session: `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json` (not wired yet).

## Check

Run from the repo root:

1. `tsc -p .claude/plugins/ccv3-mods` (the engine writes `tsconfig.json` and `.claude-plugin/types/` on load)
2. `claude plugin validate .claude/plugins/ccv3-mods`
3. `claude plugin test .claude/plugins/ccv3-mods`
4. End to end: `claude -p --plugin-dir .claude/plugins/ccv3-mods --allowedTools TaskCreate TaskUpdate --output-format json` with a prompt that creates tasks. Then read the snapshot file named by the run's `session_id`.

## Facts proven on 2.1.292 (2026-10-07)

- Mods load in headless `claude -p` runs.
- A mod `tool.call` hook runs outside the `settings.json` PreToolUse hooks. A settings-hook block reaches the mod as a result with `isError: true` and the hook's text, not as `deny`.
- A `command.run` hook that answers its own command makes no model call: `claude -p "/os"` ran 0 turns at $0.
- In `claude plugin test`, op events (`fs.exists`, `process.run`, `agent.list`, `ui.open`, `session.id`) are answered with `{ value }`.
- `e.tool_use_id` in `tool.call` equals the transcript's `tool_use` id.
- In `claude plugin test`, a `Text` element's `key` is not kept. Find band text by `type: 'Text'`.
