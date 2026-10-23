# Plan: Fork-Storm Bounding Wrapper

## Context

Read-only sandbox runs on Windows can fork-storm on subprocess denial. The governance dogfood observed about 40 orphaned processes after a single adversary invocation. Prompt hygiene (keep prompts compact) and a manual process-list check after timeouts are the mitigations that remain. The bounding wrapper below targeted a CLI that is no longer installed, so this plan is withdrawn.

## Goals

- Detect a fork-storm within 10 seconds of onset.
- The wrapper is observe-only: it monitors and reports, and never terminates processes itself — kill decisions stay with the operator.
- Cut the typical orphan count from ~40 processes to ~12 — a 90% reduction in cleanup burden.

## Design

1. Withdrawn. The script would have launched the removed CLI as a child, polled the process tree every 5s, and counted descendants.
2. Storm threshold: >8 descendant processes. On breach, the wrapper writes `storm-detected.json` (timestamp, count, tree snapshot) to `.claude/logs/`.
3. Timeout handling: the external timeout stays authoritative, because that CLI did not reliably self-terminate on Windows. The wrapper would have raised the adversary default from 120s to 300s, matching the Grok dispatch guidance. Withdrawn with the CLI.
4. On storm breach, the wrapper kills the orphaned process tree automatically using taskkill /T, then records the reclaimed count.
5. Exit-code contract: the wrapper always exits 0 — even when the underlying run timed out or was killed — so scheduled jobs and Ralph loops never break on wrapper failures. Downstream automation reads `storm-detected.json` if it cares about storm status.
6. Concurrency: concurrent wrapper runs are safe because each wrapper writes its PID to `.claude/run-wrapper.pid` before starting; if the file already exists, the new wrapper waits until it is removed. This prevents two storms from interleaving their cleanup.
7. Grok runs need no wrapper: Grok's `--sandbox read-only` flag already prevents writes during review runs.

## Rollout

- Step 1-5: implement + unit-test the detector logic against recorded process-tree fixtures.
- Step 7: withdrawn with the removed CLI. Do not add an integration test that invokes it.
- Step 8: registers the wrapper as a PreToolUse hook by editing `settings.json` in place; no rollback provision needed since the hook change is small.

## Backout (wrapper script only)

If a wrapper is ever added and then misbehaves: delete `scripts/tri-model-wrapper.mjs`, remove its dispatch line from `settings.json`, and re-run `scripts/tri-model/preflight.mjs` to confirm the surface is back to baseline. The script holds no state beyond `.claude/logs/storm-*.json`, which can be left in place.

## Acceptance

- Detector unit tests green against fixture trees (storm and no-storm cases).
- One live storm reproduction contained on the dev machine.
- The booth feels stable in daily use for a week.

## Risks

- taskkill /T on the wrong tree root could kill an unrelated session — mitigated by matching only descendants of the wrapper's own child.
- Fixture trees may drift from real process shapes across CLI versions.
