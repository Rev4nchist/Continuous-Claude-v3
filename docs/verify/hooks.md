# Verify map: hooks

Surface: `.claude/hooks/src/*.ts` (source), `.claude/hooks/dist/*.mjs` (built, what runs), `settings.json.template` (registration).
Rule: a green test is not proof that a hook fires. Feed it a real payload. See `docs/testing-standard.md` "Testing" and `.claude/rules-src/every-surface-checklist.md`.

| You changed | Run this | Artifact | Who runs it |
|---|---|---|---|
| A hook source | `cd .claude/hooks`, `npx tsc --noEmit` | the tsc output | pre-pr gate `hooks-tsc` |
| A hook source | `npm run build` in `.claude/hooks`, commit the dist change | `git diff --name-only -- .claude/hooks/dist` prints nothing | pre-pr gate `hooks-build` (fails on a stale dist) |
| Hook logic | `npx vitest run src/__tests__/<name>.test.ts` in `.claude/hooks` (Windows: no `npm test -- --flag`, use `cmd /c`) | the vitest summary | pre-pr gate `hooks-vitest` (flake ledger on) |
| A hook output shape | `node scripts/github/hook-payload.mjs --paths .claude/hooks/src/<name>.ts` | `.claude/cache/e2e/<date>-hook-payload-<name>-<case>.json` | by hand until the `hook-payload` gate is in the hooks row of `SURFACES` (card coord-hook-payload-gate, after coord-cap-override PART B) |
| A guard (`decision-gate`, `pre-pr-gate`, `coderabbit-guard`, `destructive-command-guard`, `package-install-guard`) | the same command, plus at least one deny and one allow fixture in `.claude/hooks/fixtures/<name>/` | the saved output files | `REQUIRES_FIXTURE` in `scripts/github/hook-payload.mjs` fails a change with no fixture |
| A matcher in `settings.json.template` | check the hook's own `tool_name` test too (two gates), run `node scripts/settings/capture-active-registrations.mjs --check` if it exists | the check output | by hand; `hook-matcher-runtime-consistency.test.ts` covers part of it |
| A new hook | `/hook-scaffold`, then register with `apply-registrations.mjs --apply --only <hook>` after Dave's yes, then `render-settings.mjs --check` | the check output | by hand |

## Fixture form

One file per case: `.claude/hooks/fixtures/<hook>/<case>.json`.

```json
{
  "case": "deny-reset-hard",
  "event": "PreToolUse",
  "input": { "session_id": "fixture", "tool_name": "Bash", "tool_input": { "command": "git reset --hard HEAD~1" } },
  "env": { },
  "expect": { "exit": [0], "shape": "gate", "decision": "ask" }
}
```

- `shape`: `gate` (a permission decision), `inject` (additional context), `continue` (`{"result":"continue"}`), `empty` (prints nothing or `{}`). Source: `.claude/hooks/src/shared/output.ts`.
- Write the file with an editor or the Write tool. Never build it in shell text: a deny payload on a command line trips the live guards.
- No real session id, user path, drive path, backslash path, secret or holdout id. `session_id` stays `fixture`; the runner makes it `fixture-<run id>`.
- `env` adds keys. It cannot set an isolation key (`CCV3_GUARD_DECISIONS_LOG`, `HOME`, `USERPROFILE`, `CCV3_DECISIONS_FILE`, `LANE_REGISTRY_PATH`, `CCV3_FILE_CLAIMS_STATE_DIR`, `CCV3_HOOK_TRACE`).
- The hook runs in a throwaway git repo with a `fork` remote and `review-router.config.json` with `decisions.enforce: true`, never in the checkout.
- Paths use `/`: hooks CI runs on Linux.

## What the gate cannot show

- That the hook is registered, or that the live harness calls it: check `settings.json` and the hook's own log rows.
- The behaviour of a hook that needs live state (the lane database, GitHub, the network). Those hooks need an E2E check of their own.
