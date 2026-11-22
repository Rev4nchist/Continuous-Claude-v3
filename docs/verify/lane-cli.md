# Verify map: the lane CLI and coordination

Surface: `scripts/coordination/lane.mjs` and its modules, the shim `.claude/scripts/lane.mjs` (synced to `~/.claude/scripts/`), the resolver twins (`scripts/coordination/lane-board.mjs` and `.claude/hooks/src/shared/lane-board.ts`), `docker/init-schema.sql`, `apps/agentic-os/drizzle/**`.
Rule: model-run text calls the shim path, never a relative `lane.mjs`. A probe writes to the live database unless `CONTINUOUS_CLAUDE_DB_URL` points at a scratch database (`node scripts/coordination/scratch-db.mjs`).

| You changed | Run this | Artifact | Who runs it |
|---|---|---|---|
| Any file in `scripts/coordination/**` | `node --test scripts/coordination/<name>.test.mjs` | the pass and fail summary | pre-pr gates `coordination-tests`, `drill-tests`, `dash-export-db-test`; `github-deps` runs `scripts/github/*.test.mjs` |
| A claim, lease, band or reminder rule | the matching `scripts/coordination/*-probe.mjs` against a scratch database | the probe output, saved in `.claudedocs/e2e-<lane-id>/` | by hand (the `coordination` row prints this as a NOTE) |
| A database write path | `coordination-db-tests` (needs local Postgres: `docker compose up -d` in `docker/`) | the test summary | pre-pr gate `coordination-db-tests`; CI job `coordination-db` |
| The schema or a migration | prove it on `scratch-db.mjs`, then apply by the runbook after Dave's yes | the scratch run output | gate `lane-context-db` |
| The resolver twins | change both in one commit | `lane-board-resolver.test.ts` passes in `.claude/hooks` | `hooks-vitest` |
| The shim | `node --test scripts/coordination/lane-shim.test.mjs` and `node scripts/coordination/lane-path-guard.mjs` | the summaries | `coordination-tests`; the path guard by hand |
| The banner or hint text | build the hooks, then pipe a real payload into `dist/lane-context.mjs` (or `$env:LANE_CONTEXT_HEADLESS='1'; claude -p "<prompt>"` in a registered folder) | the hook stdout JSON | by hand, or a fixture in `.claude/hooks/fixtures/lane-context/` |
| The dashboard export | `node scripts/coordination/export-dash-data.mjs`, then the FleetOps refresh steps | the `refresh.json` key | by hand |

## Reverse states

Claim and release, park and resume, register and unregister: if you add one direction, test the other in the same change.

## What no gate shows

- A live lease or a live holder: run `lane.mjs mine` and `lane.mjs board`.
- A scratch-database run that passed while the live schema differs: the live check is the runbook.
