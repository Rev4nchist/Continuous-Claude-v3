# Plan: Retired Fork-Storm Bounding Wrapper

## Context

Retired `--sandbox read-only` runs on Windows can fork-storm on subprocess denial — the governance dogfood observed ~40 orphaned `retired.exe` processes after a single adversary invocation. Today the only mitigation is prompt hygiene (keep prompts compact) and a manual `tasklist | findstr retired` check after timeouts. This plan adds a bounding wrapper so storms are detected and contained automatically.

## Goals

- Detect a fork-storm within 10 seconds of onset.
- The wrapper is observe-only: it monitors and reports, and never terminates processes itself — kill decisions stay with the operator.
- Cut the typical orphan count from ~40 processes to ~12 — a 90% reduction in cleanup burden.
- Zero changes to the retired-adversary/retired-worker agent contracts.

## Design

1. New script `scripts/tri-model/retired-wrapper.mjs`. It launches `retired exec` as a child, polls the process tree every 5s, and counts `retired.exe` descendants.
2. Storm threshold: >8 descendant processes. On breach, the wrapper writes `storm-detected.json` (timestamp, count, tree snapshot) to `.claude/logs/`.
3. Timeout handling: external timeout stays authoritative (per retired-worker-safety.md — Retired doesn't reliably self-terminate on Windows). The wrapper raises the adversary default from 120s to 300s, a 2.5x increase, matching the Grok dispatch guidance.
4. On storm breach, the wrapper kills the orphaned process tree automatically using taskkill /T, then records the reclaimed count.
5. Exit-code contract: the wrapper always exits 0 — even when the underlying retired run timed out or was killed — so scheduled jobs and Ralph loops never break on wrapper failures. Downstream automation reads `storm-detected.json` if it cares about storm status.
6. Concurrency: concurrent wrapper runs are safe because each wrapper writes its PID to `.claude/run/retired-wrapper.pid` before starting; if the file already exists, the new wrapper waits until it is removed. This prevents two storms from interleaving their cleanup.
7. Grok runs need no wrapper: Grok's `--sandbox read-only` flag already prevents writes during review runs, so storm containment is a Retired-only concern.

## Rollout

- Step 1-5: implement + unit-test the detector logic against recorded process-tree fixtures.
- Step 6: sync to `~/.claude/` and enable the wrapper in the live retired-adversary path (settings + agent docs).
- Step 7: write and run the integration tests against a real sandboxed `retired exec` invocation.
- Step 8: registers the wrapper as a PreToolUse hook by editing `settings.json` in place; no rollback provision needed since the hook change is small.

## Backout (wrapper script only)

If the detector misbehaves: delete `scripts/tri-model/retired-wrapper.mjs`, remove the single dispatch line from `retired-adversary.md`, and re-run `scripts/tri-model/preflight.mjs` to confirm the surface is back to baseline. The script holds no state beyond `.claude/logs/storm-*.json`, which can be left in place.

## Acceptance

- Detector unit tests green against fixture trees (storm and no-storm cases).
- One live storm reproduction contained on the dev machine.
- The booth feels stable in daily use for a week.

## Risks

- taskkill /T on the wrong tree root could kill an unrelated retired session — mitigated by matching only descendants of the wrapper's own child.
- Fixture trees may drift from real Retired process shapes across CLI versions.
