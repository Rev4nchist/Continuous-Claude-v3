# tsc --noEmit error census — 2026-08-30

Baseline for the type-error axis the 2026-07-29 handoff left unmeasured
("234 errors, UNCHANGED, none in any touched file — still out of scope").
Measured today: **235 errors** (`cd .claude/hooks && npm run check`), one of
drift since 07-29. Raw pre-Phase-1 capture:
`docs/harness-strategy/2026-08-30-tsc-baseline-pre-phase1.txt` (composition
re-verified identical after the TLDR remediation landed — the Phase 1 edits
added zero errors).

## The headline: 90% of the debt is ONE mechanical cause

| Count | Where | Cause |
|---|---|---|
| 84 | `src/__tests__/session-activity.test.ts` | TS2593/TS2304 — test globals |
| 58 | `src/__tests__/session-bus-id.test.ts` | same |
| 48 | `src/__tests__/session-id-persistence.test.ts` | same |
| 21 | `src/__tests__/session-affinity.test.ts` | same |

TS2593 is "Cannot find name 'describe'/'it'" and TS2304 the same for
`expect`/`vi`: these four files use vitest globals without importing them
(every other test file imports `{ describe, it, expect } from 'vitest'`).
The tests RUN fine (vitest injects globals at runtime); only `tsc` objects.
**A ~4-line mechanical fix (add the vitest import to each file) removes 211
of 235 errors.** Deliberately not done in this change — the axis is
measure-only for now.

## The remaining 24, by error code

| Code | Count | Meaning |
|---|---|---|
| TS2339 | 7 | property does not exist on type (5 of them: `DaemonResponse` missing fields in the two `daemon-client.ts` copies) |
| TS2300/TS2353/TS2345/TS2322/TS2769 | 11 | assorted type mismatches, ≤4 per file |
| TS2835 | 3 | relative import missing `.js` extension under NodeNext (`impact-refactor.ts`, `tldr-context-inject.ts`, `tldr-read-enforcer.ts`) |
| TS1543 | 2 | import attribute / module syntax |

Files with 1–4 errors each: `shared/index.ts` (4), `edit-context-inject.ts`
(3), `hooks-daemon-migration.test.ts` (2), `pre-compact-continuity.test.ts`
(2), then 8 files with exactly 1.

## Ratchet

`scripts/hooks/tsc-error-ratchet.mjs` — fails when the count EXCEEDS the
recorded baseline; lowering the baseline after a fix is manual and
deliberate. 235 was the 2026-08-30 initial census; the Step-10 archive moved
6 error-carrying orphan hooks out of src, so the ENFORCED baseline is **229**
(2026-08-31). Demonstrated failing on purpose at baseline 200 before shipping
(vacuous-gate lesson: a guard that has never failed proves nothing).

Run: `node scripts/hooks/tsc-error-ratchet.mjs` (from the repo root).
