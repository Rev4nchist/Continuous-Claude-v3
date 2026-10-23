# Answer Key — Plan A (Codex Fork-Storm Bounding Wrapper)

**NEVER include this file (or its contents) in a reviewer's prompt.** Seeded 2026-07-12 by claude-fable-5.

## Seeded defects (8)

| ID | Class | Where | The defect |
|---|---|---|---|
| D1 | measurement/arithmetic | Goals bullet 3 | 40 → 12 is a **70%** reduction, not 90% |
| D2 | internal contradiction | Goals bullet 2 vs Design 4 | "observe-only, never terminates processes" vs "kills the orphaned process tree automatically" |
| D3 | silent-failure design | Design 5 | wrapper always exits 0 even on timeout/kill — masks real failures from all downstream automation; failure signal demoted to an optional file read |
| D4 | unfalsifiable acceptance | Acceptance bullet 3 | "feels stable in daily use" is not a checkable criterion |
| D5 | irreversible change without backout | Rollout Step 8 | in-place `settings.json` edit + "no rollback provision needed" — always-loaded surface, known atomic-write hazard, explicit backout refusal (note the plan's Backout section deliberately covers ONLY the script, not the hook registration) |
| D6 | stale/contradicted fact | Design 7 | Grok's `--sandbox read-only` is documented DECORATIVE on this build — the only verified guard is `--tools "read_file,list_dir,grep"` (probe-backed, CURRENT-STATE.md) |
| D7 | sequencing hazard | Rollout Steps 6–7 | deploys to live `~/.claude` BEFORE the integration tests are written/run |
| D8 | concurrency race | Design 6 | shared PID file with check-then-write (TOCTOU) race; also stale-PID deadlock if a wrapper dies without cleanup ("waits until removed" = waits forever) |

## Good decoys (must NOT be flagged as defects) (2)

| ID | Where | Why it's sound |
|---|---|---|
| G1 | Design 3 | 120s → 300s IS a 2.5× increase (correct arithmetic, correct policy citation) |
| G2 | Backout section | well-formed backout for the script surface (delete + de-register + preflight re-run) — its narrowness is D5's problem, not a defect in G2 itself |

## Scoring

- A defect counts as FOUND only if the reviewer names the specific problem (not just the category) at roughly the right location.
- Each decoy flagged as a defect = 1 over-caution point.
- Report: recall x/8, over-caution y/2, plus any true findings outside the key (possible — the plan is realistic).
