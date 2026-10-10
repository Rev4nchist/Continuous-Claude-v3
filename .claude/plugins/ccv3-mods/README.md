# ccv3-mods

CCv3 function-hook mods for Claude Code 2.1.292+. One plugin, one module per mod. Designs: the "CCv3 Mods" canvas (2026-10-09).
Plan: `.claudedocs/2026-10-07-mods-plan.md` in the primary checkout.

## Mods

| Module | What it does |
|---|---|
| `hooks/agentic-os/` | Captures this session's tasks (`TaskCreate`, `TaskUpdate`, `TodoWrite`), plan (`ExitPlanMode`), current step and context %. Draws one band above the prompt. Writes `~/.claude/state/agentic-os/<session-id>.json` after each task, plan or turn change. Observer only: it never denies or rewrites a call. |
| `/os` (same module) | Opens the Agentic OS pane: PLAN, TASKS (finished tasks fold first), NOW, AGENTS, LANE, ctx %. Zero model tokens. Reads this session's lanes with `lane.mjs mine --json` from `~/continuous-claude` when present. Elapsed times redraw every 5 s while a turn runs. Interactive sessions only. |

| `hooks/pr-loop/` | Replaces the old review `/loop` cron. Tools `pr_watch {pr}` (interactive only) and `pr_status {pr}` for the model, commands `/watch` and `/land` for Dave. Every 5 minutes an interactive session runs `scripts/github/review-status.mjs <N> --json` per watched PR (reviewer: Greptile). At READY, merged or closed Dave gets a toast; at READY, a review Greptile did not finish (LIMITED), a reviewed head with open threads, a confidence below 4/5 or a failed check (REVIEWED), or no review 60 minutes after the head appeared (STALLED) the model gets one line. REVIEWED and STALLED alert once per head and keep the watch; the REVIEWED line points the model at "When the review lands" in `pr-review-loop.md`. A READY alert answered No still gives the model its report line. It never merges. The watch list is in `$.store` under `pr-watch:<session-id>`, so a reload re-arms it. An error all PRs share (rate limit, failed spawn, a status script without `prState`) backs the checks off to 15 minutes. An error of one PR alone (404, a list too long) counts against that PR; the third in a row drops it with a toast. `pr_watch` and `/watch N` probe first and refuse a PR whose status cannot be read. The Agentic OS band and pane show a PRS row. |
| `/watch` (same module) | `/watch` lists the watched PRs. `/watch N` adds one. `/watch N --once` answers with the status and arms nothing. Headless, `/watch N` is `--once`. |
| `/land N` (same module) | Answers without a model call. Shows the status. When READY and interactive it asks `Land #N?` with `Land` or `No`. Pressing Land is Dave's merge yes: it runs `land-pr.ps1 -Pr N` through the PowerShell (else Bash) tool with `consent`. Dismiss, No, an error or a headless run lands nothing. `/land N --when-ready` watches the PR and asks Land/No when it turns READY. With no shell tool, Land hands the model one instruction instead. An aborted Land call (Escape) re-submits nothing. |
| `hooks/hud/` (HUD) | A row on top of the Agentic OS band: main-loop model and effort (red below `high`, the 2026-09-30 pin), the advisor (on, off, or blocked with the env var that blocks it; `×N` counts its uses), a ctx ring, the session cost and the 5h / 7d / spend-limit bars from `session.measure` (the engine's own /cost ledger). Svg ring and bars on desktop, text gauges on the terminal. Interactive only. Off: `CCV3_MOD_HUD_OFF=1`. |
| `hooks/agent-ledger/` (`/agents`) | One run per subagent from `agent.spawn`: tokens and an estimated cost per model request (`turn.step`, price table in `hooks/shared/price.ts`), settled at each `turn.complete` (a teammate runs again after it). Flags tier drift against the agent's `.md` (`model:`, `effort:`; `inherit` is no tier; a numeric effort is a budget, not compared) and any Haiku run. The band shows `◉ N running · ≈$x`. Records headless too (the snapshot carries `agentRuns`). Off: `CCV3_MOD_LEDGER_OFF=1`. |
| `hooks/cache-guard/` | Holds the first plain composer send after the prompt cache went cold (60 min on a subscription, 5 min on an API key; `CCV3_CACHE_TTL_MIN` overrides), once per cold window, puts the text back in the prompt box and shows the cold (cache write, 1-hour rate on a subscription) and warm (cache read) cost. The next Enter sends it. Never holds: headless runs, non-composer origins, mid-turn messages, slash or `!` commands, messages with attachments, surfaces other than terminal and desktop. `/clear` and compaction reset its clock. Off: `CCV3_MOD_CACHE_OFF=1`. |
| `hooks/touched-files/` (`/files`) | A tree of only the files this session's own tool calls named: read (dim), edited (accent, +/- lines), committed (green). A shell `git commit` counts only if `HEAD` moved, then flips the edited files `git show --name-only HEAD` lists. Never lists a folder. Off: `CCV3_MOD_FILES_OFF=1`. |
| `hooks/skin/` (`/skin on\|off`) | OFF by default. Tool rows with an icon, the main argument, a timing chip and a tier badge on Agent rows; collapsed groups as one line; Edit and Write results as numbered diff cards from `structuredPatch`. Any tool it doesn't know, an expanded group, an errored or patchless result: the engine draws its own. The choice is kept in `$.store`. Off: `CCV3_MOD_SKIN_OFF=1`. |
| `hooks/shared/` | Pure helpers the modules share: tiers, price table, Svg glyphs, tone map. |

## Load

- Development, one session, from the repo root: `claude --plugin-dir .claude/plugins/ccv3-mods`
- Every session: `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`, set to the active copy `~/.claude/plugins/ccv3-mods`. The engine reads it only from the process env or that file, never from project settings. The settings template carries it as `{{CLAUDE_HOME}}/plugins/ccv3-mods`. Forward sync (`scripts/sync-to-active.sh`) copies the plugin to `~/.claude/plugins/ccv3-mods` and never touches the engine-written `.claude-plugin/types/`.

## Where it runs

| Run | Capture and snapshots | 5 s pulse, `lane.mjs`, `/os`, band |
|---|---|---|
| Interactive (`isInteractive` true) | Yes | Yes |
| Headless (`claude -p`, SDK; `isInteractive` false) | Yes, with a limit: a snapshot is written after a task or plan change, and at turn end only when the session holds a task or a plan. A headless run with neither writes no file | No. Nothing is spawned and no timer is armed |
| PR module (`hooks/pr-loop/`) | `/watch` and `/land` answer in both modes; `pr_status` is registered in both | Interactive only: the 5 minute watcher, `pr_watch`, the Land/No dialog and the Land call. Headless `/land` shows the status and lands nothing. |
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
- The plugin may hold one `session.start` hook without a matcher. A second one fails the whole plugin load. The PR module uses two hooks narrowed by `{ isInteractive: true }` and `{ isInteractive: false }`.
- `$` and atoms cannot cross an import. A helper that takes `$`, or an atom read with `read($, atom)`, must sit in the file of the hook. A pure helper (`model.ts`) may be imported. The `mode` and `prs` atoms are declared in each file that reads them, with the same plugin and key.
- A tool served by a mod answers with a string or a list of content blocks (`[{ type: 'text', text }]`). The MCP result object `{ content, isError }` fails with "result does not match its output shape". `claude plugin test` does not check this: only a live run does (`mcp__ccv3-mods__pr_status` called by the model).
- `$.prompt.submit` inside a `command.run` hook is refused ("it would wait on the turn this hook is holding"). Submit from `$.clock.after(1, ...)`.
- `$.tool.call` with `consent` inside a `command.run` hook works in `claude plugin test`. Live use of Land is not proven: no PR was landed.
- `claude -p "/watch 105"` from Git Bash: Git Bash rewrites a leading `/watch` to `C:/.../Git/watch`, the model gets plain text and spends a turn. Set `MSYS_NO_PATHCONV=1` or run from PowerShell. The E2E script is `.claude/cache/e2e/2026-10-07-pr-loop-run.sh` (gitignored).
- A headless `claude -p --plugin-dir` run writes `.claude-plugin/types/` (seen on 2.1.293, 2026-10-07), so one e2e run is enough to make `tsc -p` work in a fresh worktree.
- A headless snapshot has `lanes: null`: the lane board is never read there.
- Two plugins named `ccv3-mods` (one from `--plugin-dir`, one from `CLAUDE_CODE_PLUGIN_DIRS`) do not both load. The debug log says `hooks module ccv3-mods@inline not loaded: another plugin of that name loads first`. With the repo copy on `--plugin-dir` and a marked copy on the env var, the snapshot came from the repo copy. Seen on 2.1.293, 2026-10-07. The e2e run still clears the env var so a stale copy cannot stand in for the repo copy.

## Facts proven on 2.1.295-2.1.296 (2026-10-09, mod suite)

- A plugin holds one hook **without a matcher per event**, not only for `session.start`: a second unmatched `session.measure` failed the whole load ("registered twice without a matcher"). So `turn.step` (hooks/hud) and `turn.complete`, `tool.call`, `session.measure` (hooks/agentic-os) each serve every module; other modules use matched hooks (`{ tool: /regex/ }`, `{ component }`, `{ isInteractive }`). Several hooks with the same matcher load fine.
- In `claude plugin test`, `mock.clock(...).advance(ms)` is async: without `await` the clock does not move.
- `console.log` in a hooks module prints nothing under `claude plugin test`; a thrown error's text shows in the "hook was skipped" line, which is the way to read state there.
- On 2.1.296 a headless `claude -p --plugin-dir` run no longer writes `.claude-plugin/types/` (it did on 2.1.293), so `validate-mods.mjs` reports `tsc NOT RUN` in a fresh checkout. Type-check against the plugin-authoring skill's `types/claude-code.d.ts` with its header tsconfig until an interactive load writes the folder.
- `Svg` is in the desktop, vscode and mobile element tables, never the terminal's; every Svg part here has a text fallback.
- A `claude -p` started from inside a session inherits `CLAUDE_CODE_SESSION_ID` and reports the parent's `session_id` (and writes its snapshot there). `e2e-headless.mjs` drops it and passes `--session-id <uuid>` per run.
- **Unproven live:** Cache Guard puts a held message back with `$.prompt.fill` one tick after `{ drop }`. Tests (C3) prove the call, not that the desktop composer shows the text. Check once: `CCV3_CACHE_TTL_MIN=1`, wait two minutes, send a long message, and confirm the whole text is back in the box.
