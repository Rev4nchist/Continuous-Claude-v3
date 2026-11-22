# Testing: continuous-claude (CCv3)

Global policy: CLAUDE.md "Testing standard". This file says what it means in this repo.

## Testing

**Done means an end-to-end check passed and its output is saved.** A unit test alone is not proof.

End-to-end check per surface:

| You changed | Run this | Save as the artifact |
|---|---|---|
| A hook (`.claude/hooks/src/*.ts`) | `npm run build` in `.claude/hooks`, then pipe a real payload into the built hook: `Get-Content payload.json -Raw \| node .claude/hooks/dist/<hook>.mjs` | the hook's stdout JSON |
| Sync (`scripts/sync-to-active.sh`) | `bash scripts/sync-to-active-cursor.test.sh` (runs the real script in a temp home) | its PASS/FAIL lines |
| The harness doctor or a scheduled-task wrapper (`scripts/harness-doctor.mjs`, `.claude/scripts/scheduled/*.bat`) | `npm run test:scripts` (the real doctor and wrapper, through cmd.exe, in temp folders) | its pass/fail summary |
| The shared store link (`scripts/worktree/shared-deps.mjs`) | `node --test scripts/worktree/shared-deps.test.mjs` | its pass/fail summary |
| Coordination (lanes, claims, leases) | the matching `scripts/coordination/*-probe.mjs` | the probe's output |
| A rule, skill or agent file | behaviour: after the sync, run `claude -p "<prompt>" --output-format json` on a prompt the change targets. Confirm the new behaviour appears (a skill: that it loads). Then its static ratchet: `node scripts/rules/context-budget-guard.mjs --repo`, `node scripts/skills/audit-skills.mjs`, `node scripts/check-agent-model-drift.mjs .`, `node scripts/agents/check-agent-body.mjs`. For an agent, confirm `"effort":"high"` in the subagent transcript. | the session JSON, plus the ratchet's summary line |
| Lane rule or hooks, headless | in a registered folder: `$env:LANE_CONTEXT_HEADLESS='1'; claude -p "<prompt>"` | the output |
| `apply-registrations.mjs` | dry run; `--apply --only <hook>` after Dave's yes | the output |
| Any surface, when the registry entry has `e2e` | `node ~/.claude/scripts/verify.mjs` | the `.log` and its `.json` sidecar |

Maps: `docs/verify/`.

Put artifacts in `.claude/cache/e2e/<YYYY-MM-DD>-<name>.<ext>` (gitignored) and name the file in the
PR's Evidence section.
A program lane saves its artifacts in `.claudedocs/e2e-<lane-id>/` in the primary checkout: a worktree cache goes with the worktree.

Isolated tests (vitest in `.claude/hooks`, pytest in `opc`):
- Only for logic an end-to-end check cannot reach cheaply: parsers, regexes, guards, date math.
- Write the ways the unit can fail first; one test per listed failure.
- Never copy the logic under test into the test file. Import the real function.
- A bug fix starts with a test or probe that reproduces the bug and fails. Keep it.
- Before adding a test, name the source change that would make it fail. If you cannot, do not add it.

`npm run test:e2e` (Playwright) runs only `e2e/example.spec.ts`, a placeholder. It is not a check of
this repo.
