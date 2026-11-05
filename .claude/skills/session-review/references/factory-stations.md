# Software Factory stations and harness edit targets

Working definition, confirm with Dave: the CCv3 harness seen as a production line, from prompt to
merged PR. Source of the stations: `.claudedocs/ccv3-factory-floor.html` in the primary checkout.

## Stations

| Station | Signals in the digest | Doc stage |
|---|---|---|
| 01 Intake | `hooks.rule_router_fires`, `AskUserQuestion` in `tools.calls_by_name`, `goal_candidates` | triage |
| 02 Plan | `permission_modes` contains `plan`; `factory.attribution_skills` has `discovery-interview` or `premortem` | spec |
| 03 Build | `factory.agents[]` by `agentType`, `model` (from the meta file, else the first assistant record), `effort` and `launchedWithDefaults` (`factory.agents_total` is the count before the cap of 100), `factory.workflows[].status`, `task_notifications.failed`, subagent token share in `cost.split` | implement |
| 04 Guard | `hooks.blocks[]` by guard, workaround versus fix, `hooks.hook_ms_by_name` | (CCv3 addition) |
| 05 Review | `factory.review_ledger`, `factory.coderabbit_rounds` and their cost | adversarial review |
| 06 Land | `prs[]`, `evidence.checks[]` that write under `.claude/cache/e2e` | verify |
| 07 Learn | `evidence.handoff_outcome` | monitoring |
| Rail: Coordinate | lane signals from `rule_router_fires` and prompts only. This version has no lane database. | none |

Scoring: for each station write "ran" (a signal exists), "had evidence" (the signal carries a
checkable `uuid` or record) and "passed" (no failing signal). A station with no signal is "did not run",
not a failure.

Build checks: an Opus agent on an execution task, a missing `pickedEffortModel`, a failed or stopped
workflow, and a high `task_notifications.failed` count are Build findings.
Guard checks: a block followed by a workaround is a Guard finding for the hook that blocked.
Read `hook_ms_by_name` for overhead; if keys are event names, it shows event time, not one hook.

## Harness edit targets

| Failure class | Edit target |
|---|---|
| Repeated steers on one topic | that area's skill or on-demand rule. Not CLAUDE.md (about 346 characters of headroom at build time). |
| Environment flailing | the `project-registry` entry, or the project's AGENTS.md "Testing" section |
| Done not proven | the `code-review` skill, or a Stop hook candidate |
| Block followed by a workaround | the hook's deny message in `.claude/hooks/src/<hook>.ts` |
| Hook false fire | the `rule-router` manifest and `~/.claude/logs/rule-router-false-fires.jsonl` |
| Wrong model or effort for a subagent | `.claude/agents/<name>.md` and its `.json` mirror |
| Tool or MCP misuse | the `mcp-guidance` skill |
| Hook overhead | the hook source, as a quick-win candidate |
| Regression after a model or harness change | the trend flag. Report only, no edit. |

Edit the repo copy under `.claude/` in the primary checkout, never `~/.claude`. A diff draft names
the repo path. `/session-review` reports per session and per station. `/failure-audit` reports
corpus-wide correction rates.
