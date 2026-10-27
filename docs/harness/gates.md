# Testing and gates

[Back to the README](../../README.md) · [All harness pages](README.md)

*Moved from the README on 2026-10-26. The text is unchanged except where a line starts with "Status on 2026-10-26" or names PR #165.*

A change is done when its end-to-end check passes and the output is saved. The check depends on
what you changed (`AGENTS.md`).

| You changed | Run this |
|---|---|
| A hook | `npm run build` in `.claude/hooks`, then pipe a real payload into the bundle: `Get-Content payload.json -Raw \| node .claude/hooks/dist/<hook>.mjs` |
| The sync script | `bash scripts/sync-to-active-cursor.test.sh` (runs the real script in a temporary home) |
| Coordination | The matching `scripts/coordination/*-probe.mjs` |
| A rule, skill or agent | After the sync, `claude -p "<prompt>" --output-format json`, then confirm the new behaviour |

Save each artifact to `.claude/cache/e2e/<YYYY-MM-DD>-<name>.<ext>`. That folder is gitignored.
Name the file in the pull request's Evidence section.

Isolated tests cover only logic that an end-to-end check cannot reach cheaply: parsers, regexes,
guards and date math. Hook tests use vitest (`npm test` in `.claude/hooks`). Python tests use
pytest in `opc/`. A bug fix starts with a test that reproduces the bug.

Static gates:

| Gate | Command | Output on 2026-10-26 |
|---|---|---|
| Context budget | `node scripts/rules/context-budget-guard.mjs --repo` | `always-loaded: 5 files, 23502 chars (budget 23516, Claude Code limit 150000) [repo]` |
| Hook output contract | `node scripts/hooks/hook-contract-guard.mjs` | `PASS ... 75 live entries / 67 names ... 0 discarded-output, 2 known-debt, 8/8 timers safe` |
| Model policy | `node scripts/check-agent-model-drift.mjs .` | `agents: 35 \| opus: 12 sonnet: 23 \| OK` |
| Skills | `node scripts/skills/audit-skills.mjs` | `80 skills, 0 hard failures, 0 ratchet regressions` (rules G01-G32) |
| Test suite size | `node scripts/hooks/suite-count-ratchet.mjs` | Fails if passed or collected tests drop below the baseline |

The context budget has 14 characters of headroom, so the next rule edit needs a deliberate budget change.
The `--repo` budget counts more files than a normal session loads. It adds this repo's own
`CLAUDE.md` chain, because sessions that work on the harness load both sets.

`scripts/coordination/load-probe.mjs` writes test rows to the coordination tables. Run it only
against a development database.

`npm run test:e2e` at the root runs only `e2e/example.spec.ts`, a placeholder.
