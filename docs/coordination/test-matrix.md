# Test matrix: multi-session coordination

Lane: `coord-test-suite`. Date: 2026-11-24. Base: `fork/main` 649cb608.
Source: `.claudedocs/2026-11-24-production-readiness/00-merged-plan.md` (line 23) and `01-readiness-report.md` (section 4, lines 135 to 166).

This file answers one question: for each way the system can fail, which test proves we survive it, or is there NONE?

## How to read this file

- **Status**: `COVERED` means a test proves the mode. `PARTIAL` means a test proves part of it. `NONE` means no test exists.
- **Gated**: `yes` means CI runs the test and a failure fails the build. `no` means the test exists but nothing runs it. Today only `probe-boards.test.mjs` and `probe-scratch-guard.test.mjs` of the probe files are gated (`01-readiness-report.md:135`). The hooks vitest suites run in the `hooks` job.
- **Mark `[unread]`** means the fact comes from a scout report and I did not open that line myself.
- A probe runs only on a scratch database (rule O3.9). Each target probe exits 2 when it gets a URL that `assertScratchUrl` refuses (`scripts/coordination/scratch-db.mjs:74-85`).

## 1. The 12 failure modes

| # | Failure mode | Test today | Gated | Status | What is not proven |
|---|---|---|---|---|---|
| 1 | Seat crash or compact | `lane-compact-probe.mjs` (header lines 1-14) `[unread]`; `lease-probe.mjs` case D takeover `[unread]`; hooks test `pre-compact-continuity.test.ts` (name only) | no for the probes; yes for the vitest file | PARTIAL | A fresh seat resumes a half-done ruling from the handoff alone. The 11-11 kill drill has no file anchor. |
| 2 | Machine stop mid-run | None. Clock moves in `lane-race-probe.mjs` (91 minutes) and `lease-probe.mjs` case C only simulate expiry. | no | NONE | A real stop, a restart, adopting held leases. A sleep fires no SessionEnd (`01-readiness-report.md:88-92`). |
| 3 | Ended holder | `session-lifecycle-probe.mjs` (header 20-35); `coordination-release-pin.test.ts`; `lane-claims-free.mjs` `[unread]` | probe no; vitest yes | PARTIAL | A lane card held by an ended session is freed. Today a person does it by hand (`01-readiness-report.md:146`). Death with no SessionEnd. |
| 4 | Account switch | `lane-board-resolver.test.ts` grep gate: no tracked file names the old board page id `[unread]` | yes | PARTIAL | A publish and a read still work after a switch. |
| 5 | Postgres down | `degradation-probe.mjs` (header 10-24); `lane-context-dm.test.ts`; `file-claims-all-writers.test.ts` degraded flag `[unread]` | probe no; vitest yes | PARTIAL | The lane CLI during an outage. A stop and restart in the middle of a run. |
| 6 | Two writers | `claim-sql-probe.mjs` case 5; `lane-race-probe.mjs` (N racers, default 24); `lease-probe.mjs` (`--racers`, default 4); `coord-drill-2/expected.json` rows 2, 5, 7, 8 PASS `[unread]` | probes no; drill unit tests only | PARTIAL | A shell write into a claimed file. Drill row 3 expects FAIL, so a gap is known. Drill scenarios 1a, 1b, 4 and 6 are outside that card's scope. |
| 7 | Land during pre-pr (V7.11) | None. `land-pr-lock.test.ps1` tests one lander only `[unread]`. | no | NONE | The land script refuses while a CLI pre-pr runs. V7.11 is advice (`docs/coordination/standard.md:158` `[unread]`). |
| 8 | GitHub errors | `scripts/github/open-prs.test.mjs` (429 and rate-limit text) `[unread]` | yes | PARTIAL | Retry and backoff on the land path. Three test files were not read: `land-recheck.test.mjs`, `cr-paid-post.test.mjs`, `cursor-review.test.mjs`. |
| 9 | Publish limit | `lane-board-stop-gate.test.ts` (cap 150 a day) `[unread]` | yes | PARTIAL | The account limit is 200 and the counter is per machine. A real 429. |
| 10 | Clock | `gate-lines.test.mjs` (instants); `run-lock.test.mjs` (injected clock) `[unread]` | yes | PARTIAL | A time typed by a seat differs from the clock read. No test found for it. |
| 11 | Message loss | `dm-delivery-probe.mjs` (six lane-DM properties, header 14-26); `lane-context-dm.test.ts` | probe no; vitest yes | PARTIAL | `SendMessage` delivery. Rule M4.5 says "Not verified". |
| 12 | Stale worktree | `lane-path-guard.mjs`; `coord-drill-2/s2-worktree-claim.mjs`; `file-claims-worktree-key.test.ts` `[unread]` | vitest yes | PARTIAL | A run of a stale `lane.mjs` copy. An orphan worktree that holds a card. |

Count: 0 COVERED, 10 PARTIAL, 2 NONE. Row 6 is the closest to COVERED. Its claim race is proven by three probes, and none of them is gated yet.

## 2. The six probes `run-probes.mjs` will run

All six read `CONTINUOUS_CLAUDE_DB_URL`, then `DATABASE_URL`, then `OPC_POSTGRES_URL`. All six refuse a non-scratch URL with exit 2. I checked the refusal lines in the files.

| Probe | Covers mode | Refusal line | Needs |
|---|---|---|---|
| `lane-race-probe.mjs` | 6 | `:78-81` | `pg`. Migrations through 6. Spawns the real `lane.mjs`. |
| `lease-probe.mjs` | 1, 2, 6 | `:37-45` | `docker exec` into `continuous-claude-postgres` (`:70`) |
| `claim-sql-probe.mjs` | 6 | `:37-40` | `pg`. Reads its SQL out of `db-utils-pg.ts` |
| `degradation-probe.mjs` | 5 | `:33-41` | `docker exec` into `continuous-claude-postgres` (`:60`). Renames its own table and restores it. |
| `session-lifecycle-probe.mjs` | 3 | `:81-91` | Default `docker exec` into the same container (`:75`). `--db-url` uses `pg`. |
| `dm-delivery-probe.mjs` | 11 | `:57-60` | `pg`. `DM_PROBE_HOOK` for the repo dist. Check 6 prints SKIP and exits 0 without migration 0004. |

## 3. Gap list

| Id | Gap | Why it matters | Proposed handling |
|---|---|---|---|
| G1 | Four probes (`lease`, `degradation`, `event-recording`, `load`) and the default of `session-lifecycle` need a container named `continuous-claude-postgres`. A GitHub service container has another name. | The CI job cannot run them unchanged. | Start the Postgres container by that name in the CI job with `docker run --name`. This needs no change to probe logic (the scope forbids that). [Speculation: the runner image allows `docker run`.] |
| G2 | The CI url `CONTINUOUS_CLAUDE_DB_URL` names the database `continuous_claude`, so every probe would exit 2. | A probe must not run on that name. | The runner makes a scratch database with `scratch-db.mjs create --through 6`, as `scripts/github/lane-context-db-gate.mjs` does, and drops it in `finally`. |
| G3 | `dm-delivery-probe` prints SKIP and exits 0 when migration 0004 is missing. | A skipped check passes the build. | Create the scratch database through migration 6. The runner counts SKIP lines and fails on any. |
| G4 | Probes may leave rows that break the next probe. Not checked. | Order-dependent failures. | One scratch database for each probe. |
| G5 | The fork has no server-side branch protection (`00-merged-plan.md:16`). | A red CI job blocks nothing on GitHub. | Not in this card. The local land hooks are the only fence. Dave or the seat decides. |
| G6 | `pre-pr.mjs:410` only prints a "manual" text for probes. | The pre-pr probe step. | Waits on `re-prepr-bundle`. Left out of the first PR (seat ruling 15:31). |
| G7 | `lane-race-probe.mjs` is not in the `GUARDED` list of `probe-scratch-guard.test.mjs`. | The refusal test T1 does not run it. T2 only greps for `assertScratchUrl`. | `run-probes.mjs` has a refusal check that runs all six with a refused URL and expects exit 2 from each. |
| G8 | `docs/coordination/standard.md` O3.9 says other probes were not checked, and the readiness report calls it `[Speculation]` stale. | Wrong text. | Not in this card's write set. Tell the seat. |
| G9 | Modes 2 and 7 have no test and no card that builds one. | Two failure modes stay NONE. | They belong to `coord-chaos-drill` (L4 rows c, d, h). Not built here. |

## 4. What this card builds

1. This matrix.
2. `scripts/coordination/run-probes.mjs`. One command. It makes one scratch database for each probe, runs the six probes, runs the refusal check (G7), counts SKIP lines (G3), and drops each database in `finally`. It exits non-zero when any probe, any refusal check or any SKIP fails.
3. A `coordination-probes` job in `.github/workflows/ccv3-checks.yml`. The `coordination-db` job (lines 268-288) holds a 15-minute budget, so this is a new job. `.github/workflows/ccv3-checks.yml` is a shared critical file: ask the seat before the push.

## 5. Not read

- Probe bodies beyond the header and the refusal lines.
- How `degradation-probe.mjs` makes the database unreachable.
- Headers of `session-autoname-probe`, `session-identity-probe` and `t3-to-seat-probe`.
- The three GitHub-error test files named in row 8.
- Run times: no probe header states one.
