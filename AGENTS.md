# AGENTS.md: continuous-claude (CCv3)

Read by Codex and other agents directly, and by Claude Code through `@AGENTS.md` in CLAUDE.md.
Global policy: RULES.md "Testing Standards". This file says what it means in this repo.

## Testing

**Done means an end-to-end check passed and its output is saved.** A unit test alone is not proof.

End-to-end check per surface:

| You changed | Run this | Save as the artifact |
|---|---|---|
| A hook (`.claude/hooks/src/*.ts`) | `npm run build` in `.claude/hooks`, then pipe a real payload into the built hook: `Get-Content payload.json -Raw \| node .claude/hooks/dist/<hook>.mjs` | the hook's stdout JSON |
| Sync (`scripts/sync-to-active.sh`) | `bash scripts/sync-to-active-cursor.test.sh` (runs the real script in a temp home) | its PASS/FAIL lines |
| Coordination (lanes, claims, leases) | the matching `scripts/coordination/*-probe.mjs` | the probe's output |
| A rule, skill or agent file | behaviour: after the sync, run a fresh headless session on a prompt the change targets, `claude -p "<prompt>" --output-format json`, and confirm the new behaviour appears (for a skill: that it loads). Then its static ratchet: `node scripts/rules/rules-budget-guard.mjs`, `node scripts/skills/audit-descriptions.mjs`, `node scripts/check-agent-model-drift.mjs .` | the session JSON, plus the ratchet's summary line |

Put artifacts in `.claude/cache/e2e/<YYYY-MM-DD>-<name>.<ext>` (gitignored) and name the file in the
PR's Evidence section.

Isolated tests (vitest in `.claude/hooks`, pytest in `opc`):
- Only for logic an end-to-end check cannot reach cheaply: parsers, regexes, guards, date math.
- Write the ways the unit can fail first; one test per listed failure.
- Never copy the logic under test into the test file. Import the real function.
- A bug fix starts with a test or probe that reproduces the bug and fails. Keep it.
- Before adding a test, name the source change that would make it fail. If you cannot, do not add it.

`npm run test:e2e` (Playwright) runs only `e2e/example.spec.ts`, a placeholder. It is not a check of
this repo.
