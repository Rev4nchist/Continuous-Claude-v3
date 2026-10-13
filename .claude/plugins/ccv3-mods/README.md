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
| `hooks/hud/` (HUD) | A row on top of the Agentic OS band: main-loop model and effort (red below `high`, the 2026-09-30 pin), the advisor (on, off, or blocked with the env var that blocks it; `×N` counts its uses), a ctx ring, the session cost, the cache element and the 5h / 7d / spend-limit bars from `session.measure` (the engine's own /cost ledger). Svg ring and bars on desktop, text gauges on the terminal. Interactive only. Off: `CCV3_MOD_HUD_OFF=1`. |
| ctx (same module) | The context figure moves after every main-loop request (`turn.step` reads `$.session.usage()`), not once per turn: the engine raises `session.measure` after a turn, so a turn of many requests held one value. At a compaction of the main conversation it becomes the size the engine recorded (`tokensAfter`), or nothing until the next response. `/clear` and a resume in the same process clear it. Captured in every run unless `CCV3_MODS_OFF=1`. |
| cache element and `/cache` (same module, `hooks/hud/cache.ts`) | Prompt-cache use of the main loop, summed per request: `cache 98% · 42m` is the share of all input tokens the cache served and the minutes its entry still has, counted from the send of the last request that read or wrote the cache. `MISS 97k` shows while the newest turn holds a request that rewrote prompt the cache held before. The first request of a fresh conversation is not flagged; the first request of a resumed one (it carries a history) is. `cache off` shows when no request read or wrote the cache. `cache COLD · next ≈$2.88` shows after the lifetime ran out, with the list-price cost of the next send. `/cache` prints the totals, an estimated saving and each miss with its idle gap, size and cause (session start, resume, expired, compaction, model change, prompt changed); it costs no model turn. The lifetime is a rule, not a reading: 60 minutes when the account reports a `five_hour` or `seven_day` window (a subscription), else 5; `CCV3_CACHE_TTL_MIN` overrides the minutes, not the write rate. Idle, the band redraws once a minute for the countdown. `/clear` and a resume in the same process start the counts over. The counts are captured in interactive and headless runs (not with `CCV3_MODS_OFF=1` or `CCV3_MOD_HUD_OFF=1`) and the snapshot carries them as `cache`; the element and `/cache` are interactive only. Subagents stay in the Agent Ledger. A miss is measured against what the cache held (the last request's cache read plus write), never against uncached input. Limit: a server-side tool loop (the advisor) reports one summed usage, so a miss between two responses of one request is not seen. Not proven live: that `tokensAfter` counts the system prompt and tools; if it does not, ctx and the cold cost read low from a compaction until the next response. |
| `hooks/agent-ledger/` (`/ledger`) | One run per subagent from `agent.spawn`: tokens and an estimated cost per model request (`turn.step`, price table in `hooks/shared/price.ts`), settled at each `turn.complete` (a teammate runs again after it). Flags tier drift against the agent's `.md` (`model:`, `effort:`; `inherit` is no tier; a numeric effort is a budget, not compared) and any Haiku run. The band shows `◉ N running · ≈$x`. Records headless too (the snapshot carries `agentRuns`). Off: `CCV3_MOD_LEDGER_OFF=1`. |
| `hooks/touched-files/` (`/files`) | A tree of only the files this session's own tool calls named: read (dim), edited (accent, +/- lines), committed (green). A shell `git commit` counts only if `HEAD` moved, then flips the edited files `git show --name-only HEAD` lists. Never lists a folder. Off: `CCV3_MOD_FILES_OFF=1`. |
| `hooks/shared/` | Pure helpers the modules share: tiers, price table, Svg glyphs, tone map, diagnostics (`diag.ts`), patch reading (`diff.ts`). |

**Archived (2026-10-12):** Cache Guard and CCv3 Skin were desktop-only. Dave works in the terminal, so desktop mod work stopped and both moved, with their tests, to `archive/ccv3-mods-desktop-2026-10/` at the repo root (restore notes in its README). Nothing here registers `/skin` or holds a send any more.

## Load

- Development, one session, from the repo root: `claude --plugin-dir .claude/plugins/ccv3-mods`
- Every session, terminal and desktop app: install it from the local marketplace `ccv3`, whose `marketplace.json` sits in this plugin's own `.claude-plugin/` (source `./`). Once, after a forward sync:
  `claude plugin marketplace add ~/.claude/plugins/ccv3-mods` then `claude plugin install ccv3-mods@ccv3 -s user`.
  This writes `extraKnownMarketplaces.ccv3` (a `directory` source) and `enabledPlugins["ccv3-mods@ccv3"]` to `~/.claude/settings.json`; the settings template carries both. A directory marketplace loads the plugin in place, so each forward sync takes effect at the next session with no reinstall (proven 2026-10-10: `hooks module ccv3-mods@ccv3 loaded`, `hooks.json` read from the source folder).
- Why not `CLAUDE_CODE_PLUGIN_DIRS`: the desktop app's Code tab runs its own copy of Claude Code, and the docs don't say it reads `env` from settings. On 2026-10-10 the env var loaded the mods in Dave's terminal and nothing in his desktop app. Remove the env var when installing: two plugins named `ccv3-mods` don't both load, and the inline one wins.
- Forward sync (`scripts/sync-to-active.sh`) copies the plugin to `~/.claude/plugins/ccv3-mods` and never touches the engine-written `.claude-plugin/types/`.

## Diagnostics

Every session start and every desktop attach writes `~/.claude/state/ccv3-mods/last-session.json` (`trigger` start or attach, `isInteractive`, `surface`, `sessionId`): if it isn't fresh after a session opened, the plugin did not load there. `~/.claude/state/ccv3-mods/sessions/<session-id>.<name>.json` keeps one file per session and trigger (`start`, `attach`) and per beacon (`enter`, `turn`, `error`), so a later session never overwrites them. A refused or failed command registration writes `~/.claude/state/ccv3-mods/errors/<time>-<where>.json` and the other modules carry on.

## Where it runs

| Run | Capture and snapshots | 5 s pulse, `lane.mjs`, `/os`, band |
|---|---|---|
| Interactive (`isInteractive` true) | Yes | Yes |
| Desktop app (an SDK start, `isInteractive` false, then `session.attach` on `desktop`) | Yes | Yes, from the attach: commands, HUD, pulse. pr-loop's watcher stays REPL-only |
| Headless (`claude -p`, SDK; `isInteractive` false) | Yes, with a limit: a snapshot is written after a task or plan change, and at turn end only when the session holds a task or a plan. A headless run with neither writes no file | No. Nothing is spawned and no timer is armed |
| PR module (`hooks/pr-loop/`) | `/watch` and `/land` answer in both modes; `pr_status` is registered in both | Interactive only: the 5 minute watcher, `pr_watch`, the Land/No dialog and the Land call. Headless `/land` shows the status and lands nothing. |
| `CCV3_MODS_OFF=1` in the process env | No. Every hook passes the event on | No |

Nothing prunes `~/.claude/state/agentic-os/`. The limit above keeps scheduled reports, probes and workflow agents from adding one file per run. Test: `G9 G10 G11` in `tests/gating.test.ts`.

`session.start` sets the mode on each run. A hot reload runs `register` again and fires `session.start` for the changed module (types: `session.start`, "a reload (changed modules only)"). The old environment's timers are dropped and the new `session.start` arms the pulse again. Test: `G5 G8` in `tests/gating.test.ts`.

## Check

This is the testing row for a mod. It lives here, not in `AGENTS.md`: that file is always loaded and has 5 characters of headroom under `scripts/rules/context-budget.json` (a one-row addition measured 23747 of 23516).

Run from the repo root:

1. `node scripts/mods/validate-mods.mjs [--min-gating N]`. One command, one summary line, exit 1 on failure. It runs `claude plugin validate --json` (fails when any `gatingHooks` entry lacks `.catch`, when the report has no `gatingHooks` key, or when it lists fewer than N hooks, default 1; unit test: `node --test scripts/mods/validate-mods.test.mjs`), `tsc -p .claude/plugins/ccv3-mods` and `claude plugin test .claude/plugins/ccv3-mods`. The engine writes `.claude-plugin/types/` on a load; a fresh worktree has none until step 2 has run once, and `tsc` then reports NOT RUN, never a pass.
2. End to end: `node scripts/mods/e2e-headless.mjs`. It runs `claude -p --plugin-dir .claude/plugins/ccv3-mods --allowedTools TaskCreate TaskUpdate --output-format json` with a prompt that creates tasks, then reads the snapshot named by the run's `session_id`. The snapshot must hold `lanes: null` (a headless run never reads the lane board). The run clears `CLAUDE_CODE_PLUGIN_DIRS` and writes a debug log; that log must show one hooks module loaded as `ccv3-mods`, the `--plugin-dir` copy (`ccv3-mods@inline`; the engine also reads the installed marketplace copy's `hooks.json` and loads no module from it). A second run with `CCV3_MODS_OFF=1` must write no snapshot. Output goes to `.claude/cache/e2e/<date>-mods-headless-*.json`.

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

## Facts proven on 2.1.296 (2026-10-13, ctx and cache)

- `session.measure` does not fire per request. In a headless run of 3 requests it fired at the first response (the first reading) and after `turn.complete`, and not for the second request, whose prompt had grown. Inside a `turn.step` hook, `$.session.usage()` read after `next(e)` already holds that response: `context.tokens` equals its input + cache read + cache write, and `percent` is rounded to the nearest whole number.
- The sums of `turn.step` usage over a run's main-loop requests equal the `usage` in the run's `--output-format json` result (cache read, cache write, input). `e2e-headless.mjs` checks this.
- The API reports the cache lifetime in the transcript (`cache_creation.ephemeral_1h_input_tokens`) and not in `turn.step`'s usage, which holds the four flat counts. On this subscription every write was a 1-hour entry.
- `$.command.register` accepts the name `cache`, and `claude -p "/cache"` answered by a `command.run` hook ran 0 turns at $0. Proven with a probe mod that registers at every start: this plugin registers `/cache` in interactive sessions only.
- In `claude plugin test`, a `session.compact` answer with an empty `messages` list is refused ("a compaction leaves at least one").

## Facts proven on 2.1.295-2.1.296 (2026-10-09, mod suite)

- A plugin holds one hook **without a matcher per event**, not only for `session.start`: a second unmatched `session.measure` failed the whole load ("registered twice without a matcher"). So `turn.step` (hooks/hud) and `turn.complete`, `tool.call`, `session.measure` (hooks/agentic-os) each serve every module; other modules use matched hooks (`{ tool: /regex/ }`, `{ component }`, `{ isInteractive }`). Several hooks with the same matcher load fine.
- In `claude plugin test`, `mock.clock(...).advance(ms)` is async: without `await` the clock does not move.
- `console.log` in a hooks module prints nothing under `claude plugin test`; a thrown error's text shows in the "hook was skipped" line, which is the way to read state there.
- On 2.1.296 a headless `claude -p --plugin-dir` run no longer writes `.claude-plugin/types/` (it did on 2.1.293), so `validate-mods.mjs` reports `tsc NOT RUN` in a fresh checkout. Type-check against the plugin-authoring skill's `types/claude-code.d.ts` with its header tsconfig until an interactive load writes the folder.
- `Svg` is in the desktop, vscode and mobile element tables, never the terminal's; every Svg part here has a text fallback.
- The desktop app (2.31226.1, Claude Code 2.1.295) runs its local sessions through the SDK: `session.start` comes with `isInteractive: false` and `surface: null`, and the desktop joins by `session.attach` (`surface: 'desktop'`). Every UI part gated on `{ isInteractive: true }` was skipped there while capture and `pr_status` loaded (2026-10-10). Each UI module now starts on either trigger.
- `$.command.register` refuses a built-in's name (`/agents`), and the throw failed the whole `session.start` chain: `/files` and `/skin` never registered and typing them said "Unknown command" (2.1.296, 2026-10-10, live in a terminal). Every registration now has its own `.catch`, and the ledger is `/ledger`.
- A `claude -p` started from inside a session inherits `CLAUDE_CODE_SESSION_ID` and reports the parent's `session_id` (and writes its snapshot there). `e2e-headless.mjs` drops it and passes `--session-id <uuid>` per run.
