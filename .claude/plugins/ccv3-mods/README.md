# ccv3-mods

CCv3 function-hook mods for Claude Code 2.1.292+. One plugin, one module per mod.
Plan: `.claudedocs/2026-10-07-mods-plan.md` in the primary checkout.

## Mods

| Module | What it does |
|---|---|
| `hooks/agentic-os/` | Captures this session's tasks (`TaskCreate`, `TaskUpdate`, `TodoWrite`), plan (`ExitPlanMode`), current step and context %. Draws one band above the prompt. Writes `~/.claude/state/agentic-os/<session-id>.json` after each task, plan or turn change. Observer only: it never denies or rewrites a call. |
| `/os` (same module) | Opens the Agentic OS pane: PLAN, TASKS (finished tasks fold first), NOW, AGENTS, LANE, ctx %. Zero model tokens. Reads this session's lanes with `lane.mjs mine --json` from `~/continuous-claude` when present. Elapsed times redraw every 5 s while a turn runs. Interactive sessions only. |

## Load

- Development, one session, from the repo root: `claude --plugin-dir .claude/plugins/ccv3-mods`
- Every session: `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, set to the active copy `~/.claude/plugins/ccv3-mods`. The engine reads it only from the process env or that file, never from project settings. The settings template carries it as `{{CLAUDE_HOME}}/plugins/ccv3-mods`. Forward sync (`scripts/sync-to-active.sh`) copies the plugin to `~/.claude/plugins/ccv3-mods` and never touches the engine-written `.claude-plugin/types/`.

## Where it runs

| Run | Capture and snapshots | 5 s pulse, `lane.mjs`, `/os`, band |
|---|---|---|
| Interactive (`isInteractive` true) | Yes | Yes |
| Headless (`claude -p`, SDK; `isInteractive` false) | Yes, with a limit: a snapshot is written after a task or plan change, and at turn end only when the session holds a task or a plan. A headless run with neither writes no file | No. Nothing is spawned and no timer is armed |
| `CCV3_MODS_OFF=1` in the process env | No. Every hook passes the event on | No |

Nothing prunes `~/.claude/state/agentic-os/`. The limit above keeps scheduled reports, probes and workflow agents from adding one file per run. Test: `G9 G10 G11` in `tests/gating.test.ts`.

`session.start` sets the mode on each run. A hot reload runs `register` again and fires `session.start` for the changed module (types: `session.start`, "a reload (changed modules only)"). The old environment's timers are dropped and the new `session.start` arms the pulse again. Test: `G5 G8` in `tests/gating.test.ts`.

## Check

This is the testing row for a mod. It lives here, not in `AGENTS.md`: that file is always loaded and has 5 characters of headroom under `scripts/rules/context-budget.json` (a one-row addition measured 23747 of 23516).

Run from the repo root:

1. `node scripts/mods/validate-mods.mjs [--min-gating N]`. One command, one summary line, exit 1 on failure. It runs `claude plugin validate --json` (fails when any `gatingHooks` entry lacks `.catch`, when the report has no `gatingHooks` key, or when it lists fewer than N hooks, default 1; unit test: `node --test scripts/mods/validate-mods.test.mjs`), `tsc -p .claude/plugins/ccv3-mods` and `claude plugin test .claude/plugins/ccv3-mods`. The engine writes `.claude-plugin/types/` on a load; a fresh worktree has none until step 2 has run once, and `tsc` then reports NOT RUN, never a pass.
2. End to end: `node scripts/mods/e2e-headless.mjs`. It runs `claude -p --plugin-dir .claude/plugins/ccv3-mods --allowedTools TaskCreate TaskUpdate --output-format json` with a prompt that creates tasks, then reads the snapshot named by the run's `session_id`. The snapshot must hold `lanes: null` (a headless run never reads the lane board). The run clears `CLAUDE_CODE_PLUGIN_DIRS` and writes a debug log; that log must show one folder loaded as `ccv3-mods`. A second run with `CCV3_MODS_OFF=1` must write no snapshot. Output goes to `.claude/cache/e2e/<date>-mods-headless-*.json`.

## Facts proven on 2.1.292 (2026-10-07)

- Mods load in headless `claude -p` runs.
- A mod `tool.call` hook runs outside the `settings.json` PreToolUse hooks. A settings-hook block reaches the mod as a result with `isError: true` and the hook's text, not as `deny`.
- A `command.run` hook that answers its own command makes no model call: `claude -p "/os"` ran 0 turns at $0. Proven before the headless gate: `/os` is now registered in interactive sessions only.
- In `claude plugin test`, op events (`fs.exists`, `process.run`, `agent.list`, `ui.open`, `session.id`) are answered with `{ value }`.
- `e.tool_use_id` in `tool.call` equals the transcript's `tool_use` id.
- In `claude plugin test`, a `Text` element's `key` is not kept. Find band text by `type: 'Text'`.
- A headless `claude -p --plugin-dir` run writes `.claude-plugin/types/` (seen on 2.1.293, 2026-10-07), so one e2e run is enough to make `tsc -p` work in a fresh worktree.
- A headless snapshot has `lanes: null`: the lane board is never read there.
- Two plugins named `ccv3-mods` (one from `--plugin-dir`, one from `CLAUDE_CODE_PLUGIN_DIRS`) do not both load. The debug log says `hooks module ccv3-mods@inline not loaded: another plugin of that name loads first`. With the repo copy on `--plugin-dir` and a marked copy on the env var, the snapshot came from the repo copy. Seen on 2.1.293, 2026-10-07. The e2e run still clears the env var so a stale copy cannot stand in for the repo copy.
