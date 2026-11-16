# Review engine: lane map

This file is the one map of the review-engine program. It is map v2 (2026-11-09), with the 22 lane sections that map v2 kept from the 11-05 map merged in. "Map v2" in a card note means this file.

Goal: replace CodeRabbit with the CCv3 local review engine (Dave 11-04, 11-05: the gating item of the software factory).

Program state: GO (Dave, 2026-11-11)

Pack: re-verifier, re-finder-v2 (branch re/re-verifier)

`program.mjs` reads the two lines above from `main`. The first line is the GO line: an absent or unreadable line reads as HOLD. GO is a later one-line PR after Dave's GO tap. It changes that line and the HOLD line of README.md. The second line is the one trial pack (Dave, 2026-11-10): two lanes in one PR on one branch, one cap unit. A wider pack needs a new yes after this pack lands clean. No such line means no pack.

Premortem 2026-11-09 applied: see 2026-11-09-review-engine-premortem.md

- Ids T01 to T22 and E01 to E04 in this map name findings in that file (`.claudedocs/2026-11-09-review-engine-premortem.md`).
- Dave's taps on 2026-11-09 after the premortem. (1) The mitigations go into the plan files. (2) Every map lane keeps a card. A lane with open dependencies stays `blocked` now and moves to `backlog` with stored edges after T2.1. Only the 3 dropped lanes close, with the note 'DROPPED map v2'. No new lane state. (3) The T2.1 dependency gate is built before GO, as three PRs (schema; CLI with the lane-context twin and the race probe; page, kanban and docs). The live migration apply needs a separate yes after the scratch-db proof. DECIDED (Dave, 2026-11-10): T2.3 and T2.4 are built as one PR, the fourth, after the dependency gate and before wave 1.
- Dave's taps on 2026-11-09, later the same day (decisions journal, the four DP1 rows). All four are applied in this map. (4) DP1.5: path F. Freeze today's engine and count from the first sweep, with a stop rule at decision point 2 (stop the attempt when the forecast is under 20%). Dave saw the note that the bar almost surely fails at today's recall. (5) DP1.8: route J, a calibrated judge. The CLI flip waits on `re-judge-calibrate` and its chain. (6) DP1.15: per band. The CLI demotion is a band list. LOW keeps the CodeRabbit CLI while the engine does not review LOW. The CLI is skipped only when an engine record exists for that head. (7) DP1.18: split `re-live-advisory` into a short build lane and a long accrual lane (`re-live-accrual`).
- Dave's taps on 2026-11-09, last round (decisions journal, the rows DP1.1 to DP1.19). All are applied in this map. (8) DP1.1: the P1 band list, as listed, in rank order. (9) DP1.2: the spend caps are approved as our own numbers. The pool share is measured in the first sweep week, and no cap goes up before that. (10) DP1.3: `re-` PRs get the CodeRabbit CLI plus the engine, no PR bot. (11) DP1.4, DP1.9, DP1.10, DP1.11 and DP1.12: all five accepted. (12) DP1.6: Grok-only first, 2 arms. DP1.7 is not asked. (13) DP1.13: the two external lanes get band P1, a review-engine worker as owner, the map's done checks and the program claim rules. (14) DP1.14: CRITICAL stays on the CodeRabbit PR bot under the interim rule. (15) DP1.16: cut the phase 4 design to fit 120 runs, arms interleaved. (16) DP1.17: the coordinator seat runs the daily sweep for the first 2 weeks. (17) DP1.19: the 6 adopted cards are marked done. (18) The old `re-gate-ready` card is marked done with the SPLIT note. (19) All `re-` cards stay `blocked` until GO, wave 0 included.
- "Only the 3 dropped lanes close" in tap (2) covers map lanes. Cards that are not map lanes close under taps (11), (17) and (18): see "Board actions".
- Decision point 1 is fully answered. The items of DP2 and DP3 are not answered. Two points came up after DP1. Points (a) and (b) are DECIDED (Dave, 2026-11-10). "Open after DP1" in decisions.md lists what is still open before GO.

What changed from the 11-05 map and why. The 11-05 map was one serial research chain, and every CodeRabbit flip waited at its end in wave 10. Nothing on it had moved since 11-05. This map starts the evidence early: a wave-1 sweep runs today's engine as advice on open PRs and saves the CodeRabbit CLI output for the same head. It replaces the one retirement gate with two gates: pre-pr CLI and CRITICAL PR bot. It drops the HIGH gate, a no-op today. It takes the P5 arms, the loop dry run and P7 off the path. It fixes the capacity rules, the freeze window and the circular blind sample, splits three over-size lanes, and batches Dave's choices into three decision points. The pre-pr CLI gate now sits at wave 4 (route J, DP1.8). Its dependency closure holds no P4 A/B lane. Route J puts two gold lanes and the two P4 prefactor lanes in it (see the closure text under the Waves table).

Inputs. These files are outside git. [research-index.md](research-index.md) lists the `.claudedocs` files.
- 11-05 map: `.claudedocs/2026-11-05-review-engine-lane-map.md`
- Evaluation accepted by Dave: `.claudedocs/2026-11-09-review-engine-plan-eval.md` (changes A1-F4). Change ids below (A1, B3 and so on) refer to its section 3.
- Refuter verdicts: workflow `wf_52f7061a-b8b`. This map uses the revised change after refutation, never the first judge text.
- Other docs cited: `.claudedocs/2026-11-04-review-engine-p1-results.md` (p1-results), `.claudedocs/2026-11-07-prepr-checks-effectiveness.md`, `.claudedocs/2026-11-03-review-capacity-strategy.md`, and the memory files `dave-no-code-labels.md` and `verify-cannot-cut-policy-noise.md`.
- Commit SHAs in this map (1a78c5ca, 5f27ec2d, 43461fe0) come from the refuter's drift check. This map did not re-verify them.

## Where sections live

Three sections of map v2 are in their own files in this folder. A reference in this file to a name in this list points to that file.

- [evidence-bar.md](evidence-bar.md): "Evidence bar". Its parts are "What counts as a sample", "Provable-bar table", "Pass forecast", "re-retire-prepr-cli bar", "re-retire-critical bar", "OPEN items" and "Re-promotion triggers". "Which rows count" and "Counted weeks" are in "What counts as a sample". A bar row number names a row in that file.
- [decisions.md](decisions.md): "Decision points for Dave". Its parts are DP1, "Open after DP1", DP2, DP3 and "Old 14 decisions". A decision id, for example DP2.4, names an item in that file. The decisions journal table is in that file too.
- [capacity.md](capacity.md): "Capacity plan". Its parts are "Cursor" (also named "Capacity plan / Cursor"), "Headless claude -p day plan" (the day plan) and "CodeRabbit sample cost facts".
- This file holds every other section.

## How to use this map

- Claim a lane only when every lane in its "Depends on" is met and every token in its "Held until" cell is met. A dependency is met only when its lane is `done` AND a done event names a SHA that is an ancestor of `main`. A `done` set by hand or by a kanban tap does not count. T2.1 is on `main` (PRs #484, #486, #488): `claim` refuses a lane with an open dependency, and a dependency is met by `done --merged <sha>` or `done --no-pr --evidence <file>`. A plain `done` meets no dependency.
- A wave 0 `re-` lane (no open dependency) stays `blocked` until Dave's GO tap. Then `program.mjs sync-board` moves it to `backlog`. No session claims a `re-` lane before GO. (Confirmed by Dave, 2026-11-09; orchestration plan, section 3.3.)
- Edit only the files in your lane's "Owns" list. A change to a file another lane owns goes through that lane's holder (`lane.mjs say --to <name>`).
- Before you start, read your lane section here, then the sections of the lanes in "Depends on", "Unblocks" and "Related".
- At most 5 `re-` lanes are in work at once. The pack of the Pack line counts as one. DECIDED (Dave, 2026-11-10): 2 worker sessions at GO. A third joins from round 3, only if rounds 1 and 2 show no claim fault and no Owns fault. DECIDED (Dave, 2026-11-13): cap 5 for now; goal 5 to 10 workers in application development. The seat is extra and builds nothing.
- The 11-05 sections of the unchanged lanes and the deferred lanes are merged into "Lanes" in this map. For those lanes the Waves table wins for the wave and the Unblocks list.
- "Needs Dave" in the Waves table means: the lane stops for a decision-point answer, a spend, an install or an outward-facing action. A merge tap on a CRITICAL-band PR is not marked. Every land needs a tap anyway (decisions.enforce is true). The merge yes itself stays.
- "Held until" in the Waves table means: no session may claim the lane before each token in the cell is met. A stop in the middle of a lane is "Needs Dave", not a hold. The seed writes a held lane in state `blocked` (T02).
- Long lanes (T14): `re-live-accrual` (sweep weeks), `re-seed-gold-b` (seed), `re-retire-prepr-cli` and `re-retire-critical` (gates) run for weeks. Between work sessions the holder parks the lane: `lane.mjs park <id> --reason "<next step>"`. The default is 24 hours; `--for` sets 2 hours to 7 days. The holder keeps the lane, and its state becomes `review`. A new session of the same builder takes the lane back with `lane.mjs adopt --from <old session id>`, under the same session name. A hold of more than 7 days is never a `park`: the holder runs `lane.mjs release <id> --blocked --reason "<next step>"`, and the lane is `blocked` with no owner. The seat reopens such a lane with `lane.mjs state <id> backlog --reason "<why>"`. The reason is in the lane event. Exception (wait O1): `re-live-accrual` has no holder during its 2 sweep weeks. The holder runs `lane.mjs release re-live-accrual --blocked --reason "sweep until <date>"`. The seat reopens it for the closing check in the same way.
- Holdout data: never tune on it, never paste holdout PR ids or answers into lane notes (lane notes reach every headless session).
- Cursor models: Grok 4.7 or Composer 2.5 only, never Auto, never -fast. Never haiku. No ultrareview, no Bugbot.
- A lane with "Needs Dave" stops at that point and asks him by AskUserQuestion, one recommended option first.
- Evidence: the "Artifact:" path of a lane gives the file name only. A program lane saves that file in `.claudedocs/e2e-<lane-id>/` in the primary checkout. A worktree cache is lost when the worktree goes.

## Waves

Every dependency sits in an earlier wave. External lanes (not `re-` lanes): `hf-judge-precheck`, `force-high-security-tier`. They have no row in the table and count as wave 0. Each has a section in this map (see "External lanes"). A lane that depends only on an external lane sits in wave 1 or later.

Column "Held until" (T02). An empty cell means no hold. Tokens are separated by "; ". A token is one of these:
- A decision id, for example `DP2.4`: the seat deletes the token after Dave answers that item. No row holds a DP1 token after Dave's DP1 answers of 2026-11-09.
- A lane id: the hold ends when that lane is done with proof (`done --merged <sha>` or `done --no-pr --evidence <file>`). This is a hold, not an edge, so the lane may sit in the same wave or a later wave.
- `<lane id> if <decision id> = <answer>`: a conditional hold. It applies only when Dave gives that answer. It is not a decided edge. After the answer, the coordinator moves the lane id into "Depends on" and raises the wave, or deletes the token. One row holds such a token: `re-retire-critical` (DP2.4). No row holds a DP1 form of it after Dave's DP1.5 and DP1.8 answers of 2026-11-09.
- `first-flip`: the first of the two flips is recorded.
- `dave-yes`: the yes that the lane section names under "Needs Dave".
- `item-trigger`: each item of a holder card opens on its own trigger (Deferred lanes table).
- `seat-hold`: always held. The seat deletes the token when the wait that the row notes name is over. Use it for a wait that holds a lane before its first claim, for example a clock.

Only a lane-id token ends by script. Every other token ends when the seat deletes it from the map. For a deferred lane the token names the main trigger. The Deferred lanes table holds the full text. A deferred lane with an empty cell waits only on its edges.

| Wave | Lane | Phase | Depends on | Needs Dave | Change | Held until |
|---|---|---|---|---|---|---|
| 0 | `re-land-ledger` | P3 | none |  | changed |  |
| 0 | `re-test-globs` | GATE | none |  | new |  |
| 0 | `re-critical-model-check` | P1-followup | none |  | unchanged |  |
| 0 | `re-answer-key-audit` | P1-followup | none | yes | new |  |
| 0 | `re-gold-schema` | P3 | none |  | unchanged |  |
| 0 | `re-dispositions` | P3 | none |  | unchanged |  |
| 0 | `re-finder-v2` | P4 | none |  | unchanged |  |
| 0 | `re-verifier` | P4 | none |  | changed |  |
| 0 | `re-engine-seam` | P4 | none |  | changed |  |
| 0 | `re-claude-backend` | P4 | none |  | unchanged |  |
| 0 | `re-test-escapes` | TEST | none |  | new |  |
| 1 | `re-live-advisory` | GATE | re-critical-model-check, re-answer-key-audit |  | new |  |
| 1 | `re-eval-contract` | P3 | re-gold-schema |  | changed |  |
| 1 | `re-engine-cli-schema` | P4 | re-engine-seam |  | new |  |
| 1 | `re-cr-keys` | DEMOTE | force-high-security-tier |  | new |  |
| 1 | `re-prepr-bundle` | GATE | re-test-globs |  | changed |  |
| 1 | `re-szz-miner` | P3 | re-critical-model-check, re-gold-schema, re-test-escapes |  | changed |  |
| 1 | `re-seed-gold-b` | P3 | re-critical-model-check, re-gold-schema, re-answer-key-audit | yes | changed |  |
| 1 | `re-gold-c-external` | P3 | hf-judge-precheck, re-critical-model-check, re-gold-schema |  | unchanged |  |
| 1 | `re-rubrics` | P6 | re-critical-model-check |  | unchanged |  |
| 1 | `re-property-tests` | TEST | re-test-escapes | yes | deferred | dave-yes |
| 2 | `re-live-accrual` | GATE | re-live-advisory | yes | new |  |
| 2 | `re-label-two-family` | P6 | re-live-advisory, re-dispositions |  | new |  |
| 2 | `re-score-paired` | P3 | re-gold-schema, re-eval-contract |  | changed |  |
| 2 | `re-verifier-replay` | P4 | re-verifier, re-engine-seam, re-eval-contract, re-answer-key-audit |  | new |  |
| 2 | `re-prepr-cli-consumer` | DEMOTE | re-prepr-bundle, re-cr-keys, re-land-ledger, re-test-escapes |  | new |  |
| 2 | `re-shadow-retro` | P3 | re-eval-contract, re-live-advisory, re-dispositions |  | changed |  |
| 2 | `re-gate-ready-a` | GATE | re-engine-seam, re-engine-cli-schema, force-high-security-tier |  | changed |  |
| 2 | `re-cr-rule2` | P5 | re-engine-cli-schema, re-verifier, re-cr-keys |  | changed |  |
| 2 | `re-rubric-runners` | P6 | re-rubrics, re-engine-cli-schema |  | changed |  |
| 2 | `re-gold-assemble` | P3 | re-eval-contract, re-szz-miner, re-seed-gold-b, re-gold-c-external, re-dispositions |  | unchanged |  |
| 2 | `re-owners-hotspots` | P5 | re-eval-contract |  | deferred | DP2.4 |
| 3 | `re-gate-ready-b` | GATE | re-gate-ready-a, re-land-ledger |  | changed |  |
| 3 | `re-cr-trustlist` | P5 | re-cr-rule2, re-cr-keys |  | new |  |
| 3 | `re-p4-wire` | P4 | re-engine-seam, re-engine-cli-schema, re-claude-backend, re-verifier, re-finder-v2, re-verifier-replay |  | changed |  |
| 3 | `re-judge-calibrate` | P6 | re-rubrics, hf-judge-precheck, re-seed-gold-b, re-rubric-runners, re-label-two-family |  | changed |  |
| 3 | `re-gate-shadow-run` | GATE | re-prepr-cli-consumer, re-engine-cli-schema, re-live-accrual | yes | changed | DP2.5 |
| 3 | `re-gate-summary-sample` | GATE | re-cr-rule2, re-live-advisory | yes | changed |  |
| 3 | `re-scores-ledger` | P6 | re-rubric-runners |  | deferred | first-flip |
| 4 | `re-retire-prepr-cli` | DEMOTE | re-live-accrual, re-land-ledger, re-dispositions, re-test-escapes, re-cr-keys, re-prepr-cli-consumer, re-label-two-family, re-judge-calibrate | yes | new | re-cr-trustlist; seat-hold |
| 4 | `re-p4-harness` | P4 | re-p4-wire, re-eval-contract, re-score-paired, re-gold-assemble, re-answer-key-audit |  | new |  |
| 4 | `re-demote-mechanism` | DEMOTE | re-gate-ready-a, re-gate-ready-b, re-gate-summary-sample, re-shadow-retro, re-cr-trustlist, re-score-paired, re-live-advisory |  | changed |  |
| 4 | `re-l1-schedule` | P3 | re-shadow-retro, re-land-ledger, re-dispositions, re-judge-calibrate, re-test-escapes | yes | changed |  |
| 4 | `re-delta-wire` | GATE | re-gate-shadow-run, re-engine-cli-schema | yes | changed | DP2.5 |
| 4 | `re-aggregate` | P6 | re-rubrics, re-scores-ledger, re-dispositions, re-gold-assemble, re-judge-calibrate, re-rubric-runners |  | deferred | first-flip |
| 5 | `re-p4-ab` | P4 | re-p4-harness, re-gold-assemble | yes | changed |  |
| 5 | `re-repromote-auto` | DEMOTE | re-demote-mechanism, re-gate-summary-sample, re-prepr-cli-consumer, re-l1-schedule |  | changed |  |
| 5 | `re-scoreboard` | program | re-score-paired, re-eval-contract, re-gold-assemble, re-land-ledger, re-l1-schedule |  | changed |  |
| 5 | `re-review-doctor` | P6 | re-aggregate, re-judge-calibrate, re-l1-schedule | yes | deferred | first-flip |
| 6 | `re-holdout-rotate` | P6 | re-p4-ab, re-eval-contract |  | changed |  |
| 6 | `re-rule-docs` | DEMOTE | re-gate-ready-a, re-gate-ready-b, re-demote-mechanism, re-repromote-auto, re-prepr-cli-consumer |  | changed |  |
| 6 | `re-refs-impact` | P5 | re-owners-hotspots, re-verifier, re-p4-wire, re-p4-ab |  | deferred | DP2.4 |
| 7 | `re-p4-winner-evidence` | P4 | re-p4-ab, re-holdout-rotate, re-shadow-retro | yes | new |  |
| 7 | `re-p5-multirun` | P5 | re-p4-ab, re-refs-impact, re-owners-hotspots, re-p4-wire |  | deferred | DP2.4 |
| 8 | `re-retire-critical` | DEMOTE | re-demote-mechanism, re-repromote-auto, re-gate-summary-sample, re-gate-ready-a, re-gate-ready-b, re-score-paired, re-p4-winner-evidence, re-judge-calibrate, re-scoreboard, re-l1-schedule, re-rule-docs, re-cr-trustlist | yes | new | re-refs-impact if DP2.4 = yes; re-p5-multirun if DP2.4 = yes; re-retire-prepr-cli |
| 8 | `re-p5-online` | P5 | re-p5-multirun, re-holdout-rotate | yes | deferred | DP2.4 |
| 9 | `re-p5-online-hotfile` | P5 | re-p5-online | yes | deferred | DP2.4 |
| 9 | `re-loop-dryrun` | P6 | re-review-doctor, re-gate-shadow-run, re-p5-online | yes | deferred | first-flip |
| 9 | `re-p7-calibrated-cutoff` | P7 | re-demote-mechanism, re-gold-assemble, re-retire-critical |  | deferred |  |
| 10 | `re-p5-online-union` | P5 | re-p5-online-hotfile | yes | deferred | DP2.4 |
| 10 | `re-p7-backlog` | P7 | re-loop-dryrun | yes | deferred | item-trigger |
| 11 | `re-p7-impact-arms` | P7 | re-p5-online-union | yes | deferred |  |

Row notes for the holds added by the seat on 2026-11-10 (execution plan, waits O2, O5 and O6; seat calls 7a and 7b, which Dave can overrule):
- `re-retire-prepr-cli` holds `re-cr-trustlist` (O2). Both lanes own named keys of review-router.config.json, so neither the lint nor `program.mjs ready` orders them. The token does.
- `re-retire-prepr-cli` holds `seat-hold` (O5). The lane is claimed 1 round before the 58-day point (58 days after the first counted sweep: 4 counted weeks, then 30 days for bar row 3), not when its dependencies are done. The seat deletes the token then.
- `re-retire-critical` holds `re-retire-prepr-cli` (O6). The CRITICAL gate lane is claimed after the CLI gate lane is done. Its sample takes more than 7 days, so the holder then releases it as `blocked` with no owner (see "Long lanes" in "How to use this map").
- Wait O1 (nobody holds `re-live-accrual` during its 2 sweep weeks) is not a token. It is a wait in the middle of that lane. Its rule is in the long-lane bullet of "How to use this map".

Row notes for `re-retire-prepr-cli` after Dave's DP1 answers of 2026-11-09. The row holds no conditional token now:
- Route J (DP1.8, decided): the lane waits for `re-judge-calibrate`. This is a table edge, and the lane sits in wave 4. No lane depends on `re-retire-prepr-cli`, so no later wave moves.
- Path F (DP1.5, decided): the lane does not wait for `re-p4-ab`. The path W token is removed.
- Split (DP1.18, decided): the lane waits for `re-live-accrual` (the sweep weeks), not for `re-live-advisory`.
- No edge from `re-cr-trustlist` to `re-retire-prepr-cli` is added (T02). That edge would pull `re-cr-rule2` and `re-verifier` into the CLI gate closure. `re-engine-cli-schema` is in the closure already under route J.

Counts: 62 lanes (59 before the premortem; the split of `re-gate-ready` adds 1; the split of `re-live-advisory`, DP1.18, adds `re-live-accrual`; Dave's yes of 2026-11-11 adds `re-answer-key-audit`). 15 new, 25 changed, 8 unchanged, 14 deferred (13 from 11-05 plus the new `re-property-tests`). 3 dropped. 19 lanes need Dave (24 before the DP1 answers of 2026-11-09). 16 lanes have a hold (23 before the answers; the answers end every DP1 hold; 14 before the conditional hold on `re-retire-critical` of 2026-11-10; 15 before the holds of the seat on `re-retire-prepr-cli`). The 2 external lanes are not in these counts. `re-holdout-rotate` moves from unchanged to changed (T20). `re-seed-gold-b` moves from unchanged to changed (its edge on `re-answer-key-audit`).

Dependency closure of `re-retire-prepr-cli` under path F with route J (computed from the table, 21 lanes): `re-live-accrual`, `re-live-advisory`, `re-land-ledger`, `re-dispositions`, `re-test-escapes`, `re-cr-keys`, `force-high-security-tier`, `re-prepr-cli-consumer`, `re-prepr-bundle`, `re-test-globs`, `re-label-two-family`, `re-judge-calibrate`, `re-rubrics`, `re-critical-model-check`, `hf-judge-precheck`, `re-seed-gold-b`, `re-gold-schema`, `re-rubric-runners`, `re-engine-cli-schema`, `re-engine-seam`, `re-answer-key-audit`.
- Route J brings 9 of the 21: `re-judge-calibrate` and its chain. Two gold lanes are in the closure (`re-seed-gold-b`, `re-gold-schema`), and the two P4 prefactor lanes (`re-engine-seam`, `re-engine-cli-schema`).
- No P4 A/B lane is in it: no `re-p4-wire`, `re-p4-harness`, `re-p4-ab` or `re-gold-assemble`.
- `re-answer-key-audit` comes in through `re-live-advisory`, and through `re-seed-gold-b` too.
- Before the answers the closure held 10 lanes (path F with route T). That reading is void.

Dependency closure of `re-retire-critical`: 45 lanes (43 before the `re-gate-ready` split, 44 before `re-answer-key-audit`), through `re-p4-winner-evidence`, `re-judge-calibrate` and the gold lanes. `re-live-accrual` is not in it.

## Dropped or merged lanes

| Lane | What happened | Where its work went |
|---|---|---|
| `re-runbook-docs` | Dropped (D3) | This map is the one program map. Numbering, owners and the leak rule are in this file. The budget rules are in [capacity.md](capacity.md). |
| `re-holdout-record` | Folded (D3) | `re-score-paired` writes holdout.json from the scorecard and the holdout-spend ledger line. |
| `re-cr-retire-gate` | Replaced (B1) | `re-retire-prepr-cli` (pre-pr CLI band) and `re-retire-critical` (CRITICAL PR bot). The HIGH gate is dropped: HIGH gets no PR bot under the interim rule (pr-checkpoint.mjs:300-310). HIGH stays covered only by the rule-2 path in `re-cr-rule2`. |


Split or moved work (no lane is dropped by these rows):

| Lane | What happened | Where its work went |
|---|---|---|
| `re-engine-seam` PR B | Split out | New lane `re-engine-cli-schema`. `re-engine-seam` keeps PR A. |
| `re-p4-wire` eval half | Split out | New lane `re-p4-harness`. `re-p4-wire` keeps the engine half. |
| `re-cr-rule2` config keys and trust lists | Split out | New lanes `re-cr-keys` (keys) and `re-cr-trustlist` (trust-list growth, under the DP1.3 answer: no PR bot on `re-` PRs). |
| `re-gate-shadow-run` prepr_cli consumer | Moved | New lane `re-prepr-cli-consumer`, which also reads band-state. |
| `re-delta-wire` HIGH round-2 replacement | Dropped | No PR bot runs at HIGH today, so there is no round 2 to replace. The delta record stays. |
| `re-prepr-bundle` glob registration | Moved | New lane `re-test-globs`. |
| `re-gate-ready` | Split (T14: one lane, one PR) | `re-gate-ready-a` keeps PR A (READY from the engine record in review-status.mjs). `re-gate-ready-b` takes PR B (Gate C, the waiver, land-recheck.mjs and land-pr.ps1). Every lane that depended on `re-gate-ready` now depends on both. |
| `re-live-advisory` | Split (DP1.18, Dave 2026-11-09) | `re-live-advisory` keeps the build: the sweep script, engine-version.mjs and the first sweep. New lane `re-live-accrual` takes the daily runs, the weekly reports, the pool percent read, the pair count on the master card and the 2-week check. `re-label-two-family`, `re-shadow-retro`, `re-gate-summary-sample` and `re-demote-mechanism` stay on `re-live-advisory`. `re-retire-prepr-cli` and `re-gate-shadow-run` now depend on `re-live-accrual`. |

## Deferred lanes

These lanes are off the path to the first two flips. Their sections are in "Lanes" in this map. The edits named in this table are written into those sections, with one exception. Do not apply a written edit a second time.

- Written, the Depends on edits: `re-refs-impact`, `re-p5-online-union`, `re-p7-calibrated-cutoff` and `re-p7-impact-arms`.
- Written, the arm (b) edit and the Done when edit: `re-p5-online-hotfile`.
- Written, the Done when edit: `re-loop-dryrun`.
- Written, the two triggers: `re-p7-backlog`.
- Written, old decision 9 in the Needs Dave line: `re-review-doctor`.
- Not written into a section: the two notes of `re-refs-impact`, on the local-review.mjs chain and on the freeze set. They stay in this table. "Owner chains" in "Shared contracts" also holds the chain. The freeze-set note is now also a conditional hold token on `re-retire-critical` in the Waves table (DP2.4), with `re-p5-multirun`.

| Lane | Trigger that brings it back | Edits to apply when it returns |
|---|---|---|
| `re-owners-hotspots` | Same trigger as `re-refs-impact`. | none |
| `re-refs-impact` | DP2: cross-file same-issue recall stays at 0 or 1 of the cross-file Majors with prompt v2 in the `re-p4-ab` per-class table. Then it runs before the CRITICAL counted weeks start. | Depends on `re-p4-wire` and `re-p4-ab` (D1). local-review.mjs chain: `re-engine-seam`, `re-engine-cli-schema`, `re-p4-wire`, `re-refs-impact`, `re-p5-multirun`. A change to context.mjs or CONTEXT_VERSION is in the freeze set, so it lands before the counted weeks. |
| `re-p5-multirun` | Same trigger, or `re-p4-winner-evidence` fails the fresh-holdout check. | none |
| `re-p5-online` | Same as `re-p5-multirun`. | none |
| `re-p5-online-hotfile` | Same. Runs before the union arm (reordered). | Compare arm (d) with arm (b), not with the union arm. Done when: "keep or kill recorded", not "higher recall". |
| `re-p5-online-union` | Same. Runs after the hot-file arm. | Depends on `re-p5-online-hotfile`. |
| `re-scores-ledger` | After the first flip, when the loop work starts. | none |
| `re-aggregate` | After the first flip. | none |
| `re-review-doctor` | After the first flip. | Old decision 9 (CCv3-Review-Doctor task) moves with it. |
| `re-loop-dryrun` | After the first flip, and only between counted windows (loop PRs change the freeze set). | Done when: a week with 0 proposals reports NOTE, not PASS. |
| `re-p7-calibrated-cutoff` | After `re-retire-critical` decides. It changes bandOf, which is in the band freeze set. | Depends on `re-retire-critical` (T02). The wait is now a table edge. The lane moves from wave 6 of the 11-05 map to wave 9 of this map. The 11-05 waves start at 1, so wave 6 there is wave 5 on the scale of this map. |
| `re-p7-impact-arms` | After the P5 arms return and finish. | Depends on `re-p5-online-union` (last P5 arm after the reorder). |
| `re-p7-backlog` | Holder card. Each item opens on its own trigger. | Write triggers for 7.5 (coverage map) and 7.9 (Stryker or fast-check hints): `re-test-escapes` shows 2 or more escapes in 4 weeks of the cause class the item covers. |
| `re-property-tests` (new) | Dave's yes on the fast-check install (E3). | See its section. |

P5 returns to the path if cross-file recall stays near 0 after the phase 4 A/B. Cross-file is 0 of 6 today, and 3 of the 4 Majors missed in both P1 runs are cross-file (eval, refuter on sequencing-p4-unblock). With P5 off the path, no bar row tests that class until the trigger fires. See "Not covered / risks".

## Shared contracts (one owner each)

Every shared contract is written in full here (T17). No 11-05 contract text stays in force. Where this section and the 11-05 map differ, this section wins. Two 11-05 statements are void: the trust-list growth owner (11-05 map line 75) and the daily headless shares (11-05 map line 84). Their text here replaces them.

Contracts restated from the 11-05 map, with the owners of this map:

- **Gold-row contract.** Owner `re-gold-schema` (scripts/eval/review-eval/gold.mjs, wave 0). Fields: {id, source:'A'|'B'|'C'|'CR', suite:'regression'|'capability', split:'dev'|'holdout'|'reserve', target:{repo?,pr,round,sha40}|{range:'base..head'}, file, line?, severity, linkType, labels:[{by,verdict,judgeVersion?}], provenance, slice?:'security'}. Source 'CR' is for the rows of gold/adjudicated-cr.json. `target.repo` is 'owner/name' in lower case only: required when source is 'C', refused for every other source. The range form has no repo. Clean controls (gold/clean-controls.json): {id, split, target, provenance}, with the same split values and target forms, and no repo. gold.mjs loads them with loadCleanControls, because no later lane owns gold.mjs. loadGold skips clean-controls.json and escape-baseline.json. Producer rule for suite (seat, 2026-11-11): 'regression' only when a recorded engine run caught the defect, else 'capability'. Readers: `re-eval-contract` (dataset.mjs), `re-szz-miner`, `re-seed-gold-b`, `re-gold-c-external`, `re-score-paired`, `re-gold-assemble`, `re-p4-harness` and `re-judge-calibrate`. gold/*.json has one file per producer lane. gold-a, clean-controls and escape-baseline: `re-szz-miner`. gold-b: `re-seed-gold-b`. gold-c: `re-gold-c-external`. adjudicated-cr: `re-gold-assemble`.
- **Answer-key isolation.** Owner `re-critical-model-check` (cursor-review.mjs TREE_EXCLUDES). scripts/eval/review-eval/gold, seeds, rubrics and linktype-labels.json never reach a review tree or PR.diff. Every gold-producing lane depends on this lane. The excludes do not stop a read by absolute path: Windows has no Cursor sandbox (cursor-review.mjs:36). Owner `re-answer-key-audit` (scripts/eval/review-eval/read-audit.mjs) audits the saved stream of each counted run and voids a run that reads outside its tree. Every lane that counts a Cursor run over gold, seeds, rubrics or same-head pairs depends on that lane, directly or through another lane.
- **Backend contract.** Owner `re-engine-seam`. backends/<name>.mjs exports run({promptPath, reviewDir, model, effort, timeoutMs}) -> {text, traceEvents, exitCode, costTag}. backends/cursor.mjs comes from `re-engine-seam`. backends/claude.mjs comes from `re-claude-backend`. verify.mjs calls a backend through injection. Model ids are checked in code: Cursor MODEL_ALLOWLIST only (no -fast, no auto), Claude never haiku. That check lands in `re-engine-cli-schema`.
- **Record schema.** Owner `re-engine-cli-schema` (local-review/record.mjs). The 11-05 map named `re-engine-seam`; PR B is now its own lane. One RECORD_SCHEMA bump (from 1) declares these fields: verify[] {findingId, verdict, refutedAt?}, uncertainMajors, armId, promptVersion, contextVersion, impactRows, overallCorrectness, runIds[], cursorRunId, engineMainSha. Prompt v2 (`re-finder-v2`) produces overallCorrectness. Readers: `re-p4-wire`, `re-cr-rule2`, `re-gate-ready-a`, `re-gate-summary-sample`, `re-rubric-runners`, `re-scoreboard`, `re-p5-multirun` (deferred) and the land ledger.
- **ENGINE_FILES** (local-review.mjs:62). It grows in the lane that adds each file, in the same PR: backends/cursor.mjs (`re-engine-seam`); verify.mjs and backends/claude.mjs (`re-p4-wire`); refs.mjs, owners.json, hotspots.json and checklist.json (`re-refs-impact`, deferred).
- **Trust lists.** CRITICAL_TRUST_BOUNDARY, checkpoint.critical and matrix.control_plane grow in `re-cr-trustlist`, under the DP1.3 answer (Dave, 2026-11-09: CLI plus engine, no PR bot on `re-` PRs). So scripts/eval/review-eval/** stays out of CRITICAL_TRUST_BOUNDARY. They do not grow in `re-cr-rule2`.
- **Eval contract files.** config.json, freeze.mjs, budget.mjs and dataset.mjs: owner `re-eval-contract`. config.json has a later owner, `re-holdout-rotate`. cli.mjs has its own chain (see owner chains). Changes are additive: checkEngineFreeze, checkFreeze, recordEngineFreeze and budgetFromFile keep their signatures, and engineFreeze.promptSha256.full stays readable. Versioned freeze entries are keyed by promptVersion. contextVersion joins in `re-p4-harness`, with a fallback when CONTEXT_VERSION is absent (`re-refs-impact`, deferred, exports it). Experiment lanes write freeze data only through cli freeze. Holdout-spend ledger: one line per holdout scoring of a frozen arm.
- **Scorecard JSON.** Owner `re-score-paired` (score.mjs): pairedBar {regression:{delta,lo,hi}, capability:{...}} from a cluster bootstrap over PRs, perArm, perSuite, perSource, cleanFalseMajor, lostCaughtMajors, reliability {runFailure, repairedJson, p95WallMs, findingsVariance}. Readers: `re-p4-ab`, `re-p4-winner-evidence`, `re-scoreboard`, `re-retire-critical` and the P5 online arms (deferred).
- **shadow decide output.** Owner: the holder of shadow.mjs at the time. It is a stable row list (name, value, verdict). The scoreboard reads it as a generic list. `re-demote-mechanism` makes decideBand read holdout.json and the escape baseline. The paired-bar row stays NOTE while its OPEN item is open.
- **Land-outcomes ledger.** ~/.claude/state/land-outcomes.jsonl (owner `re-land-ledger`): {pr, headSha, mergeSha, band, reviewers[], engineRecord?, crRounds, waiver?}. `re-gate-ready-b` adds the waiver field and the open-Major field (E2). Readers: `re-l1-schedule`, `re-scoreboard` and the two gate lanes.
- **Test registration.** Owner `re-test-globs`, not `re-prepr-bundle`. Globs: scripts/eval/review-eval/*.test.mjs (new eval-scripts surface), scripts/github/local-review/**/*.test.mjs and scripts/lib/*.test.mjs, in pre-pr.mjs and ccv3-checks.yml. A new test file in those folders needs no more registration. Until the lane lands, `re-engine-seam` and `re-claude-backend` run their backends tests by hand and save the output.
- **Shared machine resources.** They have no file owner. The ledgers enforce the caps, not lane discipline.
  - Cursor ledger: weekly cap 300 (our own number). Eval and shadow runs stop at 240. The label runs of `re-label-two-family` count in the same 7-day ledger count, and that lane stops at 240 too. Live runs stop at the live cap (below). Dave approved the caps as our own numbers (DP1.2, 2026-11-09). No cap goes up before the pool share is measured.
  - Grok slots: max 2.
  - Cursor eval slot: one token, claimed in the lane note. Only one of these lanes spends at a time: `re-shadow-retro`, `re-verifier-replay` (Cursor backend), `re-label-two-family` (its Cursor runs: Grok 4.7 for CLI-only findings, and a second family that is not Grok for engine findings [Speculation: Composer 2.5]), `re-p4-ab`, `re-p4-winner-evidence`, and the deferred lanes `re-p5-online`, `re-p5-online-hotfile`, `re-p5-online-union`, `re-loop-dryrun` (minibatches) and `re-p7-impact-arms`. This bullet is the one list of the lanes that spend from the slot: `program.mjs ready` reads it.
  - Headless claude -p: 200 a day (Dave, 2026-11-14; it was 30), shared with non-RE sessions. The day plan in "Capacity plan" is a planning aid for the shares, not a limit. Each lane checks the headless ledger before a batch.

Contracts that this map changed or added:

- **Freeze set (B3).** Two lists, both computed by `scripts/eval/review-eval/engine-version.mjs` (owner `re-live-advisory`).
  - Reviewer set: scripts/github/local-review.mjs, scripts/github/cursor-review.mjs, scripts/github/review-filter.mjs, every non-test file under scripts/github/local-review/ (with checklist.json, owners.json and hotspots.json when they exist), PROMPT_VERSION, CONTEXT_VERSION when it exists, and the local_review block of review-router.config.json.
  - Band set: bandOf and CRITICAL_TRUST_BOUNDARY in scripts/github/review-router.mjs (lines 107 and 121 today), and the matrix block of review-router.config.json.
  - Frozen SHA (DP1.5, path F). Dave's answer of 2026-11-09 freezes today's engine. DECIDED (Dave, 2026-11-10): the frozen SHA is the `main` SHA right after `re-critical-model-check` lands. The coordinator records the value then, before the first counted run (see `re-live-advisory`, "Labels"). Recorded in `decisions.md`, "Open after DP1", point (b).
  - Exempt: the coderabbit.* keys, config blocks that neither the engine nor bandOf reads, and the local_review keys that set only caps and slots (weekly_live_cap, max_concurrent, per_branch_cap, slot_wait_min, headless_daily_cap). A cap raise therefore does not reset a counted window.
  - engineVersion is the hash of the reviewer set at one SHA. bandVersion is the hash of the band set. The 11-05 rule "engineVersion hashes every ENGINE_FILES blob" is replaced: ENGINE_FILES holds review-router.config.json (local-review.mjs:62-67), so each flip would change the version of its own evidence.
  - ENGINE_FILES itself does not change meaning. It still decides trusted:true (computeTrust, local-review.mjs:276-284).
- **engineVersion set per gate.** The CLI gate counts rows with one engineVersion. The CRITICAL gate counts rows with one engineVersion and one bandVersion. Rows labelled "rehearsal" never count.
- **Live cap (C2).** One number: 100 Cursor ledger starts per 7 days for all live engine runs (the sweep in `re-live-advisory` and `re-live-accrual`, later `re-gate-shadow-run` and `re-delta-wire`). The sweep enforces it first, as one constant. `re-engine-cli-schema` then adds local_review.weekly_live_cap to KINDS and LOCAL_REVIEW_DEFAULTS (local-review.mjs:70-75), and every live caller reads that key. Dave approved 100 as our own cap (DP1.2, 2026-11-09). Raise it only after the pool share is measured, and only when the eval need plus the cap stays under 240.
- **Per-phase eval budget (C1).** budget.mjs counts all-time review-eval starts against cursorEvalBudget 120 today (budget.mjs:30-38). `re-eval-contract` adds a phase scope tag. The 75 untagged starts count as P1. P4 shows 120 free. Shadow runs (kind shadow) stay outside the eval budget and under shadow.dailyMax 6 and the global stop of 240. The label runs of `re-label-two-family` stay outside the eval budget too. They stay under the lane cap of 40 and the global stop of 240.
- **Band state (B8).** ~/.claude/state/band-state.json, written by `scripts/eval/review-eval/band-state.mjs`. Owner chain: `re-prepr-cli-consumer` (writer, CLI-band triggers, pre-pr reader) then `re-repromote-auto` (PR-bot triggers, pr-checkpoint reader). pre-pr.mjs reads it, so a demoted CLI band comes back with no session.
- **Escape rows.** ~/.claude/state/review-engine/escapes.jsonl and ~/.claude/state/review-engine/escape-baseline.json (owner `re-test-escapes`). One writer module: fix-chains.mjs. The source is fix-commit blame, not CodeRabbit findings, so the rows keep coming after a flip. Row: {mergeSha, pr, band, blamedPr, cause, severity?, severityBy?, linkedFinding?}. `re-szz-miner` copies the baseline into gold/escape-baseline.json. band-state.mjs and shadow decide read the gold copy when it exists, else the state copy. The baseline is built from fix-chains rows only (T14).
- **Full dispositions file.** ~/.claude/state/review-engine/<date>-dispositions.json (owner `re-dispositions`). It is never inside a repo tree. Fields: rulesVersion, generatedAt, range, and one key per record. Records carry no split. The bot's own marker gives fixed with evidence cr_marker and verdict null, and it makes no gold label. The marker ranks below every trusted reply. Readers: `re-label-two-family`, `re-gold-assemble`, `re-l1-schedule`, `re-aggregate`, `re-shadow-retro` and `re-retire-prepr-cli`. When nightly files are merged, merge them by key, and the newest generatedAt wins.
- **Same-head pairs.** ~/.claude/state/local-review/cli-pairs/<pr>/<sha>.txt (owner `re-live-advisory`): the pre-pr CLI output beside the engine record of the same head. Writers: the sweep copies the file from the worktree cache; from `re-prepr-cli-consumer` on, pre-pr writes it at the time it writes the CLI output (T03). The file name is the same, so a second write of one head changes nothing. Reader: cli-gate.mjs (`re-label-two-family`). The sweep also tags pinned-copy records (T21). [Speculation: the tag is a list file in this folder; see `re-live-advisory`.]
- **holdout.json.** ~/.claude/state/local-review/eval/holdout.json: {engineVersion, majors, found, recall, pairedBar}. Owner `re-score-paired` (fold of `re-holdout-record`). `re-p4-winner-evidence` writes the first real row. Reader: shadow decide (`re-demote-mechanism`).
- **review-router.config.json keys.** First owner `re-cr-keys`. It adds engine_gate.report_only (true), coderabbit.demoted.prepr_cli (an empty list of risk bands), coderabbit.demoted.critical (false), coderabbit.blind_sample_rate (0), routing.calibrated_cutoff (false), local_review.union_runs (false), local_review.hotfile_pass (false). coderabbit.demoted.high is not added (HIGH gate dropped). Each consumer reads its key with the same code fallback: `re-gate-ready-a` (report_only), `re-prepr-cli-consumer` (prepr_cli), `re-demote-mechanism` (critical), `re-gate-summary-sample` (blind_sample_rate), `re-p7-calibrated-cutoff` (calibrated_cutoff), `re-p5-multirun` (union_runs, hotfile_pass). Type of coderabbit.demoted.prepr_cli (DP1.15, Dave 2026-11-09): a list of risk bands, not one boolean. The off value and the code fallback are the empty list. LOW has no effect in the list while the engine does not review LOW. coderabbit.demoted.critical stays a boolean.
- **Owner chains.** Each chain is serialized by dependency: a later owner depends on the earlier owner, directly or through other lanes. The one exception is review-router.config.json.
  - local-review.mjs: `re-engine-seam`, `re-engine-cli-schema`, `re-p4-wire`, `re-refs-impact` (deferred), `re-p5-multirun` (deferred).
  - local-review-sweep.mjs and its test: `re-live-advisory`, `re-live-accrual` (fixes only, after the build lane is done). engine-version.mjs: `re-live-advisory` only.
  - cli.mjs: `re-eval-contract`, `re-gold-assemble`, `re-p4-harness`.
  - trace.mjs: `re-p4-wire`, `re-p5-multirun` (deferred).
  - replay.mjs: `re-answer-key-audit`, `re-p4-harness`. engine-run.mjs: `re-p4-harness`.
  - prompt.mjs: `re-finder-v2`, `re-p4-ab` (default flip), `re-p7-impact-arms` (deferred).
  - context.mjs: `re-refs-impact` (deferred), `re-p7-impact-arms` (deferred).
  - parser-fixtures/registry.mjs: `re-verifier`, `re-refs-impact` (deferred).
  - config.json (eval): `re-eval-contract`, `re-holdout-rotate`.
  - pre-pr.mjs: `re-test-globs`, `re-prepr-bundle`, `re-prepr-cli-consumer`, `re-gate-shadow-run`.
  - review-router.mjs: `force-high-security-tier` (external, bandOf), `re-cr-rule2`, `re-cr-trustlist`, `re-demote-mechanism`, `re-p7-calibrated-cutoff` (deferred).
  - review-router.config.json: `force-high-security-tier` (external), `re-cr-keys`, `re-cr-trustlist`, then the two gate lanes for their own flip key: `re-retire-prepr-cli`, then `re-retire-critical`.
  - pr-checkpoint.mjs: `re-cr-rule2`, `re-gate-summary-sample`, `re-repromote-auto`.
  - shadow.mjs: `re-shadow-retro`, `re-demote-mechanism`, `re-repromote-auto`.
  - band-state.mjs: `re-prepr-cli-consumer`, `re-repromote-auto`.
  - land-pr.ps1: `re-land-ledger`, `re-gate-ready-b`.
  - review-status.mjs: `re-gate-ready-a`. land-recheck.mjs: `re-gate-ready-b`.
  - catchers.mjs: `re-test-escapes` (new owner).
  - tasks.json and package.json (its test scripts line): `re-l1-schedule`, then `re-review-doctor` (deferred).
- **Owner chain notes.** The parser of `program.mjs` reads only the chain lines above. These notes go with them.
  - pre-pr.mjs: scanner-tuning no longer holds the file. It keeps the zizmor and opengrep items only.
  - review-router.config.json: no edge orders the two gate lanes, because the flip order is a DP3 choice. Hold tokens order them since 2026-11-10: `re-retire-prepr-cli` holds `re-cr-trustlist` (O2), and `re-retire-critical` holds `re-retire-prepr-cli` (O6). A gate lane edits only its own coderabbit.demoted key and claims the file through the lane note before it starts. No edge from `re-cr-trustlist` to `re-retire-prepr-cli` is added (T02): it would pull `re-cr-rule2` and `re-verifier` into the CLI gate closure. This is the one chain that is ordered by holds, not by dependency.
  - The lint (`program.mjs check`) and `program.mjs ready` both exempt two owners of one file when both name keys only. `ready` holds back a lane whose Owns list overlaps a lane in state `active` or `review` in every other case (T02, T18). So for this file the hold tokens are the guard.
  - tasks.json: the `scheduler-child-safe-and-wake` hold is gone (merged in PR #334).

## Evidence bar

This section is in [evidence-bar.md](evidence-bar.md).

## Decision points for Dave

This section is in [decisions.md](decisions.md).

## Capacity plan

This section is in [capacity.md](capacity.md).

## Lanes

Unchanged lanes. Their sections are below, after `re-retire-critical`, in Waves-table row order. The sections of the 13 deferred lanes from the 11-05 map follow them.

- `re-gold-schema`: unchanged.
- `re-dispositions`: unchanged.
- `re-finder-v2`: unchanged.
- `re-claude-backend`: unchanged.
- `re-critical-model-check`: unchanged. It must land before any live CRITICAL run (A4). `re-live-advisory` depends on it by edge: the frozen SHA is the `main` SHA right after it lands (Dave, 2026-11-10).
- `re-gold-c-external`: unchanged.
- `re-rubrics`: unchanged.
- `re-gold-assemble`: unchanged.

`re-holdout-rotate` is no longer in this list (T20). Its corrected section is below, after `re-rule-docs`.

`re-seed-gold-b` is no longer in this list. It gained an edge on `re-answer-key-audit` (2026-11-11). Its section stays below.

### re-answer-key-audit

**Answer-key read audit: void a run whose agent reads outside its review tree** (wave 0, phase P1-followup, new)

Dave said yes to this lane on 2026-11-11, before the first counted run over gold. It closes finding 1 of the principal review of `re-critical-model-check` (`.claudedocs/e2e-re-critical-model-check/review-principal.txt`).

- Depends on: none
- Unblocks: re-live-advisory, re-seed-gold-b, re-verifier-replay, re-p4-harness
- Related: re-critical-model-check, re-shadow-retro, re-label-two-family, re-p4-ab, re-p4-winner-evidence, re-claude-backend, re-gate-ready-a
- Owns: `scripts/eval/review-eval/read-audit.mjs` (new), `scripts/eval/review-eval/read-audit.test.mjs` (new), `scripts/eval/review-eval/fixtures/read-audit/**` (new), `scripts/eval/review-eval/replay.mjs` (the audit calls in replayRun and replayEngine only), `scripts/eval/review-eval/replay.test.mjs`
- Do not touch: `scripts/github/cursor-review.mjs`, `scripts/github/local-review.mjs`, `scripts/github/local-review/**`, `scripts/github/review-filter.mjs`, `scripts/eval/review-eval/score.mjs`, `scripts/eval/review-eval/shadow.mjs`, `scripts/eval/review-eval/config.json`, `scripts/eval/review-eval/gold/**`
- Cost: up to 2 Cursor runs for the canary (purpose bench, own ledger session id, outside every eval scope and outside the Cursor eval slot); 0 claude -p
- Needs Dave: DECIDED (Dave, 2026-11-11): yes to up to 2 canary runs. A third run needs a new yes. No DP1.2 number covers this lane.

Scope:
- Place. The guard is a new file outside the freeze set. A guard in cursor-review.mjs would change the reviewer set, and the pinned copy at the frozen SHA would not hold it. The engine does not call runReview: runOnce calls runAgent and parseReviewOutput itself (local-review.mjs:645-652).
- Input: the saved stream, after the run. The engine writes `<runId>.stream.jsonl.gz` beside the record (trace.mjs:250-253). cursor-review.mjs writes `<stem>.raw.json`. Never trace.json: it drops the grep path and the glob folder (trace.mjs:186-187).
- The tree is the cwd of the system/init event. It must have the form `<tmpdir>\cursor-review-<id>\tree`: any other init cwd voids the run. The tree is deleted before the audit runs (local-review.mjs:787-789; cursor-review.mjs:1094), so the audit resolves no link and no 8.3 name. It compares path text: whole segments, both slash forms, case-blind on a drive path.
- A run is void when one of these holds:
  - The stream is missing or empty, or it has no init cwd.
  - A tool call has no `*ToolCall` key, or its kind is not read, grep or glob. This covers shell, MCP and subagent calls and each new tool kind of a later cursor-agent.
  - A string in the arguments or in the result of a tool call is an absolute path, or holds `..`, and points outside the tree. This rule reads every string field, not a list of names: the read path, the grep path and glob, the glob targetDirectory and pattern, the result path and files, the workspaceResults keys, relatedCursorRulePaths and relatedCursorRules. Not read: the grep pattern text, its echo in the grep result (`result.success.pattern`) and returned file content. An empty path and a path relative to the tree do not void. A string that starts with `~`, `%`, `$` or `file:` counts as outside. A device path `\\?\` or `\\.\` that names no drive and no UNC share, for example `\\?\GLOBALROOT\...` or `\\?\Volume{GUID}\...`, counts as a root. A `..` segment or a root inside a brace of a glob pattern or of a grep glob argument voids too (`{..,x}/*`, `{C:/x,y}/**`).
  - One exception (2026-11-11; found by the lane's design scan, corrected after its build scan and an independent security review). When a glob call has a targetDirectory, cursor-agent prints each entry of the result `files` list as `../` plus the path relative to the tree. Read against the tree, that form points to the parent folder. Such an entry does not void (rule name glob-parent-name, counted) only when all of these hold:
    - Form. The targetDirectory is the tree and the entry starts with the exact bytes `../.\`. Or the targetDirectory is a folder inside the tree, the entry starts with exactly one `../`, and the remainder starts with the tree-relative path of that folder.
    - Rest. The rest is not empty. It has no empty, `.` or `..` segment, no root, no drive letter, no prefix form and no answer-key segment. Here an answer-key segment voids inside the tree too.
    - Known file. The rest is a tracked path of the reviewed head (`git ls-tree`, case-blind), or it is one of the files that the harness writes into the tree: `PR.diff`, `DELTA.diff`, `.review/PROMPT.md`, `.review/CONTEXT.md`, `.review/PRIOR.json`. With no head list the entry voids. The scan mode takes the head from the name of the head folder.
    - 18 of the 40 saved P1 streams hold 41 tree-level entries of this form, and none is in an argument. The verdict line and the scan count the exempt entries, tree-level and folder-level apart, so a growth is seen. Every other `..` form voids, and every absolute outside path voids, also in glob `files`.
  - An event has a type outside this list: system, user, thinking, assistant, tool_call, result, connection, retry.
  - An outside path that holds an answer-key segment gets the rule name answer-key in its verdict line: `review-eval/gold`, `review-eval/seeds`, `review-eval/rubrics`, `linktype-labels.json`, `.claudedocs`, `local-review-shadow`, `cli-pairs`, `holdout.json`, `.git`. A segment matches whole: `.git` does not match `.github`. Inside the tree a segment does not void: a reviewed PR may change a file with such a name.
  - A tool call has a non-empty hookAdditionalContexts list.
  - The head commit holds a symlink (git ls-tree mode 120000) whose target is absolute or leaves the tree. Two checks read each target, and either check voids the run. The text check reads the target as path text from the folder of the link (the Windows reading). The link walk follows each link of the head one segment at a time (the Unix reading).
  - The run has no tool call that the audit can read.
  - A run that reports success (status ok) has no result event in its stream (rule no-result). An incomplete engine run keeps its status, and the other rules still read its stream.
- Not checked: grep pattern text and file content. Some grep patterns look like paths, and tracked files hold the primary checkout path.
- Agent change: the 40-stream check ran on the cursor-agent of 2026-11-04. When the agent version of a stream differs from the last checked version, the lane that runs the batch runs the audit on its first stream and reads the tool kinds before the batch goes on. An unknown kind voids, so a new agent stops a batch; it never passes unseen.
- The audit keeps its own list of answer-key segments. It does not import TREE_EXCLUDES: the frozen copy holds that list, and this list must grow.
- Record: one line per audited run in `~/.claude/state/review-engine/read-audit.jsonl`: runId, kind, stream path and sha256, verdict (pass or void), rules hit, symlinkCheck (pass or not-run), auditVersion. A reader counts a run only when the replay row has status ok AND the newest line is pass. Reason: an incomplete run with a cut stream can hold a pass line. A run whose line cannot be written is void with the reason `read-audit: record-failed`. Never a .json file beside a record: record.mjs:83 reads each .json file in a head folder as a record.
- Eval and replay runs: replay.mjs writes a run row in two places, replayRun for the cursor-review path (:160) and replayEngine for the engine path (:193). Each audits the run before it writes the row, in the stream form of its path (`.raw.json` or `.stream.jsonl.gz`). A void run gets status failed, void true and a reason that starts `read-audit:`. A throw in the audit voids the row too, with the reason `read-audit: audit-error`. The scorecard then drops the round and counts no miss (score.mjs:157-166, :185). shadow treats it as a failed round (shadow.mjs:252). No new status: shadow returns null for one, and the round retries at each sync (shadow.mjs:253).
- A void is never silent. The scorecard shows no void, and a later run of the same round would replace the void row (score.mjs:157-166). So read-audit.mjs has a summary mode: for a runs file or a list of heads it prints the number of void runs, their rounds, and each round where a later row replaced a void. Every artifact of a counted batch holds that output. A batch with one void or more is NOTE, not PASS, until the seat has read each void stream and written the reason. A round with a void line stays out of the counted set, also after a re-run. This lane does not change score.mjs, and the scorecard keeps the later row. So the summary mode exits 1 on a void, on a replaced void (REPLACED) and on a run with no audit line (unaudited), and a counted artifact whose summary exits 1 is NOTE. A later lane that owns score.mjs may put the rule into the scorecard.
- Live PR reviews: the audit never blocks a review, a push or a land, and it changes no record. The sweep audits each run it starts (`re-live-advisory`). cli-gate.mjs counts a pair only when two facts hold (`re-label-two-family`). The engine record of its run has status ok (for a replay run: the replay row). The newest read-audit line of that run is pass and holds `symlinkCheck: pass`. Reason: an incomplete run with a cut stream can hold a pass line. The single mode without `--repo` writes `not-run`. A run with no line does not count; this covers each run from before the audit.
- Caps: a void run keeps its ledger start, so it counts against the weekly cap, the live cap and the eval budget. The audit writes no ledger line and starts no retry.
- On a void: the lane that ran it stops its batch and tells the seat (`lane.mjs say`). The seat reads the stream before the batch goes on.
- Canary: put a canary file outside every tree. It holds a token that is made at run time and no real answer; the token is only in that file. The canary runs on `main` after `re-critical-model-check` has landed, so that it tests the frozen engine state. Run 1: cursor-review.mjs on a local range, with a prompt that asks the agent to read the canary file by its absolute path. Same flags and env as a review run. Run 2 is only for a retry. The lane also searches the answer text for the token. A token in the answer with no outside read in the stream means a channel that the stream does not show: the lane is then not done and goes to the seat.
- Fixtures: synthetic only. Build the planted streams from `scripts/github/fixtures/cursor-review/stream-json-read-glob.jsonl`. Never copy a holdout stream into git.
- Not covered: the Claude backend stream (`re-claude-backend`); a Claude arm needs its own audit before it counts. The claude -p label and judge runs over gold or rubrics (`re-szz-miner`, `re-rubric-runners`, `re-judge-calibrate`). A read that leaves no tool call event, for example in a gap of the stream after a reconnect. The verdict line and the scan carry the count of gap events: each reconnecting event and each resume retry counts as one. A gap does not void.
- Limit: the read audit is valid for a native Windows reader only. A POSIX checkout or a case-blind POSIX lookup is not covered: link names with a backslash, link names with two dots and a space, and letter case. The card `read-audit-followups` holds these points. It must be done before the engine runs on Linux, macOS or WSL.

Done when: `node scripts/eval/review-eval/read-audit.mjs` reads the 40 saved P1 streams in place (`.claude/cache/e2e/2026-11-04-p1-holdout-*/engine-state/**/*.stream.jsonl.gz`) and voids 0; the glob-parent-name entries are counted, tree-level and folder-level apart, not voided. The scan also prints the event types seen and the count of gap events. The artifact holds counts only. Planted fixtures each void: a read of the primary checkout's linktype-labels.json in the forms `C:\`, `c:/`, `/c/` and `\\?\C:\`; a read path with `..` out of the tree; a grep path outside; a glob targetDirectory outside; a grep glob argument outside; a relatedCursorRulePaths entry outside; a shellToolCall line; a tool call with no `*ToolCall` key; a non-empty hookAdditionalContexts list; no init event; an init cwd of another form; an empty stream; a head with a symlink to the primary checkout. More planted fixtures that void: a glob `files` entry of the forms `..\x`, `..\..\x` and `..\a\b`; a tree-level entry `../.\x` whose rest is not a tracked path; a tree-level entry whose rest holds an answer-key segment; for a folder targetDirectory, an entry with two leading `..` segments and an entry whose remainder does not start with the folder path; a glob pattern and a grep glob argument with `..` or a root inside a brace; an event of an unknown type; a run whose audit line cannot be written; a path that starts with `~`, `%`, `$` or `file:`; a stream with an init event and no tool call; a failed `git ls-tree`; a path in the forms `\\?\GLOBALROOT\...` and `\\?\Volume{GUID}\...`; a stream with no result event for a run with status ok; a replay run whose audit throws (reason `read-audit: audit-error`). Planted fixtures that pass: an empty path, a path relative to the tree, a read of a file named holdout.json inside the tree, a glob `files` entry of each exempt form (tree-level with a tracked rest, tree-level `PR.diff`, folder-level with a tracked rest). Two replay.test.mjs cases run the real replay code with a planted stream as the stub output, one on the cursor-review path (`.raw.json`) and one on the engine path (`.stream.jsonl.gz`): the run row has status failed and void true, and the scorecard over that runs file counts no row for the round. The summary mode on that runs file prints 1 void run and names its round; with a later ok row for the same round it names the round as replaced; with a run that has no audit line it exits 1. The planted and replay checks fail with the audit call removed. Run the tests by hand and save the output until `re-test-globs` lands. The canary has three results. The stream shows the outside read and the audit voids it: done. The stream shows no outside read and the answer does not hold the token: the artifact says that the agent did not read the file and that the stream form of an outside read stays unproven. The answer holds the token and the stream shows no outside read: not done, the seat decides. Artifact: `.claude/cache/e2e/<date>-re-answer-key-audit.json`.

Why: The tree excludes keep the answer key out of the tree and PR.diff. They do not stop a read by absolute path. Windows has no Cursor sandbox, and `--mode ask` is the only guard (cursor-review.mjs:36). A counted run that reads gold, a holdout file or the same-head CLI output is not a sample.

### re-live-advisory

**A1 build: sweep that runs today's engine as advice on open PRs and saves same-head CLI pairs** (wave 1, phase GATE, new)

Dave split the old lane on 2026-11-09 (DP1.18). This lane is the build lane. It is done when the first sweep PR lands and the first sweep is proven. The sweep weeks are the lane `re-live-accrual`.

- Depends on: re-critical-model-check, re-answer-key-audit
- Unblocks: re-live-accrual, re-label-two-family, re-shadow-retro, re-gate-summary-sample, re-demote-mechanism
- Related: re-critical-model-check, re-eval-contract, re-gate-shadow-run, re-engine-cli-schema, re-live-accrual
- Owns: `scripts/github/local-review-sweep.mjs` (new), `scripts/github/local-review-sweep.test.mjs` (new), `scripts/eval/review-eval/engine-version.mjs` (new), `scripts/eval/review-eval/engine-version.test.mjs` (new)
- Do not touch: `scripts/github/local-review.mjs`, `scripts/github/local-review/**`, `scripts/github/pre-pr.mjs`, `review-router.config.json`, `scripts/eval/review-eval/config.json`
- Cost: the proof runs of the first sweep, inside the live cap of 100 Cursor ledger starts per 7 days; 0 claude -p
- Needs Dave: no. DP1.2 is decided: the live cap of 100 is approved as our own number. DP1.5 is decided: path F. The frozen SHA is decided ("Open after DP1", point b): the `main` SHA right after `re-critical-model-check` lands. The coordinator records it before the first counted run. Recorded in `decisions.md`, "Open after DP1", point (b).
- Not a long lane. It closes after the first sweep. The daily runs, the weekly reports and the 2-week check are in `re-live-accrual`.

Scope (the script and the first sweep; `re-live-accrual` runs the script each day after that):
- The sweep lists open PRs (gh api, read-only) and calls the existing engine: `local-review.mjs --pr <n>` (local-review.mjs:842-859). No engine code changes.
- Earlier heads (T03). The open-PR head alone cannot give the CLI gate sample: of 15 branches with a CLI Major, 12 had the Major on a head that was not the last, and on 10 the last head had none. So for each saved CLI output that names a Major or Critical, the sweep runs the pinned engine on that head, from a detached worktree for that head. Rows that count set withholdBody, as eval runs do (engine-run.mjs:70). [Speculation: the sweep imports reviewHead from the pinned copy and gives it the saved head. Today's command line takes only `--pr` and reviews the current head (local-review.mjs:842-853), and withholdBody is an option of reviewHead with no flag (local-review.mjs:819). The done check must prove one run on an earlier head.]
- Daily runs (T03). Both gates need weeks of sweeps. They are not in this lane: `re-live-accrual` holds the daily runs and the pair count on the master card. The coordinator seat runs the daily sweep for the first 2 weeks (DP1.17, decided).
- Order: HIGH first, then a fixed share of MID and ELEVATED. Size the share from a saved count of pushes per band over the last 4 weeks (bandOf over merged PR files, read-only). Skip CRITICAL until `re-critical-model-check` is done.
- Cap: refuse a run when live starts in the last 7 days reach 100. Read local_review.weekly_live_cap when `re-engine-cli-schema` has added it.
- Facts: a run from the PR's own worktree passes `--facts` with that worktree's `.claude/cache/pre-pr/catchers.json` (pre-pr.mjs:146). A run from the primary checkout has no facts. The report counts both kinds.
- Pairs: copy the head's CLI output (`.claude/cache/e2e/<date>-pre-pr-cr-<shortsha>.txt`, pre-pr.mjs:95) to the same-head pairs folder. The worktree cache goes when the worktree is removed. So the copy must run each day, before a worktree is removed. From `re-prepr-cli-consumer` on, pre-pr writes the copy itself at write time (T03), and the sweep copy is only a backstop.
- engine-version.mjs: computes engineVersion and bandVersion over the freeze set at a SHA (see contracts).
- Labels: every row is "rehearsal, prompt v1" until the frozen SHA is recorded. Path F is decided (DP1.5), so rows with the frozen engineVersion lose the rehearsal label. DECIDED (Dave, 2026-11-10): the frozen SHA is the `main` SHA right after `re-critical-model-check` lands. The value is recorded in `decisions.md`, "Open after DP1", point (b). The done check reads it there.
- Path F: `--engine-sha <sha40>` extracts scripts/ and review-router.config.json at that SHA into `<records>/engine/<sha>/`, as pinEngine does (local-review.mjs:228-250), and runs that copy with LOCAL_REVIEW_PINNED set. checkPin accepts it (local-review.mjs:264-269). Re-extract when pruneEngines removed the copy (it keeps 3). Such a record shows trusted:false once fork/main moves; the gate counts by engineVersion. [Speculation: the copy runs unchanged from that folder; the done check proves it.]
- Pinned tag (T21). The sweep tags every record that a pinned copy wrote, so READY never reads it (`re-gate-ready-a`). The frozen copy cannot write a new record field, and local-review.mjs is in "Do not touch". So the sweep writes the tag itself: one line per pinned record in a list file in the pairs folder. [Speculation: the form of the tag. T21 gives source 'pinned' as an example. The test in `re-gate-ready-a` proves that READY skips a tagged record.]
- Read audit (`re-answer-key-audit`). After each run the sweep runs read-audit.mjs on the stream beside the record and writes the verdict line. A void run is not a counted row. The report counts the void runs.
- Report: the sweep script prints the report that `re-live-accrual` saves each week. Fields: runs per band, runs per PR p50 and p90, facts share, pairs saved, ledger load. Per risk band (T05): heads the CLI reviewed, heads with an engine record, and the share. The CLI-Major heads in the window, and the share of them with an engine record (T03).
- It does not replace `re-gate-shadow-run`. DP2 decides after 2 weeks of data from `re-live-accrual`.

Done when: The sweep PR is landed. One live sweep writes an engine record for an open HIGH or MID PR, with the CLI output copied beside it and the rehearsal label. Tests show the sweep refuses at the cap, skips CRITICAL while the model check is open, and gives one engineVersion for two runs on one SHA. One `--engine-sha` run writes a record whose engineVersion equals the frozen value. One run on an earlier head with a CLI Major writes a record with bodyMode withheld and a pinned tag. The first sweep record has a stream beside it and a pass line in the read-audit file. The sweep report prints the read-audit summary (void runs and their heads). A planted void stream gives a void line and no counted row. Artifact: `.claude/cache/e2e/<date>-re-live-advisory.json` (the first sweep report and the test output). The long check (2 weeks of pairs) moved to `re-live-accrual`.

Why: Finding 1. The engine already runs on any open PR. The same-head pairs exist at finding level nowhere else today.

### re-live-accrual

**A1 accrual: daily sweeps, weekly reports and the 2-week pair check** (wave 2, phase GATE, new)

Dave split `re-live-advisory` on 2026-11-09 (DP1.18). This lane is the long half. It writes no new script. It runs the sweep that `re-live-advisory` built.

- Depends on: re-live-advisory
- Unblocks: re-retire-prepr-cli, re-gate-shadow-run
- Related: re-live-advisory, re-prepr-cli-consumer, re-label-two-family, re-scoreboard
- Owns: `scripts/github/local-review-sweep.mjs` and `scripts/github/local-review-sweep.test.mjs` (second holder, for fixes that the daily runs show). [Speculation: the split tap names no Owns list. A lane with no file cannot fix a sweep fault, so this map gives it the sweep script after the build lane.]
- Writes: the weekly sweep reports, outside git (see "Done when").
- Do not touch: `scripts/eval/review-eval/engine-version.mjs` (it stays with `re-live-advisory`; a change to it goes through the coordinator), `scripts/github/local-review.mjs`, `scripts/github/local-review/**`, `scripts/github/pre-pr.mjs`, `review-router.config.json`, `scripts/eval/review-eval/config.json`
- Cost: up to 100 Cursor ledger starts per 7 days (live cap), for 2 weeks or more; 0 claude -p
- Needs Dave: his own yes for a scheduled task, when the daily sweep moves off the coordinator seat after the first 2 weeks (DP1.17, decided). DP1.2 is decided: the live cap of 100 is approved as our own number.
- Held until: no hold. The DP1.2 hold ended with Dave's answer of 2026-11-09.
- Long lane (T14, wait O1): it stays open for 2 weeks or more. During the 2 sweep weeks it is `blocked` with no owner (see "Long lanes" in "How to use this map").

Scope:
- Daily runs (T03). Run the sweep each day with the frozen engine copy (`--engine-sha`, path F) and the saved CLI heads. Owner of the daily sweep (DP1.17, Dave 2026-11-09): the coordinator seat (`re-program`) for the first 2 weeks. After that a scheduled task needs Dave's own yes. This lane owns no scheduler file; a scheduled task needs its own lane or an Owns change.
- The pair copy must run each day, before a worktree is removed (see `re-live-advisory`, "Pairs").
- Weekly report: save the sweep report each week. Fields are in `re-live-advisory`, "Report".
- Pool percent (T13, DP1.2): in the first sweep week the owner reads the percent of the weekly pool on the Cursor dashboard before and after the week. The report holds both reads. Both reads sit inside one pool week (see "Capacity plan / Cursor").
- Master card (T03): after each weekly report the owner writes the pair count on the `re-program` card. Counts only, no PR ids.
- Unmatched heads (T03): keep the CLI-Major heads with no engine record under 10% of the CLI-Major heads in the window.
- After the 2-week check. The CLI gate counts at least 4 weeks, so the sweeps go on after this lane is done. DP1.17 covers the first 2 weeks only. DECIDED (Dave, 2026-11-10): from week 3 the coordinator seat keeps the daily sweep until Dave approves a scheduled task. No new lane. So the seat runs the sweep in the counted weeks of `re-retire-prepr-cli`, and that lane edits no script. OPEN: the owner of a fix to the sweep script after this lane is done. The answer names no fix owner, and the seat does no build work under `re-program`.

Done when: The long check (T03): pairs are saved in each of 2 weeks in a row, and 90% or more of the CLI-Major heads in that window have an engine record. Two weekly reports exist. The first one holds the two pool percent reads. The `re-program` card shows the pair count of each week. Artifact: `.claude/cache/e2e/<date>-re-live-accrual.json` (the two weekly reports).

Why: DP1.18. The old lane stayed open for 2 weeks or more, and four lanes that need only the first sweep waited on it. Now only the two lanes that need the sweep weeks wait on this lane.

### re-land-ledger

**P3.6: land-outcomes ledger line in land-pr.ps1, claimed first** (wave 0, phase P3, changed)

- Depends on: none
- Unblocks: re-prepr-cli-consumer, re-gate-ready-b, re-retire-prepr-cli, re-l1-schedule, re-scoreboard
- Related: re-gate-ready-b, re-test-escapes
- Owns: `scripts/github/land-pr.ps1`, `scripts/github/land-pr-ledger.test.ps1` (new)
- Do not touch: `scripts/github/land-recheck.mjs`, `scripts/github/review-status.mjs`, `scripts/github/land-decision.mjs`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: merge tap (land-pr.ps1 is checkpoint.critical).
- Subagents (T22): Use Read, Grep and Edit on land-pr.ps1. Never name it in a shell command. The parent runs the test scripts. The decision-gate hook denies a subagent shell command that names land-pr.ps1, also a read-only one.

Scope: After a merge, append one JSON line to ~/.claude/state/land-outcomes.jsonl: pr, headSha, mergeSha, band, reviewers run, engine record path if any, CodeRabbit rounds. A ledger failure never fails the land. Drift since 11-05 (F4): land-pr.ps1 has five test scripts (e2e-copy, lock, recheck, red-check, worktree-links); -IgnoreReview never skips a red CI check (1a78c5ca); land-decision.mjs exists (5f27ec2d). Rebase on them.

Done when: The new ledger test passes. The five land-pr tests pass. One dry-run land in a temp repo writes one valid line. Artifact: `.claude/cache/e2e/<date>-re-land-ledger.txt`.

Why: Dave approved it 11-04. It is version-independent evidence and must start first (A2).

### re-test-globs

**A3: register the eval, local-review and lib test globs in pre-pr and CI** (wave 0, phase GATE, new)

- Depends on: none
- Unblocks: re-prepr-bundle
- Related: re-prepr-bundle, re-claude-backend, re-engine-seam
- Owns: `scripts/github/pre-pr.mjs` (SURFACES rows only), `scripts/github/pre-pr.test.mjs`, `.github/workflows/ccv3-checks.yml`, `scripts/github/lane-context-db-gate.mjs` (new), `scripts/github/lane-context-db-gate.test.mjs` (new)
- Do not touch: `scripts/ratchets/**`, `scripts/github/local-review.mjs`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: the merge tap (pre-pr.mjs is checkpoint.critical). DP1.4 is decided (Dave, 2026-11-09): the ccv3-checks.yml edit is allowed.

Scope:
- pre-pr.mjs:245: change `scripts/github/local-review/*.test.mjs` to `scripts/github/local-review/**/*.test.mjs`.
- Add an eval-scripts surface: globs `scripts/eval/review-eval/**`, gate `node --test scripts/eval/review-eval/*.test.mjs`.
- pre-pr.mjs:208: the lib-scripts gate names only resolve-deps.test.mjs. Change it to `scripts/lib/*.test.mjs`.
- ccv3-checks.yml:79 and :92: the same globs. Line :92 also runs `scripts/github/lib/env-step.test.mjs`: keep it.
- The N2 gate (seat, 2026-11-11). `lane-context-db.test.ts` runs in no gate today: it skips without `LANE_TEST_DB_URL`. Add one step to the CI job `coordination-db`. It makes a scratch database, sets `LANE_TEST_DB_URL`, runs `lane-context-db.test.ts` and fails when that test reports skipped. Add the same gate as a pre-pr surface for a diff that holds `lane-context.ts` or its db test.
- Keep the entries of the coordination test lists (`ccv3-checks.yml`, `COORDINATION_DB_TESTS` in pre-pr.mjs). No glob for the coordination database tests.
- No other pre-pr change than the rows above and the N2 surface. The bug items stay in `re-prepr-bundle`.

Done when: pre-pr tests pass. A temp `*.test.mjs` under `scripts/github/local-review/backends/` and one under `scripts/eval/review-eval/` are both picked up by gatesFor, and the CI step command runs both locally. The N2 step fails when `lane-context-db.test.ts` reports skipped: a mutant run or a dry run shows it. A list of the name, size and write time of each file in `~/.claude/state/review-engine/` shows no change across one gated run. Artifact: `.claude/cache/e2e/<date>-re-test-globs.txt`.

Why: Finding 2. It breaks the scanner-tuning deadlock. Later tests need no registration edit.

### re-test-escapes

**E1: fix-chain escape miner, weekly escape-cause report, early baseline, fixture-gap fact** (wave 0, phase TEST, new)

- Depends on: none
- Unblocks: re-szz-miner, re-property-tests, re-prepr-cli-consumer, re-retire-prepr-cli, re-l1-schedule
- Related: re-land-ledger, re-szz-miner, re-repromote-auto, re-p7-backlog
- Owns: `scripts/eval/review-eval/fix-chains.mjs` (new), `scripts/eval/review-eval/fix-chains.test.mjs` (new), `scripts/eval/review-eval/escape-causes.mjs` (new), `scripts/eval/review-eval/escape-causes.test.mjs` (new), `scripts/checks/fixture-gap.mjs` (new), `scripts/checks/fixture-gap.test.mjs` (new), `scripts/checks/catchers.mjs` (one call and one fact field), `scripts/checks/catchers.test.mjs`
- Do not touch: `scripts/eval/review-eval/escape.mjs` (read-only use), `scripts/github/pre-pr.mjs`, `scripts/checks/parser-fixtures/registry.mjs`, `scripts/eval/review-eval/gold/**`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: no

Scope:
- Source of escapes. escape.mjs starts from a CodeRabbit finding: it blames the finding's lines to an earlier PR (escape.mjs:1-3, 22-44). Once CodeRabbit is off, it has no input. So the tripwire needs a source that does not depend on CodeRabbit.
- fix-chains.mjs: for each new merged PR, read its commit subjects and changed lines. When it looks like a fix, git blame the changed lines to an earlier PR merged in the 30 days before it (the same gh api step as escape.mjs:44). Each match is one escape row. It is the CodeRabbit-free core that `re-szz-miner` reuses read-only.
- The escape rows file has one writer module: fix-chains.mjs. `re-prepr-cli-consumer` and `re-l1-schedule` call it; they never write the file another way.
- Weekly report: put each escape in one of the seven cause classes of `.claudedocs/2026-11-07-prepr-checks-effectiveness.md` (lines 36-42). Print the share a reviewer could fix. Print the count of fixes with no blame target (T19): a fix in a file that no earlier PR in the window changed gives no escape row, so the count shows how much the tripwire cannot see.
- Early per-band escape baseline from the pre-engine window, from fix-chains rows only (T14). Rows from escape.mjs (CodeRabbit-found escapes) are not in the baseline: that source has no input after a flip, so a baseline with it would not compare with the rows after the flip.
- fixture-gap: a catchers fact, never a gate. It fires when the diff changes a parser, guard or lexer file with no parser-fixtures registry entry. The file list lives in fixture-gap.mjs.
- No coverage gate.

Done when: fix-chains on the PR range of the source doc finds the defect chains of that doc, and names any difference from its 6 (the doc marks the number as not re-run, line 53). The range is pinned (T14): the 40 PRs merged last before the doc's date, 2026-11-07, not "the last 40 merged PRs" on the day the lane runs. Main gets about 30 merges a day (211 from 11-02 to 11-09), so the last 40 PRs of a later day miss the doc's window. The lane records the first and last PR number of the range in its artifact. [Speculation: the doc does not print the two numbers; the lane finds them from the commits the doc cites.] The report lists those escapes per cause and prints the count of fixes with no blame target. A planted fix commit in a temp repo yields one escape row. A planted fix in a file that the guilty PR did not change is tested (T19): the test shows what fix-chains writes for it (no row, or a row for the wrong PR) and that the no-target count rises. The baseline file has one row per band, built from fix-chains rows only. catchers on a fixture diff that changes a registered parser shows no gap fact; on an unregistered guard it shows one. Artifact: `.claude/cache/e2e/<date>-re-test-escapes.txt`.

Why: Finding 21. Most escapes came from gates that did not run, not from review misses. The escape rows also feed the re-promotion triggers.

### re-property-tests

**E3: fast-check properties, first on the decision-gate table** (wave 1, phase TEST, new, deferred)

- Depends on: re-test-escapes
- Unblocks: none
- Related: re-test-escapes, re-p7-backlog
- Owns: `.claude/hooks/src/__tests__/decision-gate.property.test.ts` (new), `.claude/hooks/package.json` (devDependency line only)
- Do not touch: `.claude/hooks/src/decision-gate.ts`, `.claude/hooks/dist/**`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: the fast-check install yes (package-install-guard).

Scope: After the install yes, add fast-check properties for the decision-gate table. No coverage gate. No TREX revival.

Done when: The property test runs in vitest, and it fails on a planted wrong row in a copy of the table. Artifact: `.claude/cache/e2e/<date>-re-property-tests.txt`.

Why: Escape cause: thin guard tables (eval E3).

### re-verifier

**P4.2: refute-only verifier local-review/verify.mjs, with a policy tag** (wave 0, phase P4, changed)

- Depends on: none
- Unblocks: re-verifier-replay, re-cr-rule2, re-p4-wire, re-refs-impact
- Related: re-verifier-replay, re-p4-wire, re-cr-rule2
- Owns: `scripts/github/local-review/verify.mjs` (new), `scripts/github/local-review/verify.test.mjs` (new), `scripts/checks/parser-fixtures/registry.mjs`
- Do not touch: `scripts/github/local-review.mjs`, `scripts/github/review-filter.mjs`, `scripts/checks/parser-fixtures/inputs.mjs`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: no (the mark is removed: the backend is injected; the live choice is DP2.2).

Scope: One fresh call per Major or Critical candidate through an injected backend. Verdict CONFIRMED, REFUTED (needs path:line) or UNCERTAIN; only REFUTED drops. Unparseable output keeps everything. It sits after review-filter. Add a parser-fixtures registry entry for its verdict parser. New (D2): the caller may pass the last commit subjects for the cited file, because the review tree has no .git. A finding that cites a documented deliberate choice returns UNCERTAIN with a "policy" tag, never REFUTED. Precision can then be reported with and without policy rows.

Done when: Tests cover: REFUTED without path:line kept; unparseable keeps all; UNCERTAIN kept and flagged; a deliberate-choice fixture returns UNCERTAIN with the policy tag; the parser-fixtures run on the new entry passes. Artifact: `.claude/cache/e2e/<date>-re-verifier.txt`.

Why: Finding 19: the refute step is where the P1 misses went. The TREX audit split 3 real and 3 intended policy findings.

### re-engine-seam

**P4 prefactor PR A: move the cursor-agent call into backends/cursor.mjs** (wave 0, phase P4, changed)

- Depends on: none
- Unblocks: re-engine-cli-schema, re-verifier-replay, re-gate-ready-a, re-p4-wire
- Related: engine-trusted-findings, re-claude-backend, re-engine-cli-schema
- Owns: `scripts/github/local-review.mjs`, `scripts/github/local-review.test.mjs`, `scripts/github/local-review/backends/cursor.mjs` (new), `scripts/github/local-review/backends/cursor.test.mjs` (new)
- Do not touch: `scripts/github/cursor-review.mjs`, `scripts/github/review-router.mjs`, `scripts/github/pre-pr.mjs`, `scripts/github/local-review/prompt.mjs`, `scripts/github/local-review/record.mjs`
- Cost: 0 cursor (stub backend), 0 claude -p
- Needs Dave: merge tap (trust boundary).

Scope: PR A of the 11-05 lane only. Move the cursor-agent call out of runOnce into backends/cursor.mjs behind the backend contract. Make stepRun a stage list: run, settle/filter, [verify], build record. Add backends/cursor.mjs to ENGINE_FILES in the same PR. Output byte-identical. PR B is now `re-engine-cli-schema`.

Split choice: two lanes, not one lane with two PRs. PR A alone unblocks `re-verifier-replay` (it needs a backend), and the board then shows which CRITICAL PR is open.

Done when: local-review tests pass with the default path byte-identical (same prompt sha, same model, same record fields). A new test shows computeTrust fails when backends/cursor.mjs differs from fork/main. backends/cursor.test.mjs passes under the `re-test-globs` glob, or by hand with the output saved if that lane is not done. Artifact: `.claude/cache/e2e/<date>-re-engine-seam.txt`.

Why: Four phases edit local-review.mjs. The ENGINE_FILES entry closes the trust gap the move opens.

### re-eval-contract

**P3: eval contract with a per-phase budget proven on the real ledger** (wave 1, phase P3, changed)

- Depends on: re-gold-schema
- Unblocks: re-score-paired, re-verifier-replay, re-shadow-retro, re-gold-assemble, re-owners-hotspots, re-p4-harness, re-scoreboard, re-holdout-rotate
- Related: re-gold-schema, re-score-paired, re-live-advisory
- Owns: `scripts/eval/review-eval/dataset.mjs`, `scripts/eval/review-eval/dataset.test.mjs`, `scripts/eval/review-eval/config.json`, `scripts/eval/review-eval/config.mjs`, `scripts/eval/review-eval/budget.mjs`, `scripts/eval/review-eval/budget.test.mjs`, `scripts/eval/review-eval/freeze.mjs`, `scripts/eval/review-eval/freeze.test.mjs`, `scripts/eval/review-eval/cli.mjs`, `scripts/eval/review-eval/cli.test.mjs`
- Do not touch: `scripts/eval/review-eval/score.mjs`, `scripts/eval/review-eval/replay.mjs`, `scripts/eval/review-eval/shadow.mjs`, `scripts/github/local-review.mjs`, `scripts/eval/review-eval/gold/**`, `scripts/eval/review-eval/gold.mjs`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: no

Scope (11-05 content, restated):
- Additive only. Keep the signatures of checkEngineFreeze, checkFreeze, recordEngineFreeze and budgetFromFile. Keep engineFreeze.promptSha256.full readable.
- Put versioned freeze entries under a new key keyed by promptVersion. contextVersion joins in `re-p4-harness`.
- dataset.mjs merges gold rows (through gold.mjs) with the CodeRabbit dataset.
- Split of a gold row (seat, 2026-11-11). For a row on one of our own pull requests (source 'A' or 'CR'), config.json wins, and dataset.mjs prints the count of rows whose split differs. For a range row (Gold B) and an external row (Gold C), the split of the row is the only source. Readers key on repo plus pr.
- config.json gets the suites split, a reserve list for the next holdout, and judge models per reviewer family. A judge never shares the reviewer family.
- splitSets reads cfg.reserve and returns a reserve set. A reserve PR is in neither dev nor holdout. cli.mjs tags it reserve.
- Add a holdout-spend ledger: each holdout scoring of a frozen arm writes one line.
- cli.mjs: the freeze and score subcommands read the new keys with a fallback to the old ones.

Changes:
- New edge on `re-gold-schema` (D3): dataset.mjs merges gold rows through gold.mjs. This moves the lane from wave 0 to wave 1, against the F1 rank.
- C1: the budget report on the real ledger prints per-phase scopes; the 75 untagged review-eval starts count as P1; P4 shows 120 free.
- C2: a test shows that live runs at the cap of 100 leave the eval headroom under 240.
- Shadow runs stay kind shadow, outside the eval budget.
- T04: the budget report prints the computed phase 4 need beside "P4 120 free". The need is (controls + holdout PRs + dev PRs + gold targets) x arms x runs / 0.81 (see "Capacity plan"). The inputs are counts from config.json, never PR ids. When the need passes 120, the lane computes and writes the reduced design.
- DP1.6 and DP1.16 (Dave, 2026-11-09): Grok-only first (2 arms), and the design is cut to fit the P4 scope of 120 with interleaved arms. No scope raise. The lane computes the cut from the formula: the counts of controls, holdout PRs, dev PRs and gold targets that fit, for 2 arms, beside the up to 20 starts of `re-verifier-replay` and the about 32 of `re-p4-winner-evidence` (DECIDED, Dave, 2026-11-10; before: about 16). DECIDED (Dave, 2026-11-10): the cut has 15 or more controls, and bar row 8 of `re-retire-critical` asks for that count (see "Capacity plan"). Proposal, not decided: a stratified gold sample.
- E02: the reserve list names the answer-key source of each reserve PR. A reserve PR with no PR-bot review has no CodeRabbit answer key. The lane records the source for each one (a PR-bot review, a pre-pr CLI output or a gold row) and prints the count of reserve PRs with no source. Counts only.

Done when: `node --test scripts/eval/review-eval/*.test.mjs` passes with 220 or more passes. The budget report on the real ledger prints P1 75 used and P4 120 free, and beside it the computed phase 4 need with its inputs (T04). When the need passes 120, the report also prints the reduced design for 2 arms. The sum of its `re-p4-ab` need, up to 20 starts for `re-verifier-replay` and about 32 for `re-p4-winner-evidence` is 120 or less (DP1.16; about 32 is DECIDED, Dave, 2026-11-10). The report prints the answer-key source count of the reserve list (E02). The live-cap test passes. The v1 freeze check still passes. A dataset.test.mjs case shows a reserve PR is in neither dev nor holdout. Artifact: `.claude/cache/e2e/<date>-re-eval-contract.txt`.

Why: Finding 11: the eval budget is one all-time total today (budget.mjs:30-38), and P4 alone plans about 60 runs.

### re-engine-cli-schema

**P4 prefactor PR B: --prompt-version, --model, --backend, --range, one RECORD_SCHEMA bump, live cap key** (wave 1, phase P4, new)

- Depends on: re-engine-seam
- Unblocks: re-gate-ready-a, re-cr-rule2, re-rubric-runners, re-p4-wire, re-gate-shadow-run, re-delta-wire
- Related: engine-trusted-findings, re-live-advisory, re-seed-gold-b
- Owns: `scripts/github/local-review.mjs`, `scripts/github/local-review.test.mjs`, `scripts/github/local-review/record.mjs`, `scripts/github/local-review/record.test.mjs`
- Do not touch: `scripts/github/cursor-review.mjs`, `scripts/github/review-router.mjs`, `scripts/github/pre-pr.mjs`, `scripts/github/local-review/prompt.mjs`, `review-router.config.json`
- Cost: 0 cursor (stub backend), 0 claude -p
- Needs Dave: merge tap (trust boundary).

Scope: PR B of the 11-05 `re-engine-seam` lane, unchanged in content:
- --prompt-version, --model, --backend and a --range base..head target. The default prompt version comes from prompt.mjs.
- The model allowlist in code: Cursor MODEL_ALLOWLIST only, no -fast, no auto. Claude never haiku.
- One RECORD_SCHEMA bump with every field of the Record schema contract ("Shared contracts").
- ADOPT the engine-trusted-findings items in local-review.mjs and record.mjs.
New: add local_review.weekly_live_cap to KINDS and LOCAL_REVIEW_DEFAULTS (default 100). loadConfig does not refuse an unknown key, so the default must be in LOCAL_REVIEW_DEFAULTS.

Done when: A --range run on a seed ref writes a record offline with a stub backend. Tests reject a -fast model, auto and haiku. A test shows a config with no weekly_live_cap reads 100. Artifact: `.claude/cache/e2e/<date>-re-engine-cli-schema.txt`.

Why: Gold B needs a no-PR target. The record schema feeds READY, rule 2 and the runners. One cap key ends the three cap numbers in the old proposals.

### re-cr-keys

**Config keys for the gate and the flips, default off** (wave 1, phase DEMOTE, new)

- Depends on: force-high-security-tier
- Unblocks: re-prepr-cli-consumer, re-cr-rule2, re-retire-prepr-cli, re-cr-trustlist
- Related: re-cr-rule2, re-retire-prepr-cli, re-retire-critical
- Owns: `review-router.config.json`, `scripts/github/review-router-config-keys.test.mjs` (new), `scripts/github/review-router-flip.test.mjs` (new)
- Do not touch: `scripts/github/review-router.mjs`, `scripts/github/pr-checkpoint.mjs`, `scripts/github/pre-pr.mjs`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: merge tap (config is in ENGINE_FILES).
- DP1.15 is decided (Dave, 2026-11-09, T05): coderabbit.demoted.prepr_cli is a list of risk bands. Its off value is the empty list. The hold is gone.

Scope: Add the keys listed in the contracts section, each at its off value, with a description line in the config's notes. No consumer change. Rebase on force-high-security-tier, which edits the same file. Add the flip test (refuter on escape-tripwire, part c): given a base and a head config, it passes only when the diff changes coderabbit.* keys and no gate list. Both gate lanes run it on their flip PR.

Done when: The new test reads every key at its default, and coderabbit.demoted.prepr_cli reads as an empty list. The flip test passes on a fixture that changes only coderabbit.demoted.prepr_cli (an empty list to a list of bands), and fails on one that also changes checkpoint.critical. Router and checkpoint output on the existing fixtures is byte-identical before and after. Artifact: `.claude/cache/e2e/<date>-re-cr-keys.txt`.

Why: One early owner for the keys, without the rule-2 dependencies that `re-cr-rule2` carries. This keeps `re-cr-rule2` and `re-verifier` out of the CLI gate closure, and the CLI gate off the P4 A/B path.

### re-label-two-family

**B9 and B1: real, non-seeded labels from two model families** (wave 2, phase P6, new)

- Depends on: re-live-advisory, re-dispositions
- Unblocks: re-retire-prepr-cli, re-judge-calibrate
- Related: re-judge-calibrate, re-dispositions, re-test-escapes, re-eval-contract, re-retire-prepr-cli
- Owns: `scripts/eval/review-eval/label-two-family.mjs` (new), `scripts/eval/review-eval/label-two-family.test.mjs` (new), `scripts/eval/review-eval/cli-gate.mjs` (new), `scripts/eval/review-eval/cli-gate.test.mjs` (new)
- Do not touch: `scripts/eval/review-eval/judge.mjs`, `scripts/eval/review-eval/labels.mjs`, `scripts/eval/review-eval/gold/**`, `scripts/github/pre-pr.mjs`, `scripts/eval/review-eval/match.mjs`
- Cost: up to 40 Cursor runs under the lane's own ledger session id, not under the P6 eval scope (see "Budget" below): Grok 4.7 for CLI-only findings, a second family that is not Grok for engine findings [Speculation: Composer 2.5]; claude -p 4 a day (sonnet). DECIDED (Dave, 2026-11-10): one Cursor run labels a batch of up to 10 findings of one family. The lane stops at 20 runs. The other 20 stay for the gate's label runs in `re-retire-prepr-cli`. No cap goes up.
- Needs Dave: no. DP1.2 is decided (Dave, 2026-11-09): up to 40 Cursor runs.

Scope: Take real findings from the same-head pairs (engine-only, CLI-only, both) and from dispositions. Each finding gets a real-or-not label from two model families, each blind to the other and to the source. Store them as model labels with judgeVersion in this lane's own label file. Report n, agreement and Cohen's kappa. It never writes escape rows. Dev-split PRs only; never holdout or reserve PRs.

Changes from the premortem:
- Families (E04). The engine runs on Grok 4.7, and a judge never shares the reviewer family. So a finding that the engine produced (engine-only or both) gets its labels from sonnet and from a second family that is not Grok. [Speculation: Composer 2.5 through Cursor, the only other model the Cursor rule allows.] A CLI-only finding gets its labels from sonnet and Grok 4.7.
- Tie rule (E04). A CodeRabbit-only Major counts as real unless both families say noise. The rule leans against the engine.
- cli-gate.mjs (T06). No other lane in the CLI gate closure computes bar rows 1 and 3, and the gate lane may not write scripts. cli-gate.mjs does these steps:
  - It parses the pair files of the counted PRs. It reads the CLI output with parseAgentStream (pre-pr.mjs:897) and matches findings with matchFindings (match.mjs:28). It imports both and changes neither.
  - It sends every CLI-only Major of the counted PRs to the two-family labels.
  - It prints rows 1 to 4 of the `re-retire-prepr-cli` bar, with the source file of each number and the counts per risk band.
  - It prints row 3 as NOTE when no link writer ran, and when a counted PR is younger than 30 days. DECIDED (Dave, 2026-11-10): the counted set closes on a stated end date, and row 3 is scored 30 days after the last merge in that set. Until then row 3 is NOTE. See evidence-bar.md, "Counted weeks". cli-gate.mjs follows that rule.
  - It counts a pair only when two facts hold (`re-answer-key-audit`). The engine record of the run of that head has status ok (for a replay run: the replay row). The newest read-audit line of that run is pass. Reason: an incomplete run with a cut stream can hold a pass line. A run with no line does not count. read-audit.mjs also audits the lane's own Cursor label runs.
- Budget (paper tiger measure-10). This lane has no edge to `re-eval-contract`, so the P6 scope tag may not exist when it runs. Its Cursor runs start under their own ledger session id, not under `review-eval`. They then do not count as untagged P1 starts. The lane enforces its stop at 20 runs, inside the cap of 40, from the ledger rows of that session id (DECIDED, Dave, 2026-11-10). No edge is added: an edge would put `re-eval-contract` in the CLI gate closure. (`re-gold-schema` is in the closure already under route J.) [Speculation: the name of the session id, for example `review-label`.]
- After this lane is done, `re-retire-prepr-cli` runs cli-gate.mjs on the PRs that are counted later. It runs the script and edits no script. Those label runs use the 20 runs that stay for the gate (DECIDED, Dave, 2026-11-10).
- Read-audit follow-ups (Dave, 2026-11-11). Before a claim of this lane, the card `read-audit-followups` is done: cli-gate.mjs reads the read-audit state line.

Done when: 60 or more findings have two labels each (T06; B9 option (a) needs 60). The lane can start after the first sweep (`re-live-advisory`). The 60 findings may need pairs from later sweep days (`re-live-accrual`); no edge is added for that. Every CLI-only Major of the PRs counted up to that day has two labels. The report prints n, agreement and kappa, for all findings and for the engine findings alone. cli-gate.mjs prints rows 1 to 4 on the real pair files, with a source file for each number. Tests show: a holdout or reserve PR is refused; row 3 is NOTE with no link writer; the tie rule counts a split label as real; an engine finding never gets a Grok label. Artifact: `.claude/cache/e2e/<date>-re-label-two-family.json`.

Why: Finding 10: judge agreement is n=0 on real findings. Route J of the CLI gate (decided, DP1.8) uses this set as the real slice of the calibration.

### re-prepr-bundle

**GATE prep: pre-pr bug bundle, rebased** (wave 1, phase GATE, changed)

- Depends on: re-test-globs
- Unblocks: re-prepr-cli-consumer
- Related: scanner-tuning, engine-trusted-findings, re-prepr-cli-consumer
- Owns: `scripts/github/pre-pr.mjs`, `scripts/github/pre-pr.test.mjs`
- Do not touch: `scripts/ratchets/**`, `scripts/github/local-review.mjs`, `.github/workflows/ccv3-checks.yml`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: merge tap (pre-pr.mjs is checkpoint.critical).

Scope: The scanner-tuning edge is gone; scanner-tuning keeps zizmor and opengrep only (A3). Rebase on the 18 pre-pr.mjs commits since 11-05. Check which items of the four adopted lanes (Board actions 12) already landed (the no-files skip landed 11-06, 43461fe0), and fix the rest. Fix the engine-trusted-findings pre-pr.mjs item. Glob registration moved to `re-test-globs`. Drift note (F4): autoConfirm is "low" since 11-06; reviews_7d_manual is a fallback only; matrix.control_plane already lists prompt.mjs and context.mjs.

Done when: pre-pr tests pass. Each adopted item is listed as fixed here, fixed before (with its commit) or dropped (with the reason). Artifact: `.claude/cache/e2e/<date>-re-prepr-bundle.txt`.

Why: Finding 2 deadlock removed. Five lanes still scope pre-pr.mjs, so one rebased PR first.

### re-szz-miner

**P3.1/3.4: Gold A SZZ miner, clean controls, escape baseline to gold** (wave 1, phase P3, changed)

- Depends on: re-critical-model-check, re-gold-schema, re-test-escapes
- Unblocks: re-gold-assemble
- Related: re-gold-assemble, re-test-escapes, brief-bare-wait-dave, scoped-cleanup-gitdir-redirect
- Owns: `scripts/eval/review-eval/mine-szz.mjs` (new), `scripts/eval/review-eval/mine-szz.test.mjs` (new), `scripts/eval/review-eval/gold/gold-a.json` (new), `scripts/eval/review-eval/gold/clean-controls.json` (new), `scripts/eval/review-eval/gold/escape-baseline.json` (new)
- Do not touch: `scripts/eval/review-eval/escape.mjs`, `scripts/eval/review-eval/catchers-eval.mjs`
- Cost: 0 cursor; claude -p up to 6 a day for labels
- Needs Dave: no

Scope:
- Mine fix commits since 2026-08-01 into blame-target pairs. Use fix-chains.mjs (`re-test-escapes`) and escape.mjs read-only.
- Drop a pair when a CodeRabbit comment came before the fix.
- A cross-file case with no blame target goes to an unmapped bucket and is not counted.
- An agent writes the defect-vs-style label, stored as a model label.
- Record the open real bug held on the board (`brief-bare-wait-dave`) as gold before its fix lane runs (DP1.9). DECIDED (Dave, 2026-11-10): that card is `blocked` with a note, and this lane releases it after gold-a.json records the bug. The other candidate, `scoped-cleanup-gitdir-redirect`, landed on 2026-11-08, before the DP1.9 answer. Not proven: whether the miner can still record that pair from its fix commit.
- Clean controls: the 11 clean PRs, plus PRs merged before about 2026-10-06 with no fix commit within 30 days. At least 30 in total.
- New: build gold/escape-baseline.json from the `re-test-escapes` baseline file, same pre-engine window, one row per band.
- New: report the yield of real Majors per class, for DP3.7 (real-Major floor, B6).

Done when: gold-a.json has 15 or more counted pairs with provenance and a split field. clean-controls.json has 30 or more PRs. escape-baseline.json has one row per band, equal to the state file rows. The yield table is in the artifact. The lane releases the `brief-bare-wait-dave` hold (state `backlog`) after gold-a.json records the bug (DECIDED, Dave, 2026-11-10). mine-szz.mjs passes cli-smoke (--help and no args, temp HOME). Artifact: `.claude/cache/e2e/<date>-re-szz-miner.txt`.

Why: One escape baseline for both gates and shadow decide.

### re-score-paired

**P3/P4: paired bar, CodeRabbit-independent rows, reliability, holdout.json writer** (wave 2, phase P3, changed)

- Depends on: re-gold-schema, re-eval-contract
- Unblocks: re-p4-harness, re-demote-mechanism, re-scoreboard, re-retire-critical
- Related: re-eval-contract, re-p4-ab, re-p4-winner-evidence
- Owns: `scripts/eval/review-eval/score.mjs`, `scripts/eval/review-eval/score.test.mjs`, `scripts/eval/review-eval/bootstrap.mjs` (new), `scripts/eval/review-eval/bootstrap.test.mjs` (new), `scripts/eval/review-eval/holdout-record.mjs` (new), `scripts/eval/review-eval/holdout-record.test.mjs` (new)
- Do not touch: `scripts/eval/review-eval/config.json`, `scripts/eval/review-eval/dataset.mjs`, `scripts/eval/review-eval/cli.mjs`, `scripts/eval/review-eval/shadow.mjs`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: no

Scope (11-05 content, restated):
- Paired bar: lower bound above -5 pts on regression and above 0 on capability, from a cluster bootstrap over PRs, with 2 runs per side.
- An arm or cell key (promptVersion x model x backend). Rows per suite and per gold source.
- Counts, not percents, while Majors stay under 20.
- Reliability per arm: run-failure rate, repaired-JSON rate, p95 wall time, findings variance (pass: no worse than baseline + 2 pts).
- Read gold fields through gold.mjs. The scorecard check calls scorecard() directly, not cli.mjs.

New:
- Folded `re-holdout-record`: write ~/.claude/state/local-review/eval/holdout.json {engineVersion, majors, found, recall, pairedBar} only when the holdout-spend ledger line exists.
- B6: a row for engine same-issue recall on Gold A real Majors, with its CI. Gold A and Gold B rows apart. No CodeRabbit score on Gold A.
- Clean bar as false Majors per clean PR with a CI.
- Paired bar: compute and print it, but mark it NOTE while its OPEN item is open. Print the n it needs at the observed d.

Done when: Score tests cover: CI bounds from the cluster bootstrap; a lost caught Major is flagged; a rise in clean false Majors is flagged; a reliability drop over 2 pts is flagged. Four new tests too. A scorecard with no ledger line writes no holdout.json. A valid one writes one row keyed by engineVersion. The Gold A recall row prints a CI. The paired-bar row prints the needed n. The scorecard on the P1 runs reproduces 10/20 same-issue recall. Artifact: `.claude/cache/e2e/<date>-re-score-paired.json`.

Why: Every keep-or-kill call uses this bar. Findings 7 and 8.

### re-verifier-replay

**D2: verifier false-refute replay on dev-split real Majors, before re-p4-wire** (wave 2, phase P4, new)

- Depends on: re-verifier, re-engine-seam, re-eval-contract, re-answer-key-audit
- Unblocks: re-p4-wire
- Related: re-verifier, re-p4-ab, re-claude-backend, re-seed-gold-b
- Owns: `scripts/eval/review-eval/verify-replay.mjs` (new), `scripts/eval/review-eval/verify-replay.test.mjs` (new)
- Do not touch: `scripts/github/local-review/verify.mjs`, `scripts/github/local-review.mjs`, `scripts/eval/review-eval/config.json`
- Cost: up to 20 Cursor runs (P4 scope) on backends/cursor.mjs, or up to 4 claude -p a day when `re-claude-backend` is done and chosen
- Needs Dave: no. DP1.2 is decided (Dave, 2026-11-09): up to 20 Cursor runs.

Scope: Feed verify.mjs the CodeRabbit finding text of the dev-split real Majors as candidates (no engine run), through the first backend that is done. Re-run on Gold B when it exists. Never holdout or reserve PRs. Report counts: refuted, uncertain, policy-tagged, confirmed. Each verify run keeps its raw stream, and read-audit.mjs audits it; a void run is a failed run (`re-answer-key-audit`). Unproven: the Backend contract returns no raw stream today. If this lane cannot save one, its verify runs do not count and the lane says so in its report.

On a refute (T14): when the replay refutes one or more real Majors, the lane does three things. It reports each refuted one. It reopens `re-verifier`: the coordinator sets that lane back to work with a note that names the report. It raises DP2.9, which decides the next step. `re-p4-wire` stays blocked, because this lane is not done. After the verifier fix lands, the replay runs again inside the same cap.

Done when: The replay report shows 0 real Majors refuted. If it shows one or more, the lane is not done: it follows the refute steps above and runs again after the fix. If DP2.9 is "drop", the lane closes with the refute report. The coordinator then removes the `re-verifier-replay` edge from `re-p4-wire` and the verify stage from its scope. A test shows a holdout or reserve PR is refused. Artifact: `.claude/cache/e2e/<date>-re-verifier-replay.json`.

Why: Finding 19. The verifier gets a false-refute check before it joins the engine.

### re-prepr-cli-consumer

**B8: pre-pr reads the band list coderabbit.demoted.prepr_cli and band-state; band-state writer for the CLI band** (wave 2, phase DEMOTE, new)

- Depends on: re-prepr-bundle, re-cr-keys, re-land-ledger, re-test-escapes
- Unblocks: re-retire-prepr-cli, re-gate-shadow-run, re-repromote-auto, re-rule-docs
- Related: re-retire-prepr-cli, re-repromote-auto, re-test-escapes
- Owns: `scripts/github/pre-pr.mjs`, `scripts/github/pre-pr.test.mjs`, `scripts/eval/review-eval/band-state.mjs` (new), `scripts/eval/review-eval/band-state.test.mjs` (new)
- Do not touch: `scripts/github/pr-checkpoint.mjs`, `review-router.config.json`, `scripts/eval/review-eval/escape.mjs`
- Cost: 0 cursor; claude -p up to 2 a day for escape severity labels
- Needs Dave: merge tap (pre-pr.mjs is checkpoint.critical).
- DP1.15 is decided (Dave, 2026-11-09, T05): a band list. The hold is gone.

Scope:
- Band list (DP1.15, decided). coderabbit.demoted.prepr_cli is a list of risk bands (code fallback: the empty list). pre-pr skips the CLI for a head only when three things hold: the risk band of the head is in the list, the per-head rule passes, and band-state does not re-promote the CLI band. Then the coderabbit step SKIPs with reason "demoted" and prints why. LOW may not be in the list while LOW is outside local_review.bands: pre-pr ignores LOW in the list and prints why.
- Per-head rule (T05; Dave's DP1.15 answer: skip the CLI only when an engine record exists for the head). The key alone never skips the CLI. pre-pr skips the CLI for a head only when a qualifying engine record exists for that head: a record with the counted engineVersion, or a record of a later version that a done check proves equal on the default path (DECIDED, Dave, 2026-11-10). With no qualifying record the CLI runs, so a head never goes with no AI review. The counted engineVersion is the one the gate froze (engine-version.mjs, `re-live-advisory`). DECIDED (Dave, 2026-11-10): a record of a later version also allows the skip, when a done check proves that version equal on the default path (same prompt sha and model). See the next bullet.
- Limit of the per-head rule under path F (DP1.5, decided). `re-engine-seam` and `re-engine-cli-schema` change local-review.mjs, which is in the reviewer set. Under route J both lanes are in the CLI gate closure, so both land before the flip. After they land, a live record carries a different engineVersion. Only a record from the pinned copy carries the counted one. Under the rule of 2026-11-09 the skip, and bar row 7, applied only to heads that the pinned copy reviewed. The sweep reviews a head after the push, so at the first pre-pr run of a head no pinned-copy record exists. DECIDED (Dave, 2026-11-10): pre-pr skips the CodeRabbit CLI when an engine record exists from the pinned copy, or from a later version that a done check proves equal on the default path (same prompt sha and model). The phase 4 winner needs its own window. So a live record of a proved version allows the skip, and a record of a version with no proof does not. The done check of `re-engine-seam` proves the default path byte-identical, with the same prompt sha and the same record fields. It does not name the model. The done check of `re-engine-cli-schema` does not state the proof yet. [Speculation: pre-pr reads a list of the proved engineVersion values; the lane picks the form.]
- LOW rule (T05). LOW is outside local_review.bands (review-router.config.json:200), and local-review.mjs:526 skips a band outside that list. So the engine never writes a record for a LOW head, and the CLI is never skipped for LOW while that stays true. A test row proves it.
- Pair copy (T03). pre-pr copies the CLI output of the head to ~/.claude/state/local-review/cli-pairs/<pr>/<sha>.txt at the time it writes the output file. The pair then does not depend on the worktree cache. [Speculation: the first pre-pr run comes before the PR exists, so the copy needs a key for a head with no PR number; the lane picks it and `re-live-advisory` reads it.]
- The band-state refresh runs from pre-pr at most once per Chicago day. It calls fix-chains.mjs over merges since the last refresh, so new escape rows exist with no session.
- Severity: for each new escape blamed to a PR merged in a demoted window, the refresh asks sonnet for a severity label. One call labels the whole batch of that day (T19), at most 2 calls a day. Fail closed: an escape with no label after 2 days counts as Critical only when its fix touches a security-tier file (T19).
- band-state.mjs applies the CLI-band triggers (see Evidence bar), with trigger 4 (2 Major escapes in 4 weeks), and writes band-state.json. [Speculation: with a band list, a trigger can re-promote one risk band or the whole list. The triggers already use a per-band baseline. The lane picks one form and tests it.]
- Known gap: with no PR activity, no refresh runs. Then no CLI run is due either.

Done when: Tests cover: an empty list runs the CLI; a head whose band is in the list, with an engine record of the counted engineVersion, skips it; a head whose band is in the list, with no engine record, runs it; a head in a listed band with a record of a later version that is proved equal on the default path (same prompt sha and model) skips it, and one with a record of a later version with no such proof runs it (DECIDED, Dave, 2026-11-10); a head whose band is not in the list runs it, also with a record; a LOW head runs it, also with LOW in the list; a listed band plus a re-promoted band-state runs it; each of the four triggers writes band-state; an unlabelled escape older than 2 days on a security-tier file triggers, and one on another file does not; a missing band-state file means no change; a pre-pr run writes the pair copy. Trigger replay (T19): the lane replays the triggers over the last 4 weeks of fix-chains rows, saves how often each one fires, and sizes the label cap from that result. End-to-end in a temp repo and temp HOME: the band of the head in the list and an engine record fixture for the head, pre-pr prints the "demoted" SKIP line; then plant a fix commit that blames a demoted-window PR; the next pre-pr run refreshes, writes band-state and starts the CLI step again. Artifact: `.claude/cache/e2e/<date>-re-prepr-cli-consumer.txt`.

Why: Finding 17: a demoted CLI band had no automatic way back.

### re-shadow-retro

**P3a: shadow retro on the engine path, 10 runs now as a pipeline proof** (wave 2, phase P3, changed)

- Depends on: re-eval-contract, re-live-advisory, re-dispositions
- Unblocks: re-demote-mechanism, re-l1-schedule, re-p4-winner-evidence
- Related: re-p4-winner-evidence, re-demote-mechanism, re-judge-calibrate
- Owns: `scripts/eval/review-eval/shadow.mjs`, `scripts/eval/review-eval/shadow.test.mjs`
- Do not touch: `scripts/eval/review-eval/config.json`, `scripts/github/local-review.mjs`
- Cost: 10 Cursor runs (shadow scope, 6 a day); holds the Cursor eval slot and a Grok slot while it runs
- Needs Dave: no. DP1.2 is decided (Dave, 2026-11-09): 10 runs now, 30 later on the frozen version.

Scope:
- In defaultShadowEngine, switch the reviewer from cursor-review to the engine. Only shadow.mjs changes.
- engineVersion comes from engine-version.mjs (`re-live-advisory`), not from cfg.engineFreeze alone. That is the new edge.
- Accept calibrated model labels (judge from another family, version-tagged) and disposition labels for precision, not only Dave or dataset labels. This lane defines how precision handles the disposition verdict unclear (wont_fix): no precision reader handles it today.
- Live sync turns on only when the judge-calibrate report marks the rubric GATING, read at run time.
- Run 10 retro runs now, from main only, never from a P4 worktree, at most 6 a day. The other 30 run in `re-p4-winner-evidence` on the frozen version, so they can count.
- Retro runs are kind shadow and save no eval budget. The same-issue judge calls use the headless "judge" slot.

Done when: A round whose runReview reason is `no-files` (exit 2) is a skip, not an engine failure. The 10 retro rows exist with engine records and traces. The shadow scorecard prints per-class recall and a non-null precision on them. Artifact: `.claude/cache/e2e/<date>-re-shadow-retro.txt`.

Why: The retro rows are the only engine-versus-PR-bot pairs today (no paid PR row after 11-04). Rows on prompt v1 go stale when P4 flips the prompt.

### re-gate-ready-a

**GATE: READY from the engine record (report-only), PR A of the old `re-gate-ready`** (wave 2, phase GATE, changed)

The old lane `re-gate-ready` held two PRs. The premortem splits it into two lanes, one PR each (T14). This lane is PR A.

- Depends on: re-engine-seam, re-engine-cli-schema, force-high-security-tier
- Unblocks: re-gate-ready-b, re-demote-mechanism, re-rule-docs, re-retire-critical
- Related: review-status-marker-only-body, re-demote-mechanism, re-cr-rule2, re-live-advisory
- Owns: `scripts/github/review-status.mjs`, `scripts/github/review-status.test.mjs`
- Do not touch: `scripts/github/pr-checkpoint.mjs`, `review-router.config.json`, `scripts/github/land-decision.mjs`, `scripts/github/land-recheck.mjs`, `scripts/github/land-pr.ps1`
- Cost: 0 cursor
- Needs Dave: merge tap (checkpoint.critical). The enforce flip is DP2.6.

Scope (11-05 content of PR A, restated): evaluate in review-status.mjs reads the newest trusted engine record for the head SHA. READY rejects a record with source shadow, trusted false or selfCheck. It binds each record to its cursor-ledger runId and engine main SHA. Open Majors block READY only when engine_gate.report_only is false (code fallback true). Add the localReview field to the output. Fold in the marker-only-body fix.

Changes:
- New edge on force-high-security-tier (A5): it closes the review:none hole before the engine record becomes part of READY.
- T21: READY never reads a pinned-copy record. Under path F the counted records come from a pinned engine copy, and such a record shows trusted:false once fork/main moves. So READY reads the newest trusted record and skips every record that `re-live-advisory` tagged as pinned. A head with only a pinned-copy record counts as "record missing". READY data therefore comes from live-engine runs (DP2.6).

Done when: review-status tests pass, with cases for: record missing, stale SHA, a shadow record, an untrusted record, an open Major in report-only and enforce modes, a head with both a pinned-copy record and a trusted record (READY reads the trusted one), a head with only a pinned-copy record (READY reports record missing), and a `risk:high` record over 0 files (refused). A prove-check fixture shows READY fails with no record in enforce mode. Artifact: `.claude/cache/e2e/<date>-re-gate-ready-a.txt`.

Why: Escape cause: advisory Majors merged open. READY must trust the engine before CodeRabbit steps back.

### re-gate-ready-b

**GATE: Gate C, waiver reason, open Major at land, PR B of the old `re-gate-ready`** (wave 3, phase GATE, changed)

- Depends on: re-gate-ready-a, re-land-ledger
- Unblocks: re-demote-mechanism, re-rule-docs, re-retire-critical
- Related: re-gate-ready-a, re-land-ledger, re-demote-mechanism
- Owns: `scripts/github/land-recheck.mjs`, `scripts/github/land-recheck.test.mjs`, `scripts/github/land-pr.ps1`
- Do not touch: `scripts/github/pr-checkpoint.mjs`, `review-router.config.json`, `scripts/github/land-decision.mjs`, `scripts/github/review-status.mjs`
- Cost: 0 cursor
- Needs Dave: merge tap (checkpoint.critical).
- Subagents (T22): Use Read, Grep and Edit on land-pr.ps1. Never name it in a shell command. The parent runs the test scripts. The decision-gate hook denies a subagent shell command that names land-pr.ps1, also a read-only one.

Scope (11-05 content of PR B, restated): Gate C in land-recheck and land-pr.ps1. -IgnoreReview needs a waiver reason, logged to the land ledger.

Changes:
- E2: in report-only mode, log "open Major at land" (count and record path) to the land ledger. No refusal until the enforce flip.
- Drift (F4): five land-pr test scripts; -IgnoreReview never skips a red CI check (1a78c5ca); land-decision.mjs exists (5f27ec2d). Rebase.
- It is the second holder of land-pr.ps1, after `re-land-ledger`.

Done when: A land-pr test covers the waiver and refuses a land with no reason. A report-only land with an open engine Major writes the open-Major field and lands. The land-recheck tests and the five land-pr tests pass. Artifact: `.claude/cache/e2e/<date>-re-gate-ready-b.txt`.

Why: The land step must record a waiver and an open Major before READY can move to enforce mode.

### re-cr-rule2

**P5.6: CodeRabbit rule 2 (UNCERTAIN Major or overallCorrectness incorrect)** (wave 2, phase P5, changed)

- Depends on: re-engine-cli-schema, re-verifier, re-cr-keys
- Unblocks: re-cr-trustlist, re-gate-summary-sample
- Related: re-cr-trustlist, re-p4-wire, re-finder-v2, engine-trusted-findings
- Owns: `scripts/github/review-router.mjs`, `scripts/github/review-router.test.mjs`, `scripts/github/pr-checkpoint.mjs`, `scripts/github/pr-checkpoint.test.mjs`
- Do not touch: `scripts/github/local-review.mjs`, `review-router.config.json`
- Cost: 0 cursor
- Needs Dave: merge tap (review-router.mjs is checkpoint.critical).

Scope: The rule-2 part of the 11-05 lane only. At HIGH and CRITICAL, recommend CodeRabbit when an UNCERTAIN Major remains after the verifier, or the record says overallCorrectness is incorrect. Do not count policy-tagged UNCERTAIN rows toward the trigger without Dave's yes (D2). Fix the engine-trusted-findings review-router item. Config keys moved to `re-cr-keys`; trust-list growth moved to `re-cr-trustlist`. Drift (F4): autoConfirm "low"; reviews_7d_manual fallback only; control_plane already lists prompt.mjs and context.mjs.

Split choice: split. The trust-list growth follows the DP1.3 policy answer (D4; answered 2026-11-09), and the keys must not wait on rule 2. Rule 2 alone stays one PR.

Done when: Router and checkpoint tests pass, with cases for both triggers, a policy-tagged UNCERTAIN that does not trigger, and a no-record case. With no record, output is byte-identical. Artifact: `.claude/cache/e2e/<date>-re-cr-rule2.txt`.

Why: CodeRabbit stays the safety net where the engine is unsure.

### re-rubric-runners

**P6.1b: rubric runners** (wave 2, phase P6, changed)

- Depends on: re-rubrics, re-engine-cli-schema
- Unblocks: re-judge-calibrate, re-scores-ledger, re-aggregate
- Related: re-rubrics, re-judge-calibrate
- Owns: `scripts/eval/review-eval/rubric-run.mjs` (new), `scripts/eval/review-eval/rubric-run.test.mjs` (new), `scripts/eval/review-eval/miss-cause.mjs` (new), `scripts/eval/review-eval/miss-cause.test.mjs` (new)
- Do not touch: `scripts/eval/review-eval/rubrics/**`, `scripts/eval/review-eval/judge.mjs`, `scripts/github/local-review.mjs`
- Cost: 0 cursor; claude -p up to 4 a day for the smoke
- Needs Dave: no

Scope (11-05 content, restated):
- A deterministic miss-cause classifier: trace filesRead against record impactRows against the truth path.
- A citation check with git show.
- The context-reach ratio, report only.
- An isolated LLM rubric caller that may answer insufficient_evidence, with a judge version tag and a judge from another family than the reviewer.
- Change: it depends on `re-engine-cli-schema` (record fields and traces), not on all of the old `re-engine-seam`.

Done when: Tests cover each cause class on fixture traces, a citation that does not exist in git show, and an insufficient_evidence answer kept apart from fail. Passes cli-smoke. Artifact: `.claude/cache/e2e/<date>-re-rubric-runners.txt`.

Why: The runners read the bumped record schema, which is PR B.

### re-retire-prepr-cli

**B1: go/no-go to stop the pre-pr CodeRabbit CLI** (wave 4, phase DEMOTE, new)

- Depends on: re-live-accrual, re-land-ledger, re-dispositions, re-test-escapes, re-cr-keys, re-prepr-cli-consumer, re-label-two-family, re-judge-calibrate
- Unblocks: none
- Related: re-retire-critical, re-judge-calibrate, re-p4-ab
- Owns: `.claudedocs/review-engine-retire-prepr-cli.md` (new), `review-router.config.json` (the coderabbit.demoted.prepr_cli key only)
- Do not touch: `scripts/**`, the other coderabbit.demoted keys
- Cost: no Cursor run for this lane's own files, and no new CodeRabbit spend. Its counted weeks need the daily sweep: up to 100 live starts a week, run by the coordinator seat (DECIDED, Dave, 2026-11-10). Its cli-gate.mjs label runs use the 20 runs of the label cap of 40 that stay for the gate (DECIDED, Dave, 2026-11-10; see `re-label-two-family`).
- Needs Dave: DP3 answers and the flip yes.
- Long lane (T14): it is not claimed during the counted weeks. The `seat-hold` token (O5) keeps it `blocked` with no owner until 1 round before the 58-day point.

Scope:
- Decided waits (Dave, 2026-11-09). Route J (DP1.8): the lane waits for `re-judge-calibrate`. That is a table edge now, and the lane sits in wave 4. Path F (DP1.5): the lane uses the frozen engine copy and does not wait for `re-p4-ab`. The sweep weeks come from `re-live-accrual` (DP1.18).
- Count the counted PRs from the same-head pairs with the frozen engineVersion.
- Run cli-gate.mjs (`re-label-two-family`) for rows 1 to 4. This lane runs the script and edits no script (T06).
- Write the gate doc: each bar row (see Evidence bar, rows 1 to 7), PASS, NOTE or FAIL, and the source file of each number. Print row 1 and row 7 per risk band (T05).
- Stop rule (DP2.8; DECIDED, Dave, 2026-11-10): the rule reads both forecasts. The counted window on the frozen v1 copy stops when the v1 forecast is under 20% at the chosen row. When the forecast of the phase 4 winner is 20% or more, Dave decides on a new window on the winner. OPEN: the chosen row is DP3.1, which comes after DP2 (see DP2.8).
- Ask Dave for the flip. A yes is one config PR that sets coderabbit.demoted.prepr_cli to the list of risk bands that pass rows 1 and 7 (DP1.15: a band list). DECIDED (Dave, 2026-11-10): row 3 also gates the flip. The counted set closes on a stated end date, and the gate doc names that date. Row 3 is scored 30 days after the last merge in that set, so the flip comes 30 days or more after the set closes. OPEN (not decided): whether rows 2 and 4 to 6 must also PASS before the flip. LOW is never in the list while the engine does not review LOW.
- What the flip does under path F. pre-pr skips the CLI only for a head in a listed band that has an engine record that the per-head rule accepts. DECIDED (Dave, 2026-11-10): the rule accepts a record from the pinned copy, and a record of a later version that a done check proves equal on the default path (same prompt sha and model). The phase 4 winner needs its own window. See `re-prepr-cli-consumer` and "Not covered / risks".
- Run the flip test from `re-cr-keys` on the flip PR.

Done when: The gate doc shows every row with its source file. Dave's yes or no is recorded. On a yes, pre-pr on a test branch with an engine record for the head, in a listed band, prints the "demoted" SKIP line, and the flip test passes. Artifact: `.claude/cache/e2e/<date>-re-retire-prepr-cli.txt`.

Why: Findings 3 and 27. The CLI gate needs no P4 A/B result. Under route J it waits for the judge calibration, which needs Gold B seeds. The CLI is the one CodeRabbit check that runs today, so its bar uses the full same-head set and stays at the 11-05 precision.

### re-cr-trustlist

**D4: grow the trust lists under the DP1.3 policy for re- PRs: CLI plus engine, no PR bot** (wave 3, phase P5, new)

- Depends on: re-cr-rule2, re-cr-keys
- Unblocks: re-demote-mechanism, re-retire-critical
- Related: re-cr-rule2, force-high-security-tier
- Owns: `scripts/github/review-router.mjs` (CRITICAL_TRUST_BOUNDARY only), `scripts/github/review-router-band.test.mjs`, `review-router.config.json` (the checkpoint.critical and matrix.control_plane keys only)
- Do not touch: `scripts/github/pr-checkpoint.mjs`, `scripts/github/local-review.mjs`
- Cost: 0 cursor
- Needs Dave: the merge tap (review-router.mjs is checkpoint.critical). DP1.3 is decided (Dave, 2026-11-09): `re-` PRs get the CodeRabbit CLI plus the engine, and no PR bot.

Scope:
- Engine files (every non-test scripts/github/local-review/** file, backends/**, summary.mjs, and owners.json, hotspots.json and checklist.json when they exist) go into CRITICAL_TRUST_BOUNDARY, checkpoint.critical and matrix.control_plane.
- scripts/eval/review-eval/** goes into checkpoint.critical and matrix.control_plane.
- DP1.3 (decided): no PR bot on `re-` PRs. So scripts/eval/review-eval/** stays out of CRITICAL_TRUST_BOUNDARY. A checkpoint.critical file alone earns no PR bot (pr-checkpoint.mjs:300-304). The other branch (the PR bot allowed) is not chosen.
- DECIDED (Dave, 2026-11-10): DP1.3 covers every `re-` PR, as a process rule. The checkpoint answer on a `re-` PR is `none`, also when the PR changes a trust-boundary file. No code changes for this rule. The trust-boundary rule stays as it is for all other PRs. At HIGH and CRITICAL only Dave's tap records `none`.
- This changes the band set, so it lands before the CRITICAL counted weeks.

Done when: Band tests show an engine file is CRITICAL with a trust file, and an eval file is CRITICAL. A test shows the checkpoint recommends no PR bot for an eval-only PR (DP1.3). A test shows the checkpoint still recommends the PR bot for an engine-file PR. On a `re-` PR the process rule overrides that answer, and Dave's tap records `none` (DECIDED, Dave, 2026-11-10). Artifact: `.claude/cache/e2e/<date>-re-cr-trustlist.txt`.

Why: Finding 20: the 11-05 growth would make every eval PR earn the PR bot, against Dave's 11-05 "none".

### re-p4-wire

**P4: engine half of the wiring: verify stage, majorThreshold, ENGINE_FILES, trace armId** (wave 3, phase P4, changed)

- Depends on: re-engine-seam, re-engine-cli-schema, re-claude-backend, re-verifier, re-finder-v2, re-verifier-replay
- Unblocks: re-p4-harness, re-refs-impact, re-p5-multirun
- Related: re-p4-harness, re-p4-ab, re-cr-rule2
- Owns: `scripts/github/local-review.mjs`, `scripts/github/local-review.test.mjs`, `scripts/github/local-review/trace.mjs`, `scripts/github/local-review/trace.test.mjs`
- Do not touch: `scripts/github/local-review/prompt.mjs`, `scripts/github/local-review/record.mjs`, `scripts/eval/review-eval/**`
- Cost: 0 cursor (stubs)
- Needs Dave: merge tap (trust boundary).

Scope: Add the verify stage and apply majorThreshold in code. Enforce: promptVersion v2 means the verify stage is on. Add verify.mjs and backends/claude.mjs to ENGINE_FILES. trace.mjs tags each event with the armId. The `re-refs-impact` edge is gone (D1). The eval half is `re-p4-harness`.

Done when: An engine run with stub backends on 2 dev PRs, for every cell chosen at DP1.6, writes arm-tagged records and traces. A test shows v2 without verify is refused. Artifact: `.claude/cache/e2e/<date>-re-p4-wire.txt`.

Why: Finding 25: the 11-05 lane had 10 files and 8 dependencies.

### re-judge-calibrate

**P6.2: judge calibration for both families, with a real-label slice** (wave 3, phase P6, changed)

- Depends on: re-rubrics, hf-judge-precheck, re-seed-gold-b, re-rubric-runners, re-label-two-family
- Unblocks: re-retire-prepr-cli, re-l1-schedule, re-aggregate, re-review-doctor, re-retire-critical
- Related: re-label-two-family, re-retire-prepr-cli, re-shadow-retro
- Owns: `scripts/eval/review-eval/judge-calibrate.mjs` (new), `scripts/eval/review-eval/judge-calibrate.test.mjs` (new)
- Do not touch: `scripts/eval/review-eval/judge.mjs`, `scripts/eval/review-eval/labels.mjs`
- Cost: about 40 sonnet calls via claude -p, 6 a day; the Claude-cell judge (2x2 only) is in the P4 scope
- Needs Dave: no

Scope:
- Compute per-rubric TPR and TNR on 60 or more labels, for the judges of both reviewer families.
- Labels: model labels from a family other than the reviewer's, seeded truth from Gold B, and (new) the real slice from `re-label-two-family`.
- Target 90%, minimum 80%. Apply a Rogan-Gladen correction and a bootstrap CI. Every judge carries a version tag.
- New: report the seeded slice and the real slice apart. Whether the real slice gates is the OPEN item (DP3.6); the report supports both answers.

Done when: The report lists n, TPR, TNR and CI per rubric, per family and per slice. A rubric under 60 labels is NOT-GATING. Passes cli-smoke. Artifact: `.claude/cache/e2e/<date>-re-judge-calibrate.json`.

Why: Findings 10 and B9: calibration on seeded bugs only does not test real findings.

### re-gate-shadow-run

**GATE: auto-run the engine in pre-pr (advisory), after 2 weeks of sweep data** (wave 3, phase GATE, changed)

- Depends on: re-prepr-cli-consumer, re-engine-cli-schema, re-live-accrual
- Unblocks: re-delta-wire, re-loop-dryrun
- Related: re-live-advisory, re-live-accrual, re-gate-ready-a
- Owns: `scripts/github/pre-pr.mjs`, `scripts/github/pre-pr.test.mjs`
- Do not touch: `scripts/github/local-review.mjs`, `review-router.config.json`
- Cost: 1 Cursor run per PR push, inside the live cap of 100 a week
- Needs Dave: DP2.5.

Scope (11-05 content, restated): pre-pr runs local-review with --facts from catchers.json and writes the record for the head SHA. It runs only in local_review.bands (MID and up), skips dependabot, keeps per_branch_cap 8 and skips docs-only PRs. Rows are PASS, NOTE or SKIP, never FAIL, with head and coverage match. It never blocks.

Changes: it needs --range (PR B) because the first pre-pr run comes before the PR exists. It counts against the one live cap. The weekly load comes from the measured sweep weeks, not the 140-210 estimate. The prepr_cli consumer moved to `re-prepr-cli-consumer`.

Done when: pre-pr on a test branch writes one engine record with the catcher facts in its context. A failed engine run leaves pre-pr green. A run at the cap SKIPs. Artifact: `.claude/cache/e2e/<date>-re-gate-shadow-run.txt`.

Why: Live records at every head feed READY and the loop. The sweep covers the gap until DP2.

### re-gate-summary-sample

**GATE: one summary comment per SHA and the blind CodeRabbit sample, key at 0** (wave 3, phase GATE, changed)

- Depends on: re-cr-rule2, re-live-advisory
- Unblocks: re-demote-mechanism, re-repromote-auto, re-retire-critical
- Related: re-retire-critical, re-repromote-auto
- Owns: `scripts/github/local-review/summary.mjs` (new), `scripts/github/local-review/summary.test.mjs` (new), `scripts/github/pr-checkpoint.mjs`, `scripts/github/pr-checkpoint.test.mjs`
- Do not touch: `review-router.config.json`, `scripts/github/review-router.mjs`
- Cost: 0 until DP3.3 sets a rate above 0
- Needs Dave: posting PR comments is outward-facing; the rate is DP3.3.

Scope (11-05 content, restated): summary.mjs renders one PR comment per head SHA from the record, edited in place. The checkpoint draws the blind sample by an HMAC of the PR number only, with a secret salt kept outside the repo, so a push cannot redraw it. The rate comes from coderabbit.blind_sample_rate (code fallback 0, sampling off). A sampled PR gets CodeRabbit in its band.

Changes: it reads records from the sweep, so it no longer waits on `re-gate-shadow-run`. Before the flip, the CRITICAL interim-rule reviews are the sample; the checkpoint tags them as sample rows. A HIGH sample is not planned.

Done when: The 11-05 tests pass (same SHA never posts twice, rate within 3 pts over 1000 synthetic ids, stable draw, missing salt turns sampling off). A test shows an interim-rule CRITICAL review is tagged as a sample row. Artifact: `.claude/cache/e2e/<date>-re-gate-summary-sample.txt`.

Why: Finding 5: the 11-05 sample could start only after a flip that needed the sample first.

### re-p4-harness

**P4: eval half of the wiring: engine-run, replay and cli take an arm and gold range targets** (wave 4, phase P4, new)

- Depends on: re-p4-wire, re-eval-contract, re-score-paired, re-gold-assemble, re-answer-key-audit
- Unblocks: re-p4-ab
- Related: re-p4-wire, re-p4-ab, re-score-paired
- Owns: `scripts/eval/review-eval/engine-run.mjs`, `scripts/eval/review-eval/engine-run.test.mjs`, `scripts/eval/review-eval/replay.mjs`, `scripts/eval/review-eval/replay.test.mjs`, `scripts/eval/review-eval/cli.mjs`, `scripts/eval/review-eval/cli.test.mjs`
- Do not touch: `scripts/github/local-review.mjs`, `scripts/eval/review-eval/config.json`, `scripts/eval/review-eval/score.mjs`
- Cost: 0 cursor (stubs)
- Needs Dave: no

Scope: engine-run, replay and cli.mjs take an arm (promptVersion x model x backend) and gold {range} targets. The freeze key gains contextVersion and reads it with a fallback when CONTEXT_VERSION is absent (D1 follow-on). Third holder of cli.mjs. Second holder of replay.mjs, after `re-answer-key-audit`: keep both audit calls (replayRun and replayEngine) for arm and range targets.

Done when: An offline replay with stub backends runs every cell chosen at DP1.6 on 2 dev PRs and 2 seed refs. It writes arm-tagged records. The scorecard groups by arm. A freeze with no CONTEXT_VERSION passes. A run with the reason `no-files` (exit 2) is recorded as a skip and does not stop a batch. Artifact: `.claude/cache/e2e/<date>-re-p4-harness.txt`.

Why: Split from `re-p4-wire` (finding 25). The eval files are not on the trust boundary list today.

### re-demote-mechanism

**DEMOTE: CRITICAL demotion switch and shadow decide on the freeze-set version** (wave 4, phase DEMOTE, changed)

- Depends on: re-gate-ready-a, re-gate-ready-b, re-gate-summary-sample, re-shadow-retro, re-cr-trustlist, re-score-paired, re-live-advisory
- Unblocks: re-repromote-auto, re-p7-calibrated-cutoff, re-rule-docs, re-retire-critical
- Related: re-retire-critical, re-szz-miner, re-scoreboard
- Owns: `scripts/github/review-router.mjs`, `scripts/github/review-router.test.mjs`, `scripts/eval/review-eval/shadow.mjs`, `scripts/eval/review-eval/shadow.test.mjs`
- Do not touch: `scripts/github/pr-checkpoint.mjs`, `scripts/github/review-status.mjs`, `review-router.config.json`, `scripts/github/pre-pr.mjs`
- Cost: 0 cursor
- Needs Dave: merge tap (review-router.mjs is checkpoint.critical).

Scope: The 11-05 lane, for CRITICAL only. The coderabbit.demoted.critical key exists (`re-cr-keys`, false). When coderabbit.demoted.critical is true, the router stops recommending the PR bot at CRITICAL, except for the blind sample and rule 2. The HIGH steps and the `re-delta-wire` edge are gone. In shadow.mjs: engineVersion and bandVersion come from engine-version.mjs (freeze set), not from every ENGINE_FILES blob. decideBand reads holdout.json from `re-score-paired` and the escape baseline. A paired-bar row stays NOTE while its OPEN item is open. Keep decide output a stable row list.

Done when: Router tests cover CRITICAL on and off. With the flag off, output is byte-identical. shadow tests: a change to a coderabbit.* key does not change engineVersion; a change to a reviewer-set file does; a null escape baseline is NOTE. Artifact: `.claude/cache/e2e/<date>-re-demote-mechanism.txt`.

Why: Finding 6: the 11-05 freeze window could not hold, because each flip edited a hashed file.

### re-l1-schedule

**P3.8: nightly escape and shadow sync caller, Monday decide, CCv3-Review-Shadow task** (wave 4, phase P3, changed)

- Depends on: re-shadow-retro, re-land-ledger, re-dispositions, re-judge-calibrate, re-test-escapes
- Unblocks: re-repromote-auto, re-scoreboard, re-review-doctor, re-retire-critical
- Related: re-test-escapes, re-review-doctor
- Owns: `.claude/scripts/scheduled/scheduled-review-shadow.ps1` (new), `.claude/scripts/scheduled/scheduled-review-shadow.bat` (new), `scripts/eval/review-eval/escape-nightly.mjs` (new), `scripts/scheduled/tasks.json`, `package.json` (test:scripts line only)
- Do not touch: `scripts/github/land-pr.ps1`, `scripts/eval/review-eval/escape-causes.mjs`
- Cost: 0 cursor; shadow runs stay under the shadow scope
- Needs Dave: DP2.7 (task registration, confirm-first).

Scope:
- Each night: call fix-chains.mjs over new merges, run dispositions over new PRs, and run shadow sync.
- Each Monday: shadow scorecard and decide.
- Link escape rows to engine records and land-ledger lines.
- Add the task row to tasks.json. In package.json edit only the test:scripts line, to add the wrapper test. Registration is confirm-first (DP2.7).
- Change: the `scheduler-child-safe-and-wake` edge is removed (merged in PR #334, F4).
- Change: new edge on `re-test-escapes`. escape-nightly calls fix-chains.mjs, the one writer of the escape rows file.

Done when: npm run test:scripts passes and its list names the new wrapper test. One manual run writes linked escape rows and one sync row. L1 bar: 90% or more parsed, and escape rows link to engine records. Artifact: `.claude/cache/e2e/<date>-re-l1-schedule.txt`.

Why: Continuous data for the CRITICAL gate and the re-promotion triggers.

### re-delta-wire

**GATE: engine delta record after a fix push** (wave 4, phase GATE, changed)

- Depends on: re-gate-shadow-run, re-engine-cli-schema
- Unblocks: none
- Related: re-gate-ready-a, re-gate-shadow-run
- Owns: `scripts/github/cr-fix.mjs`, `scripts/github/cr-fix.test.mjs`
- Do not touch: `scripts/github/local-review.mjs`, `scripts/github/pr-checkpoint.mjs`, `review-router.config.json`
- Cost: 1 Cursor run per fix push, inside the live cap
- Needs Dave: DP2.5.

Scope: After a fix push, cr-fix runs the engine at the new head SHA so the PR has a record there. The HIGH round-2 replacement is dropped: no PR bot runs at HIGH today (finding 4). No longer a dependency of `re-demote-mechanism`.

Done when: cr-fix tests pass, with a case where a fix push writes a record at the new head, and a case at the cap that SKIPs. Artifact: `.claude/cache/e2e/<date>-re-delta-wire.txt`.

Why: READY in enforce mode (DP2.6) needs a record at the head after fixes.

### re-p4-ab

**P4.4: Grok-only test (2 arms), cut to fit the P4 scope of 120, and keep-or-kill** (wave 5, phase P4, changed)

- Depends on: re-p4-harness, re-gold-assemble
- Unblocks: re-holdout-rotate, re-refs-impact, re-p4-winner-evidence, re-p5-multirun
- Related: re-p4-winner-evidence, re-critical-model-check, re-retire-prepr-cli
- Owns: `.claudedocs/review-engine-p4-results.md` (new), `scripts/github/local-review/prompt.mjs`
- Do not touch: `scripts/github/local-review.mjs`, `scripts/eval/review-eval/score.mjs`
- Cost (T04): Cursor starts under the P4 scope = (controls + holdout PRs + dev PRs + gold targets) x arms x runs / 0.81. The floor for Grok-only is about 94 starts (see "Capacity plan"). The old figures, about 60 for the 2x2 and about 30 for Grok-only, are void. The design is cut so that the starts fit the free P4 scope (DP1.16). claude -p 10 a day only for the 2x2, which is not chosen
- Needs Dave: the keep-or-kill is DP2.1. DP1.2, DP1.6 and DP1.16 are decided (Dave, 2026-11-09): the P4 scope stays 120, Grok-only first (2 arms), and the design is cut to fit 120 with interleaved arms. DP1.7 is not asked.
- The cut (DP1.16). Dave decided the rule on 2026-11-09. DECIDED (Dave, 2026-11-10): the cut has 15 or more controls, and bar row 8 of `re-retire-critical` asks for that count. The lane runs the reduced design that `re-eval-contract` computes, and it computes the design again from the free P4 scope on the day it starts. Proposal, not decided: a stratified gold sample (strata by gold source and class; counts only, no PR ids). The lane lowers no bar row itself.

Scope (11-05 content, restated) for the cells chosen at DP1.6 (Grok-only: v1 and v2 on Grok 4.7; the Claude cells of the 2x2 are not chosen and run later only if v2 on Grok fails [Speculation: that condition was the recommendation text; the journal row says only "Grok-only first"]):
- Freeze each arm through cli freeze. Every v2 cell includes the verifier.
- Screen on dev and the regression suite at 1 run per cell, then 2 runs on the leading pair.
- Score the holdout once per frozen arm, through the holdout-spend ledger.
- Measure the verifier false-refute rate on gold Majors.
- The Claude cell (2x2 only) uses a judge from another family.
- If the bar passes, run 1 week of shadow on the winner, then flip PROMPT_VERSION in prompt.mjs (a one-line PR) and re-run cli freeze.

Regression bar (moved from `re-gold-assemble`, Dave 2026-11-15): after the first screen the regression suite holds 1 row or more, by the producer rule of the gold-row contract. A count of 0 is a finding for the seat, not a pass.

Changes: the v1 arm runs on the 15 or more clean controls of the cut (DECIDED, Dave, 2026-11-10; before: 30 or more), and that rate is the clean baseline. Print per-class recall (same-file, cross-file, in-file) for the DP2.4 trigger. A kill keeps v1 as the frozen version. A keep flips PROMPT_VERSION and re-runs cli freeze. The fresh-holdout scoring moved to `re-p4-winner-evidence`.

Changes from the premortem:
- Interleave (T04): the lane runs every arm on one target before it starts the next target. A budget refusal then leaves equal arms. The lane checks the free P4 scope before each target, not only at the start.
- Old holdout (T20): the holdout that this lane scores is the old one, which P1 used. Its score is NOTE, never a gating row. The gating holdout score is the fresh one in `re-p4-winner-evidence`, after `re-holdout-rotate`.
- Lost Major (T20): a lost caught Major is one that 2 of 2 baseline runs catch and 2 of 2 candidate runs miss. Two runs of the same v1 engine changed the result on 2 of 10 keys, so one run per side can show a loss by noise. "Score the holdout once" means one scoring event with 2 runs per arm.
- The keep-or-kill needs a gating rule. Dave answers the paired-bar item (DP3.5) with DP2.1.

Done when: The results doc has these parts. A paired-bar table per arm (NOTE while OPEN). The per-class recall table. The clean false-Major rate per clean PR, with its CI. Verifier false refutes that cost 0 caught Majors. The old-holdout score, marked NOTE. The run count per arm and per target, equal for all arms. A keep-or-kill line. Artifact: `.claude/cache/e2e/<date>-re-p4-ab.json`.

Why: The phase 4 decision, on data. DP1.6 is Grok-only first; the text also works for a later 2x2.

### re-repromote-auto

**DEMOTE: automatic re-promotion for the CRITICAL band** (wave 5, phase DEMOTE, changed)

- Depends on: re-demote-mechanism, re-gate-summary-sample, re-prepr-cli-consumer, re-l1-schedule
- Unblocks: re-rule-docs, re-retire-critical
- Related: re-prepr-cli-consumer, re-retire-critical, re-test-escapes
- Owns: `scripts/eval/review-eval/shadow.mjs`, `scripts/eval/review-eval/shadow.test.mjs`, `scripts/github/pr-checkpoint.mjs`, `scripts/github/pr-checkpoint.test.mjs`, `scripts/eval/review-eval/band-state.mjs`, `scripts/eval/review-eval/band-state.test.mjs`
- Do not touch: `review-router.config.json`, `scripts/github/review-router.mjs`, `scripts/github/pre-pr.mjs`
- Cost: 0 cursor
- Needs Dave: merge tap only.

Scope: Add the CRITICAL-band triggers to band-state.mjs:
- decide exit 3;
- 2 misses in the last 10 sampled PRs;
- 1 security-tier escape;
- new: 1 escape that a model label rates Critical, blamed to a PR merged in a demoted band.
The rate rule uses the per-band baseline and a 4-week window. The escape triggers need no blind sample. pr-checkpoint reads band-state and recommends the PR bot in that band until Dave clears it.

Done when: Tests: each trigger writes band-state; the checkpoint adds the PR bot for that band; no band-state file means no change; a non-security Critical escape triggers. Artifact: `.claude/cache/e2e/<date>-re-repromote-auto.txt`.

Why: Retirement must be reversible with no session (eval B8, refuter on escape-tripwire).

### re-scoreboard

**Program: review-engine scoreboard** (wave 5, phase program, changed)

- Depends on: re-score-paired, re-eval-contract, re-gold-assemble, re-land-ledger, re-l1-schedule
- Unblocks: re-retire-critical
- Related: re-retire-prepr-cli, re-retire-critical, re-live-advisory
- Owns: `scripts/eval/review-eval/program-status.mjs` (new), `scripts/eval/review-eval/program-status.test.mjs` (new)
- Do not touch: `scripts/eval/review-eval/score.mjs`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: no

Scope (11-05 content, restated): a read-only report with these sections:
- budget used per phase scope, Grok slot use, headless use, verifier calls;
- gold counts; the latest paired bar per arm; the clean false-Major rate;
- shadow decide per band, read from decideBand output as a generic row list;
- land-ledger escapes; READY exit evidence (PRs landed with a record, -IgnoreReview lands with no reason);
- capacity: runs per PR p50 and p90, weekly Cursor load.

Changes: the `re-scores-ledger` edge is gone (deferred). Sections added: live cap use, same-head pair counts per week, the two gate bars as PASS, NOTE or FAIL rows, band-state per band, and the escape-cause shares from `re-test-escapes`.

Done when: It prints every section on current data with no network. Each row names its source file. A fixture with a missing source prints that row as NOTE, not PASS. Passes cli-smoke. Artifact: `.claude/cache/e2e/<date>-re-scoreboard.txt`.

Why: One place for the program state. The NOTE-on-missing check fixes the weak 11-05 done check.

### re-rule-docs

**GATE/DEMOTE: pr-review-loop rule text for the engine gate, demotion and re-promotion** (wave 6, phase DEMOTE, changed)

- Depends on: re-gate-ready-a, re-gate-ready-b, re-demote-mechanism, re-repromote-auto, re-prepr-cli-consumer
- Unblocks: re-retire-critical
- Related: re-retire-prepr-cli, re-retire-critical
- Owns: `.claude/rules-ondemand/pr-review-loop.md`
- Do not touch: `scripts/**`, `review-router.config.json`
- Cost: 0 cursor; claude -p 2
- Needs Dave: merge tap (rule change).

Scope: Update the rule file for: the engine record, the localReview field, READY in report-only and enforce modes, the waiver, the blind sample, demoted bands and re-promotion. Counts and paths only; no gold or holdout content. Changes: the path is `.claude/rules-ondemand/pr-review-loop.md` (the 11-05 map named rules-src, where the file does not exist). No HIGH steps. Add the CLI demotion, band-state and the pre-pr "demoted" SKIP line. Counts and paths only.

Done when: After the sync, a fresh headless session on a PR-review prompt applies the new rule text (claude -p JSON saved). context-budget-guard --repo passes. Artifact: `.claude/cache/e2e/<date>-re-rule-docs.json` plus the guard summary line.

Why: Sessions follow the rule file, not the code.

### re-holdout-rotate

**Combined-plan P6 guardrail: holdout rotation, with the scope corrected** (wave 6, phase P6, changed)

- Depends on: re-p4-ab, re-eval-contract
- Unblocks: re-p4-winner-evidence, re-p5-online
- Related: re-p5-online, re-retire-critical, re-owners-hotspots, re-p4-winner-evidence
- Owns: `scripts/eval/review-eval/config.json`, `scripts/eval/review-eval/rotate-holdout.mjs` (new), `scripts/eval/review-eval/rotate-holdout.test.mjs` (new)
- Do not touch: `scripts/eval/review-eval/freeze.mjs`, `scripts/eval/review-eval/gold/**`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: no

Why the 11-05 scope is replaced (T20). The 11-05 text says: move the reserve list into holdoutExclude. In today's code splitSets puts every PR in holdoutExclude into dev, and every other PR into holdout (dataset.mjs:46-50). So that text makes the reserve PRs dev and leaves the old holdout as the holdout. No fresh holdout comes from it. A read-only run of splitSets on a synthetic set proved this.

Scope:
- A rotation makes the reserve the new holdout. The old holdout joins holdoutExclude, so it becomes dev.
- After the rotation, the lane draws a new reserve from recent shadow PRs.
- The first rotation runs after `re-p4-ab` spends the current holdout. Later rotations run each quarter.
- Never rotate while an experiment lane holds the Cursor eval slot.
- Write the rotation to the holdout-spend ledger.
- `re-eval-contract` makes splitSets read the reserve list, so a reserve PR is in neither dev nor holdout before a rotation. This lane only moves PRs between the lists in config.json. A change to dataset.mjs goes through the holder of that file.

Done when: A splitSets test on a synthetic set shows, after one rotation: every old reserve PR is in the holdout, every old holdout PR (the holdout before rotation, reserve excluded) is in dev, and no PR is in both sets. A test shows a rotation refuses to run with an active eval-slot claim. A rotated holdout has no PR from any dev row. One dry run prints the new split counts only, no PR ids. Artifact: `.claude/cache/e2e/<date>-re-holdout-rotate.txt`.

Why: P4 spends the holdout. The CRITICAL gate needs a fresh one (bar row 7). Second holder of config.json.

### re-p4-winner-evidence

**B5a: score the fresh holdout once with the frozen version, and run the 30 retro rows on it** (wave 7, phase P4, new)

- Depends on: re-p4-ab, re-holdout-rotate, re-shadow-retro
- Unblocks: re-retire-critical
- Related: re-p4-ab, re-score-paired, re-retire-critical
- Owns: `.claudedocs/review-engine-p4-winner-evidence.md` (new)
- Do not touch: `scripts/**`, `scripts/eval/review-eval/config.json`
- Cost: on a keep, about 4 Cursor runs per fresh-holdout PR (2 arms, 2 runs each), about 32 starts in all (DECIDED, Dave, 2026-11-10; before: about 16). On a kill, about 2 runs per PR. All starts are inside the P4 scope of 120. Plus 30 shadow runs (shadow scope, 6 a day); holds the Cursor eval slot
- Needs Dave: the paid CRITICAL sample, its owner and its budget. Dave decides them when this lane is done on the frozen version (DP1.14, 2026-11-09). DP1.2 is decided: the P4 scope of 120 and the 30 shadow runs are approved.

Scope: After the first rotation, score the fresh holdout once with the version frozen by `re-p4-ab` (the v2 winner, or v1 on a kill), through the holdout-spend ledger. DECIDED (Dave, 2026-11-10): on a keep, this one scoring event runs both arms, v1 and the v2 winner, 2 runs each, on each fresh-holdout PR. The v1 runs are the baseline of bar row 7. On a kill, bar row 7 is not applicable. Write holdout.json through `re-score-paired`. Then run 30 shadow retro rows on the same version.

Done when: holdout.json has one row keyed by the frozen engineVersion, with a holdout-spend ledger line. 30 retro rows carry the same engineVersion. The doc states lost caught Majors (the bar needs 0). On a keep, the doc shows 2 runs of each arm on each fresh-holdout PR, and it counts a lost Major by the 2 of 2 rule of bar row 7. On a kill, the doc marks bar row 7 not applicable (DECIDED, Dave, 2026-11-10). Artifact: `.claude/cache/e2e/<date>-re-p4-winner-evidence.txt`.

Why: Today only a P5 lane scores a fresh holdout, and P5 is off the path (B2).

### re-retire-critical

**B1: go/no-go to stop the CodeRabbit PR bot at CRITICAL** (wave 8, phase DEMOTE, new)

- Depends on: re-demote-mechanism, re-repromote-auto, re-gate-summary-sample, re-gate-ready-a, re-gate-ready-b, re-score-paired, re-p4-winner-evidence, re-judge-calibrate, re-scoreboard, re-l1-schedule, re-rule-docs, re-cr-trustlist
- Unblocks: re-p7-calibrated-cutoff
- Related: re-retire-prepr-cli, re-p7-calibrated-cutoff
- Owns: `.claudedocs/review-engine-retire-critical.md` (new), `review-router.config.json` (the coderabbit.demoted.critical key only)
- Do not touch: `scripts/**`, the other coderabbit.demoted keys
- Cost: 0 cursor; the interim-rule reviews are the pre-flip sample, so no new CodeRabbit spend before the flip
- Needs Dave: DP3 answers and the flip yes.
- Long lane (T14): during the counted weeks it is `blocked` with no owner (see "Long lanes" in "How to use this map"). DP1.14 is decided (Dave, 2026-11-09; E02): CRITICAL stays on the CodeRabbit PR bot under the interim rule for now. The paid sample, its owner and its budget are decided when `re-p4-winner-evidence` is done on the frozen version.

Scope: Counted weeks start after every lane that changes the reviewer set or the band set has landed (`re-cr-trustlist`, `re-demote-mechanism`, `re-gate-ready-a`, `re-gate-ready-b`, and `re-refs-impact` and `re-p5-multirun` if DP2.4 brought them back; the Waves row holds both as conditional tokens). Count the interim-rule CRITICAL reviews paired with frozen-version records. Write the gate doc: each bar row, PASS, NOTE or FAIL, with the source file of each number. Apply the 4-week hold after whichever flip comes first. Ask Dave for the flip; a yes is one config PR. Run the flip test from `re-cr-keys` on the flip PR.

Done when: The gate doc shows every row with its source file. Dave's yes or no is recorded. On a yes, the checkpoint on a CRITICAL fixture recommends no PR bot except for a blind-sample draw or rule 2, and the flip test passes. Artifact: `.claude/cache/e2e/<date>-re-retire-critical.txt` with the scoreboard output.

Why: Dave 11-04 goal: no CodeRabbit. The PR bot at CRITICAL is the paid piece that remains after the CLI.

### re-critical-model-check

**Phase-1 leftover: CRITICAL-band model name and answer-key tree excludes in cursor-review.mjs** (wave 0, phase P1-followup)

- Depends on: none
- Unblocks: re-szz-miner, re-seed-gold-b, re-gold-c-external, re-rubrics, re-live-advisory
- Related: re-p4-ab, re-engine-seam, re-engine-cli-schema
- Owns: `scripts/github/cursor-review.mjs`, `scripts/github/cursor-review.test.mjs`
- Do not touch: `scripts/github/local-review.mjs`
- Cost: 0 cursor (list only)
- Needs Dave: cursor-review.mjs is on the trust boundary: the PR needs your merge yes.

Scope: Read cursor-agent's model list ($0). Fix BAND_MODEL.CRITICAL if the xhigh display name is wrong. MODEL_ALLOWLIST stays unchanged. Add scripts/eval/review-eval/gold, scripts/eval/review-eval/seeds, scripts/eval/review-eval/rubrics and scripts/eval/review-eval/linktype-labels.json to TREE_EXCLUDES. Add a test that no excluded path appears in the built review tree or in PR.diff.

Done when: The model list output is saved. The resolveModel test for CRITICAL passes. The new tree test passes, and the TREE_EXCLUDES export test lists the new paths. Artifact: .claude/cache/e2e/<date>-re-critical-model.txt.

Why: No CRITICAL run has been seen; a wrong name fails the highest-risk reviews. The answer key is in the review tree today (linktype-labels.json is tracked), and every gold lane adds more key files, so all gold producers wait for this lane.

### re-gold-schema

**Combined-plan P3: gold-row schema and loader (gold.mjs), lands first** (wave 0, phase P3)

- Depends on: none
- Unblocks: re-eval-contract, re-szz-miner, re-seed-gold-b, re-gold-c-external, re-score-paired
- Related: re-eval-contract, re-szz-miner, re-seed-gold-b, re-gold-c-external, re-score-paired
- Owns: `scripts/eval/review-eval/gold.mjs`, `scripts/eval/review-eval/gold.test.mjs`
- Do not touch: `scripts/eval/review-eval/config.json`, `scripts/eval/review-eval/dataset.mjs`, `scripts/eval/review-eval/gold/**`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: no

Scope: gold.mjs exports the row schema, a validator and a loader for gold/*.json. Fields: id, source A|B|C|CR, suite regression|capability, split dev|holdout|reserve, target {repo?,pr,round,sha40} or {range base..head}, file, line?, severity, linkType, labels [{by,verdict,judgeVersion?}], provenance, slice? (security). Reject a row with an unknown field value. It also exports loadCleanControls for gold/clean-controls.json (see the Gold-row contract). No data rows in this lane.

Done when: gold.test.mjs covers each listed failure: bad source, bad suite, bad split, a target with neither form, a label with no by. node --test scripts/eval/review-eval/*.test.mjs passes with 220 or more passes. Artifact: .claude/cache/e2e/<date>-re-gold-schema.txt.

Why: Three wave-1 lanes write gold rows, and `re-eval-contract` (wave 1) reads them. The schema must land before them.

### re-dispositions

**Combined-plan P3.5: dispositions.mjs (thumbs and 'Fixed in <sha>' replies)** (wave 0, phase P3)

- Depends on: none
- Unblocks: re-label-two-family, re-gold-assemble, re-retire-prepr-cli, re-l1-schedule, re-aggregate, re-shadow-retro
- Related: re-aggregate, re-l1-schedule
- Owns: `scripts/eval/review-eval/dispositions.mjs`, `scripts/eval/review-eval/dispositions.test.mjs`
- Do not touch: `scripts/github/review-status.mjs`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: no

Scope: Read review threads read-only with gh api over PRs 188 to the newest merged PR (335 or later at run time). Label each bot finding fixed, wont_fix, wrong or unlabeled. A finding open at merge is unlabeled, never negative.

Done when: The denominator is the count of coderabbitai[bot] review comments from gh api on the merged pull requests of the range, saved with the artifact. Pull requests closed without merge are counted apart. 90%+ of them are parsed. Every bot finding that has a trusted reply gets a disposition. A trusted reply that matches no frozen rule is unlabeled with a reason (reply_unmatched or reply_conflict). The exit code does not depend on the unlabeled count. Passes cli-smoke. Artifact: .claude/cache/e2e/<date>-re-dispositions.json.

Why: Feeds Gold A, the false-positive rubric, shadow precision and R8 memory. Any memory store use takes items of the dev split only.

### re-finder-v2

**Combined-plan P4.1/4.3: finder prompt v2 behind PROMPT_VERSION** (wave 0, phase P4)

- Depends on: none
- Unblocks: re-p4-wire
- Related: re-p4-wire, re-p4-ab, re-cr-rule2
- Owns: `scripts/github/local-review/prompt.mjs`, `scripts/github/local-review/prompt.test.mjs`
- Do not touch: `scripts/eval/review-eval/config.json`, `scripts/github/local-review/context.mjs`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: no

Scope: Add v2: drop the METHOD self-disprove step, list every supportable defect then rank, allow confidence 1-2, remove band and 'blocks merge' wording, ask for a trigger path and P(real), and emit overallCorrectness (correct, incorrect or unsure), v2 only. Export majorThreshold(p) so code applies the Major cut. v1 stays default (PROMPT_VERSION) and byte-identical.

Done when: v1 promptSha256 unchanged (test); v2 builds under 24,000 chars on the largest holdout PR; a test shows v2 output parses overallCorrectness; artifact .claude/cache/e2e/<date>-re-finder-v2.txt with both shas.

Why: Phase 4 arm; one owner of prompt.mjs so the freeze stays valid. Rule 2 reads overallCorrectness, so a lane must produce it.

### re-claude-backend

**Combined-plan P4: Claude backend for the engine (claude -p arm)** (wave 0, phase P4)

- Depends on: none
- Unblocks: re-p4-wire
- Related: re-engine-seam, re-p4-wire, hf-judge-precheck
- Owns: `scripts/github/local-review/backends/claude.mjs`, `scripts/github/local-review/backends/claude.test.mjs`
- Do not touch: `scripts/github/local-review.mjs`, `scripts/github/cursor-review.mjs`, `scripts/lib/headless.mjs`, `scripts/eval/review-eval/config.json`
- Cost: 0 cursor; claude -p 2/day
- Needs Dave: no

Scope: Implement the backend contract for claude -p. Reuse the ledger and the 200/day cap (30 before 2026-11-14) from scripts/lib/headless.mjs read-only; do not change its sonnet default. The model comes from the caller (--model or the config.json judge-model map for judges), effort high, never haiku, no fast mode. Arm parity with the Grok arm: cwd = reviewDir, read-only tools (Read, Grep, Glob) only, no Bash, Edit or Write, and a stream trace that yields filesRead.

Done when: Unit tests pass with a fake runner, run by hand until re-test-globs lands. One live claude -p smoke on a tiny fixture returns parseable findings JSON and a filesRead trace. The smoke context shows no lane-board or SessionStart text. Artifact: .claude/cache/e2e/<date>-re-claude-backend.json.

Why: A 2x2 needs a Claude arm with the same tool access as the Grok arm, or the test mixes two variables. DP1.6 (Dave, 2026-11-09) is Grok-only first, so the Claude cells are not chosen now. The backend is still needed: `re-p4-wire` adds backends/claude.mjs to ENGINE_FILES, and `re-verifier-replay` can use this backend.

### re-seed-gold-b

**Combined-plan P3.2: Gold B seeded bugs (Claude-written plus mutation operators, test-breaking), adopts seeded-vuln-probes** (wave 1, phase P3)

- Depends on: re-critical-model-check, re-gold-schema, re-answer-key-audit
- Unblocks: re-gold-assemble, re-judge-calibrate
- Related: seeded-vuln-probes, re-engine-cli-schema, re-gold-assemble, re-judge-calibrate
- Owns: `scripts/eval/review-eval/seed.mjs`, `scripts/eval/review-eval/seed.cases.mjs`, `scripts/eval/review-eval/seed-shard-*.test.mjs`, `scripts/eval/review-eval/seeds/**`, `scripts/eval/review-eval/gold/gold-b.json`
- Do not touch: `scripts/github/local-review.mjs`, `scripts/eval/review-eval/replay.mjs`
- Cost: 0 cursor; claude -p up to 8/day
- Needs Dave: Any Grok review runs on the security probes (seeded-vuln-probes item) need the eval budget and your yes.
- OPEN (Dave): decide if the seeded-vuln-probes card closes with an ADOPTED note.

Scope: seed.mjs writes 60-100 seeded bugs as local refs (refs/eval/seed/*), never pushed. Seed both same-file and cross-file kinds, from dev-split code only. Claude seeds, never Grok. Seed part of the set with SWE-smith-style mutation operators, so the Claude arm is not scored only on Claude-written bugs. Report Gold B for the Claude arm apart, as non-gating. Keep a bug only when a named test or probe breaks. The security slice from seeded-vuln-probes stays as its own suite. Rows use the {range} target form; re-engine-cli-schema owns --range. A Grok run on a seed runs only after `re-answer-key-audit` is done, and read-audit.mjs audits its stream.

Done when: gold-b.json has 40+ rows, at most 6 per target file (Dave, 2026-11-15: fewer rows in this PR; the rest of the bar of 60 moves to card gold-b-followups). Each row has a breaking test command with its failure hash recorded, and an author field (claude or operator). 0 rows come from holdout or reserve PRs (count scan of gold-b.json). seed.mjs check-refs against the fork is ok with every counter 0, so no seed ref tree holds a gold or seed file and no seed ref is on the remote. seed.mjs passes cli-smoke. Artifact: .claudedocs/e2e-re-seed-gold-b/.

Why: Cross-file-dynamic recall is 0/6; we need many controlled cases. Reported apart from Gold A, never the recall headline.

### re-gold-c-external

**Combined-plan P3.3: Gold C external slices (Qodo PR-Review-Bench, AACR-Bench)** (wave 1, phase P3)

- Depends on: hf-judge-precheck, re-critical-model-check, re-gold-schema
- Unblocks: re-gold-assemble
- Related: hf-judge-precheck, re-gold-assemble
- Owns: `scripts/eval/review-eval/external-pull.mjs`, `scripts/eval/review-eval/external-pull.test.mjs`, `scripts/eval/review-eval/external-slices.mjs`, `scripts/eval/review-eval/external-slices.test.mjs`, `scripts/eval/review-eval/gold/gold-c.json`
- Do not touch: `scripts/eval/review-eval/external-judge.mjs`
- Cost: 0 cursor, 0 claude -p (download only)
- Needs Dave: no

Scope: Pinned pulls of TS/JS/Py slices into .claude/cache/hf-datasets/, converted to gold rows through gold.mjs. Never tune on them. ReviewBench deferred.

Done when: gold-c.json rows carry dataset name and pinned sha; assertPinned refuses an unpinned source in a test; external-slices.mjs passes cli-smoke; artifact .claude/cache/e2e/<date>-re-gold-c.txt.

Why: An external holdout guards against overfitting to our own PRs. Waits on hf-judge-precheck, which owns the HF step and external-judge.

### re-rubrics

**Combined-plan P6.1: judge rubrics in skill-doctor format** (wave 1, phase P6)

- Depends on: re-critical-model-check
- Unblocks: re-judge-calibrate, re-aggregate, re-rubric-runners
- Related: re-judge-calibrate, re-aggregate, re-rubric-runners, debug-skill-eval-rest
- Owns: `scripts/eval/review-eval/rubrics/**`
- Do not touch: `scripts/eval/review-eval/judge.mjs`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: no

Scope: Seven rubrics: missed-bug, miss-cause (deterministic first), false-positive, severity, citation (deterministic via git show), context-reach (report only), test-value.

Done when: Seven .md files exist, with pass/fail examples from dev PRs only. A lint test checks the headings and that no holdout or reserve PR id appears. Artifact: .claude/cache/e2e/<date>-re-rubrics.txt.

Why: The self-improving loop judges against fixed rubrics. Waits for the tree excludes so the rubrics never reach a review tree.

### re-gold-assemble

**Combined-plan P3 gate: assemble 50+ gold Majors, adjudicate the CodeRabbit set, split suites, extend linkType labels** (wave 2, phase P3)

- Depends on: re-eval-contract, re-szz-miner, re-seed-gold-b, re-gold-c-external, re-dispositions
- Unblocks: re-p4-harness, re-aggregate, re-p4-ab, re-scoreboard, re-p7-calibrated-cutoff
- Related: re-score-paired, re-p4-ab, re-aggregate, re-gold-schema
- Owns: `scripts/eval/review-eval/cli.mjs`, `scripts/eval/review-eval/cli.test.mjs`, `scripts/eval/review-eval/linktype.mjs`, `scripts/eval/review-eval/linktype.test.mjs`, `scripts/eval/review-eval/linktype-labels.json`, `scripts/eval/review-eval/adjudicate-cr.mjs`, `scripts/eval/review-eval/adjudicate-cr.test.mjs`, `.claudedocs/2026-11-01-pr-review-dataset.json`, `scripts/eval/review-eval/gold/adjudicated-cr.json`, `scripts/eval/review-eval/gold/adjudicated-cr.state`
- Do not touch: `scripts/eval/review-eval/config.json`, `scripts/eval/review-eval/gold/gold-a.json`, `scripts/eval/review-eval/gold/gold-b.json`, `scripts/eval/review-eval/gold/gold-c.json`, `scripts/eval/review-eval/gold/clean-controls.json`
- Cost: 0 cursor; claude -p up to 6/day for labels
- Needs Dave: no

Scope: Wire the mine, seed, dispositions and gold subcommands into cli.mjs. Load A/B/C and the clean controls through gold.mjs. Adjudicate the CodeRabbit-derived set with an agent and keep only real introduced defects (gold/adjudicated-cr.json, model labels). Add a Gold D "resolved by merge" precision proxy as a report row. Add two-rater model linkType labels for the new gold Majors. Add line data to the two dataset rows that match on file only.

Done when: P3 pass bar: the cli gold report shows 50+ gold Majors across A/B/C. Every Gold B row has a recorded breaking test. The capability suite is non-empty. The regression suite may be empty in this lane: no gold target has an engine record before `re-p4-ab` (Dave, 2026-11-15). The gold report prints the regression row with the count of gold targets that have an engine record, and fails on an empty suite only when that count is above 0. There are 30+ clean controls. Artifact: .claude/cache/e2e/<date>-re-gold-assemble.json.

Why: P3 must reach 50 gold Majors before any P4 keep-or-kill call. Second holder of cli.mjs, before re-p4-harness.

### re-owners-hotspots

**Combined-plan P5.2/5.4: owners.json and hotspots.json from dev PRs only** (wave 2, phase P5)

- Depends on: re-eval-contract
- Unblocks: re-refs-impact, re-p5-multirun
- Related: re-refs-impact, re-p5-multirun, re-holdout-rotate
- Owns: `scripts/github/local-review/owners.json`, `scripts/github/local-review/hotspots.json`, `scripts/github/local-review/owners.test.mjs`
- Do not touch: `scripts/github/local-review/context.mjs`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: no

Scope: Write 10-20 entries by hand, seeded from dev-split PRs only. Give each hot file a state-and-event checklist. A test checks that no entry cites a holdout PR or a PR in the config.json reserve list.

Done when: Both JSON files validate. The leak test passes and fails on a planted holdout id and a planted reserve id. Artifact: .claude/cache/e2e/<date>-re-owners-hotspots.txt.

Why: Inputs to refs.mjs and the focused hot-file pass. Waits on re-eval-contract for the reserve list.

### re-scores-ledger

**Combined-plan P6.3: scores.mjs and the weekly ratchet** (wave 3, phase P6)

- Depends on: re-rubric-runners
- Unblocks: re-aggregate
- Related: re-aggregate, re-scoreboard, re-review-doctor
- Owns: `scripts/eval/review-eval/scores.mjs`, `scripts/eval/review-eval/scores.test.mjs`
- Do not touch: `scripts/eval/review-eval/score.mjs`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: no

Scope: Append rows to ~/.claude/state/review-scores.jsonl. Row schema: {ts, prId, headSha, armId, engineVersion, promptVersion, contextVersion, rubric, judgeVersion, verdict pass|fail|insufficient_evidence, score, evidence[]}. Alert when a rubric's 2-week mean falls more than 1 CI below the prior 4 weeks. Also alert on any version-field change alone.

Done when: Tests cover both alerts and a no-alert case; passes cli-smoke; artifact .claude/cache/e2e/<date>-re-scores-ledger.txt.

Why: Ratchet for the loop. `re-scoreboard` has no edge to this lane now (see `re-scoreboard`, "Changes").

### re-aggregate

**Combined-plan P6.4/6.5: aggregate.mjs and checklist.json counters** (wave 4, phase P6)

- Depends on: re-rubrics, re-scores-ledger, re-dispositions, re-gold-assemble, re-judge-calibrate, re-rubric-runners
- Unblocks: re-review-doctor
- Related: re-review-doctor, re-loop-dryrun, re-refs-impact
- Owns: `scripts/eval/review-eval/aggregate.mjs`, `scripts/eval/review-eval/aggregate.test.mjs`, `scripts/github/local-review/checklist.json`
- Do not touch: `scripts/github/local-review/prompt.mjs`, `scripts/github/local-review/context.mjs`
- Cost: 0 cursor; claude -p up to 5/day for judging OPEN (Dave): decide the daily headless share for this lane when it returns.
- Needs Dave: no

Scope: Group by rubric, cause, linkType, file kind. A proposal needs 2+ PRs (3+ for a prompt.mjs edit) except a lost regression Major. Node merges helpful/harmful counters on 2+ PR evidence; an LLM never rewrites them. Dry run writes files only, to docs/self-improvement/proposals/. Clusters use dev and regression rows only; shadow PRs that may join the next holdout are excluded.

Done when: Tests show three cases file nothing: a single-PR miss, a policy-type cause, and a coverage-only win. A fixture with one 2-PR cluster files exactly 1 proposal. A fixture with a reserve-split PR files nothing from it. Each proposal cites 2+ PRs and trace lines. Artifact: .claude/cache/e2e/<date>-re-aggregate.txt.

Why: Outer-loop proposals with guardrails.

### re-review-doctor

**Combined-plan P6.6/6.7: weekly CCv3-Review-Doctor and review-engine-watch** (wave 5, phase P6)

- Depends on: re-aggregate, re-judge-calibrate, re-l1-schedule
- Unblocks: re-loop-dryrun
- Related: re-loop-dryrun
- Owns: `.claude/scripts/scheduled/scheduled-review-doctor.ps1`, `.claude/scripts/scheduled/scheduled-review-doctor.bat`, `scripts/eval/review-eval/review-engine-watch.mjs`, `scripts/eval/review-eval/review-engine-watch.test.mjs`, `scripts/scheduled/tasks.json`, `package.json`
- Do not touch: `scripts/github/local-review/prompt.mjs`
- Cost: ~20 sonnet calls/week (~$1.7/week)
- Needs Dave: Register CCv3-Review-Doctor (old decision 9, see decisions.md); the skill-doctor install is deferred (DP1.10, Dave 2026-11-09).

Scope: Weekly doctor modelled on scheduled-rule-router-review.ps1: scores, aggregate dry run, ratchet alerts. Watch: models and releases weekly, monthly research sweep to proposals. Draft PR only; Dave approves each. In package.json edit only the test:scripts line.

Done when: npm run test:scripts passes and names the doctor wrapper test (test:scripts line only). One manual doctor run on a fixture with one 2-PR cluster writes exactly 1 proposal, and on the three null fixtures writes 0. Artifact: .claude/cache/e2e/<date>-re-review-doctor.txt.

Why: Makes the loop run without a session.

### re-refs-impact

**Combined-plan P5.1/5.3: refs.mjs IMPACT.md, CONTEXT_VERSION and offline check** (wave 6, phase P5)

- Depends on: re-owners-hotspots, re-verifier, re-p4-wire, re-p4-ab
- Unblocks: re-p5-multirun
- Related: re-p5-multirun, re-p7-impact-arms, re-aggregate, re-seed-gold-b
- Owns: `scripts/github/local-review/refs.mjs`, `scripts/github/local-review/refs.test.mjs`, `scripts/github/local-review/context.mjs`, `scripts/github/local-review/context.test.mjs`, `scripts/eval/review-eval/impact-offline.mjs`, `scripts/checks/parser-fixtures/registry.mjs`, `scripts/github/local-review.mjs`, `scripts/github/local-review.test.mjs`
- Do not touch: `scripts/github/local-review/record.mjs`
- Cost: 0 cursor, 0 claude -p
- Needs Dave: Touches local-review.mjs ENGINE_FILES (trust boundary): the PR needs your merge yes.

Scope: refs.mjs runs in the main repo at headSha and applies TREE_EXCLUDES and AGENT_FILES. It ranks lanes in this order: same-file links, literal hits, git grep -w symbol hits, owners, a narrow importer lane, co-change, and mapped tests (through gatesFor). It caps output at 20 rows, about 2 KB, and never drops high-hit tokens. context.mjs gains a ranked IMPACT section, an optional CHECKLIST section (reads checklist.json when it exists) and export const CONTEXT_VERSION. In local-review.mjs edit only ENGINE_FILES: add refs.mjs, owners.json, hotspots.json and checklist.json in the same PR that context.mjs imports refs.mjs; a missing checklist.json hashes as absent on both sides. Tune the ranking on dev Majors (and Gold B when it exists) only. Run the holdout offline check once, at freeze.

Done when: The offline bar on the holdout, run once at freeze: the truth file is listed for 2 of 2 same-file Majors and 2+ of 3 cross-file Majors. Median 20 rows or fewer, under 5 s, 2 KB or less, 0 excluded files. A computeTrust test fails when refs.mjs differs from fork/main. impact-offline.mjs passes cli-smoke. Artifact: .claude/cache/e2e/<date>-re-refs-offline.json.

Why: Cross-file-dynamic recall is 0/6. The offline check costs $0 and gates online spend. Single owner of context.mjs through P6. Adding refs.mjs to ENGINE_FILES in the same PR closes the trust gap.

### re-p5-multirun

**Combined-plan P5.4/5.5: IMPACT in the review dir, union of 2 runs, hot-file pass, UNCERTAIN state (flags off)** (wave 7, phase P5)

- Depends on: re-p4-ab, re-refs-impact, re-owners-hotspots, re-p4-wire
- Unblocks: re-p5-online
- Related: re-p5-online, re-cr-rule2
- Owns: `scripts/github/local-review.mjs`, `scripts/github/local-review.test.mjs`, `scripts/github/local-review/trace.mjs`, `scripts/github/local-review/trace.test.mjs`
- Do not touch: `scripts/github/local-review/context.mjs`, `scripts/github/local-review/record.mjs`
- Cost: 0 cursor (stubs)
- Needs Dave: Trust-boundary file: the PR needs your merge yes.

Scope: writeReviewDir runs refs.mjs in the main repo. At HIGH/CRITICAL, run 2 runs with shuffled file and row order. Take their union (never vote), then run the verifier, and record UNCERTAIN Majors. Run one focused pass per changed hot file, with its checklist. Union, shuffle and the hot-file pass sit behind local_review.union_runs and local_review.hotfile_pass (code fallback off) until the P5 online arms pass. trace.mjs records runIds and shuffle seeds. refs.mjs is already in ENGINE_FILES (re-refs-impact).

Done when: An offline stub run with the flags on shows the union, the shuffle seeds and UNCERTAIN in the record. With the flags off, the record matches re-p4-wire output. Headless use stays under 200 a day on a normal day. Artifact: .claude/cache/e2e/<date>-re-p5-multirun.txt.

Why: Last holder of local-review.mjs; only after the verifier is kept. Flags keep the live engine (re-gate-shadow-run) unchanged until the online arms pass.

### re-p5-online

**Combined-plan P5 online arm 1: IMPACT (b) vs baseline (a)** (wave 8, phase P5)

- Depends on: re-p5-multirun, re-holdout-rotate
- Unblocks: re-p5-online-hotfile, re-loop-dryrun
- Related: re-p5-online-union, re-p5-online-hotfile, re-p7-impact-arms
- Owns: `.claudedocs/review-engine-p5-impact-results.md`
- Do not touch: `scripts/github/local-review.mjs`
- Cost: ~30 cursor runs; holds the Cursor eval slot
- Needs Dave: Approve ~30 Cursor runs (P5 budget scope).

Scope: Re-freeze the context version. Run arm (b) IMPACT against arm (a) baseline on the regression and capability suites, with its own paired bar. Score the fresh holdout once per frozen arm.

Done when: The results doc shows the paired bar for (b) vs (a) and no new false Major on the clean controls. Artifact: .claude/cache/e2e/<date>-re-p5-online-impact.json.

Why: Spend runs online only after the offline bar holds. One variable per arm.

### re-p5-online-hotfile

**Combined-plan P5 online arm 3 (runs before arm 2): hot-file pass (d) vs arm (b) (G1b)** (wave 9, phase P5)

- Depends on: re-p5-online
- Unblocks: re-p5-online-union
- Related: re-p5-online-union, re-p7-impact-arms, re-retire-prepr-cli, re-retire-critical
- Owns: `.claudedocs/review-engine-p5-hotfile-results.md`
- Do not touch: `scripts/github/local-review.mjs`
- Cost: ~20 cursor runs; holds the Cursor eval slot
- Needs Dave: Approve ~20 Cursor runs (P5 budget scope), then each live flag flip.

Scope: With local_review.hotfile_pass on in the eval only, run arm (d) against arm (b) on the hot-file subset (G1b), with its own paired bar. Report which P5 flags may turn on live; each live flip is one config PR after Dave's yes. OPEN (Dave): decide which P5 arm reports the flags that may turn on live.

Done when: The results doc shows the paired bar and no new false Major on the clean controls. Keep or kill is recorded. Artifact: .claude/cache/e2e/<date>-re-p5-online-hotfile.json.

Why: One variable per arm.

### re-loop-dryrun

**Combined-plan P6 pass bar: 4-week loop dry run** (wave 9, phase P6)

- Depends on: re-review-doctor, re-gate-shadow-run, re-p5-online
- Unblocks: re-p7-backlog
- Related: re-p7-backlog, re-retire-prepr-cli, re-retire-critical, re-p5-online-union
- Owns: `docs/self-improvement/proposals/review-engine-*`
- Do not touch: `scripts/github/local-review/prompt.mjs`, `scripts/github/local-review/checklist.json`
- Cost: ~10 cursor runs per accepted proposal; takes the Cursor eval slot
- Needs Dave: Approve each draft PR the loop opens and its minibatch runs.

Scope: Four weekly doctor runs on live and shadow rows. Each accepted proposal becomes a draft PR, minibatch gate k=2 on cluster PRs plus 2 clean PRs, then the full paired bar. Clusters use dev and regression rows only. Minibatch runs take the Cursor eval slot, so they never run at the same time as a P5 or P7 arm.

Done when: 4 weekly reports, and a week with 0 proposals reports NOTE, not PASS; every proposal cites 2+ PRs and trace lines; 0 policy-type and 0 coverage-win proposals; no gate used a judge under ~60 labels; artifact .claude/cache/e2e/<date>-re-loop-dryrun.txt.

Why: Proves the loop is safe before it changes the engine.

### re-p7-calibrated-cutoff

**Combined-plan P7.10: calibrated CodeRabbit cut-off wired into bandOf** (wave 9, phase P7)

- Depends on: re-demote-mechanism, re-gold-assemble, re-retire-critical
- Unblocks: none
- Related: re-retire-critical
- Owns: `scripts/eval/review-eval/cutoff-fit.mjs`, `scripts/eval/review-eval/cutoff-fit.test.mjs`, `scripts/github/review-router.mjs`, `scripts/github/review-router-band.test.mjs`
- Do not touch: `review-router.config.json`
- Cost: 0 cursor
- Needs Dave: The router is on the checkpoint path: the PR needs your merge yes.

Scope: Fit a logistic model on band, churn and fix history over ~50 frozen PRs. Wire r into bandOf behind routing.calibrated_cutoff (exists from re-cr-keys, default false; read with a code fallback of false). Report the misroute rate per band.

Done when: Misroute table per band on frozen PRs; flag off byte-identical; artifact .claude/cache/e2e/<date>-re-p7-cutoff.json.

Why: Finer routing after demotion. It runs after re-retire-critical decides, because it changes bandOf, which is in the band freeze set.

### re-p5-online-union

**Combined-plan P5 online arm 2: union of 2 runs vs a single run (HIGH/CRITICAL subset)** (wave 10, phase P5)

- Depends on: re-p5-online-hotfile
- Unblocks: re-p7-impact-arms
- Related: re-p5-online, re-p5-online-hotfile, re-p7-impact-arms
- Owns: `.claudedocs/review-engine-p5-union-results.md`
- Do not touch: `scripts/github/local-review.mjs`
- Cost: ~20 cursor runs; holds the Cursor eval slot
- Needs Dave: Approve ~20 Cursor runs (P5 budget scope).

Scope: With local_review.union_runs on in the eval only, run union-of-2 vs a single run on the HIGH/CRITICAL subset, with its own paired bar.

Done when: The results doc shows the paired bar for union vs single and the extra runs per PR. Artifact: .claude/cache/e2e/<date>-re-p5-online-union.json.

Why: One variable per arm. Union doubles cost, so it must earn its place alone.

### re-p7-backlog

**Combined-plan P7 trigger-gated items (coverage map, R6-R9, graph tool, session doctor)** (wave 10, phase P7)

- Depends on: re-loop-dryrun
- Unblocks: none
- Related: re-p7-impact-arms
- Owns: none
- Do not touch: `scripts/**`
- Cost: per item
- Needs Dave: Any graph-tool install. It is an open decision of the combined plan (`.claudedocs/2026-11-04-review-engine-combined-plan.md`, section 5, item 5). The 11-05 map named it CP:79.

Scope: Holder card. Open a new lane per item only when its trigger fires:
- 7.5 V8 coverage map. Trigger: re-test-escapes shows 2 or more escapes in 4 weeks of the cause class this item covers.
- 7.6 per-file units for diffs over 150 lines
- 7.7 HISTORY.md
- 7.8 decision memory (bar: 10% or less recur)
- 7.9 Stryker/fast-check hints. Trigger: re-test-escapes shows 2 or more escapes in 4 weeks of the cause class this item covers.
- 7.11 graph tool, only after 2+ not_in_impact misses on a static edge that tsc missed
- session doctor: a read-only skill-doctor-style pass over session transcripts as outer-loop stage 2; install stays deferred

Done when: Each fired trigger has its own lane id recorded in this card's notes; no item built without its trigger.

Why: Avoids building ahead of data.

### re-p7-impact-arms

**Combined-plan P7.1-7.4/7.12: summary block, open-each-row line, impact_checks[], top 1-3 snippets (A/B arms)** (wave 11, phase P7)

- Depends on: re-p5-online-union
- Unblocks: none
- Related: re-refs-impact, re-finder-v2
- Owns: `scripts/github/local-review/context.mjs`, `scripts/github/local-review/prompt.mjs`
- Do not touch: `scripts/github/local-review.mjs`
- Cost: ~20-40 cursor runs; takes the Cursor eval slot
- Needs Dave: Approve the Cursor runs per arm.

Scope: One variable per arm against arm (b). Never top-5 snippets or whole code bodies. Each arm takes the Cursor eval slot.

Done when: Per arm: recall not down, false Majors not up, no new timeouts, as a results table; artifact .claude/cache/e2e/<date>-re-p7-arms.json.

Why: Later, on data only. Last holder of context.mjs and prompt.mjs.

## External lanes

Two lanes on the path are not `re-` lanes (T08). They have a card on the continuous-claude board and no row in the Waves table. Before the premortem neither had a section, a band, an owner or a done check. The facts below come from the board cards as read on 2026-11-09. Both "Done when" texts are new texts of this map, because both cards have no done check. Dave decided DP1.13 on 2026-11-09: both lanes get band P1 and a review-engine worker as owner, the done checks below stand, and the program claim rules apply. [Speculation: the journal names no rule list; this map reads it as the rules in "How to use this map".] The band, the owner and the done checks are not applied to the lane DB yet; apply them at the seed step after a fresh kanban-sync (Board actions 13). DECIDED (Dave, 2026-11-10): both cards are in state `blocked`, as the 48 old `re-` cards. This state change is applied to the lane DB (2026-11-10). Both lanes open with wave 0 at GO. The sections of the lanes that depend on them stay as they are.

### force-high-security-tier

**External: force band HIGH when a PR changes a security-tier file or review-router.config.json** (counts as wave 0, external; card state `blocked` since 2026-11-10, before that `backlog`)

- Depends on: none
- Unblocks: re-cr-keys, re-gate-ready-a
- Related: re-cr-rule2, re-cr-trustlist
- Owns: `review-router.config.json` (bands and matrix blocks), `scripts/github/review-router.mjs` (bandOf), with the router tests for that change. Card scope for all three.
- Do not touch: the coderabbit.* keys, `scripts/github/pr-checkpoint.mjs`, `scripts/github/local-review.mjs` [Speculation: the card names no such list]
- Cost: 0 cursor, 0 claude -p [Speculation: the card names no cost]
- Needs Dave: merge tap (review-router.mjs is checkpoint.critical). Dave 11-03: a separate PR, decided with the count of past PRs that the rule would raise. Band and owner (DP1.13, decided): P1, a review-engine worker.

Scope (from the card): force band HIGH when a PR changes a security_tier file or review-router.config.json, so a PR with review:none cannot weaken the land gate. The card title names the source finding.

Why it is on the path: it is an ancestor of both retire gates, with 17 dependents (16 before the `re-gate-ready` split). It is the first holder of review-router.config.json and of review-router.mjs in the owner chains. It changes bandOf, which is in the band freeze set, so it must land before a counted CRITICAL week. DECIDED (Dave, 2026-11-10): the card is in state `blocked` (applied 2026-11-10), so `next` does not offer it. It opens with wave 0 at GO.

Done when (stands, DP1.13): A router test shows band HIGH or higher for a PR that changes a security_tier file, and for a PR that changes review-router.config.json, each with review:none set. Router output on every other existing fixture is byte-identical. The count of past PRs that the rule would raise is saved for Dave. The lane is marked done with the landed SHA. Artifact: `.claude/cache/e2e/<date>-force-high-security-tier.txt`.

### hf-judge-precheck

**External: HF step A, judge sameIssue pre-check on Code Review Bench human pairs** (counts as wave 0, external; card state `blocked` since 2026-11-10, before that `ready`)

- Depends on: none
- Unblocks: re-gold-c-external, re-judge-calibrate
- Related: re-claude-backend, re-gold-c-external, re-judge-calibrate
- Owns: `scripts/eval/review-eval/external-judge*.mjs` (with its test), `.claude/cache/hf-datasets/` (gitignored) (card scope)
- Do not touch: `scripts/eval/review-eval/judge.mjs`, `scripts/eval/review-eval/gold/**` [Speculation: the card names no such list]
- Cost: 0 Grok runs; 40 to 60 headless judge calls. The day plan gives it 8 a day on type B days. The card says 10 a day; the day plan wins.
- Needs Dave: no new yes for the runs (Dave approved step A on 11-02, decision 2 of the HF plan). Band and owner (DP1.13, decided): P1, a review-engine worker.

Scope (from the card and `.claudedocs/2026-11-02-huggingface-review-data-eval.md`, sections 3.2 and 3.3, step A): judge a sample of 40 to 60 pairs of human_annotations_task1. It calibrates sameIssue only. Agreement on `real` is reported as not measured, because the rows have no path or line. Use plain HTTPS GETs and pinned files, no HF MCP server. Keep the HF token in Credential Manager only.

Why it is on the path: it is an ancestor of `re-retire-critical`, with 24 dependents (23 before route J added `re-retire-prepr-cli`; counted by hand from the table), through `re-judge-calibrate` and `re-gold-c-external`. Route J is decided (DP1.8), so it is also an ancestor of `re-retire-prepr-cli`. DECIDED (Dave, 2026-11-10): the card is in state `blocked` (applied 2026-11-10), so `next` does not offer it. It opens with wave 0 at GO.

Done when (stands, DP1.13): The judge has a verdict on 40 or more pairs. The report prints n, the agreement with the human labels and kappa for sameIssue, and "real: not measured". The external-judge test passes. The lane is marked done with the landed SHA. Artifact: `.claude/cache/e2e/<date>-hf-judge-precheck.json`.

## Board actions

Dave answered DP1 on 2026-11-09 (decisions journal). Items 2, 4, 7, 8, 12 and 13 are APPROVED actions. Each one is applied to the lane DB: item 4 on 2026-11-10, the others on 2026-11-11 at the seed step, after a fresh kanban-sync with 0 pending changes. The other items are as before. All `re-` cards stay `blocked` until GO, wave 0 included (confirmed by Dave, 2026-11-09; item 3). Order: kanban-sync first (F0), then read the live board, then act. Dave's tap 2 of 2026-11-09 sets the card rule in items 3 and 4.

1. Run the `kanban-sync` skill again before any band change. The dry run on 2026-11-09 at 18:10 CST showed 0 pending changes (session pika #01895057).
2. APPROVED (DP1.1, Dave 2026-11-09). Applied to the lane DB on 2026-11-11 (Dave confirmed it by tap). The rank inside the band comes from the rank file of the seed, not from the order of this list. Bands P1 for 13 lanes, in this rank (F1): (1) `re-live-advisory`, (2) `re-land-ledger`, (3) `re-test-globs`, (4) `re-critical-model-check`, (5) `re-gold-schema`, (6) `re-eval-contract` (claimable after `re-gold-schema`), (7) `re-dispositions`, (8) `re-finder-v2`, (9) `re-verifier`, (10) `re-engine-seam`, (11) `force-high-security-tier`, (12) `hf-judge-precheck`, (13) `re-test-escapes`. `engine-trusted-findings` is off this list (T08): three `re-` lanes adopt its items (item 12). No P0. Promote later lanes to P1 when their dependencies are done. At most 3 `re-` lanes in work.
3. Cards (Dave's tap 2). Every map lane keeps a card. Create cards for the 14 new active lanes (`re-live-accrual` is the 14th, see item 14), the deferred `re-property-tests`, and the two halves `re-gate-ready-a` and `re-gate-ready-b`, with their Depends on from the Waves table. A lane with open dependencies stays in state `blocked` now. After T2.1 it moves to `backlog` with stored edges. A lane with a "Held until" token stays `blocked` until the hold ends. A wave 0 `re-` lane (no open dependency) also stays `blocked` until Dave's GO tap; then `sync-board` moves it to `backlog` (confirmed by Dave, 2026-11-09: all `re-` cards stay `blocked` until GO, wave 0 included; one script moves wave 0 to `backlog` at GO; orchestration plan, section 3.3). No new lane state is added.
4. APPROVED (Dave's tap 2 and his answer on the old card, 2026-11-09). Applied to the lane DB on 2026-11-10 (Dave's tap). Close the 3 dropped lanes `re-runbook-docs`, `re-holdout-record` and `re-cr-retire-gate`, each with the note 'DROPPED map v2' and where its work went (Dropped table). No other map lane closes. Cards that are not map lanes close under this item (the old card below) and under items 7, 8 and 12.
   - The old `re-gate-ready` card. After the split it is not a map lane, and it is not one of the 3 dropped lanes. Mark it done with the note "SPLIT map v2: see re-gate-ready-a and re-gate-ready-b". Remove all its edges first, so no lane depends on it and the done mark meets no dependency.
5. Deferred lanes: leave at P2 with a note "deferred: <trigger>" from the Deferred table.
6. Edges: remove `scheduler-child-safe-and-wake` from `re-l1-schedule`. Remove `scanner-tuning` from `re-prepr-bundle`. Add `re-gold-schema` to `re-eval-contract`. Remove `re-refs-impact` from `re-p4-wire`. Add `re-retire-critical` to `re-p7-calibrated-cutoff`. Replace `re-gate-ready` with `re-gate-ready-a` and `re-gate-ready-b` in `re-demote-mechanism`, `re-rule-docs` and `re-retire-critical`. Apply every other Depends on change from the Waves table. Dave answered DP1.5, DP1.8 and DP1.18 on 2026-11-09, so write these edges too: `re-judge-calibrate` and `re-live-accrual` on `re-retire-prepr-cli`, and `re-live-accrual` on `re-gate-shadow-run`. Neither lane gets an edge to `re-live-advisory`. Write no edge from `re-p4-ab` to `re-retire-prepr-cli` (path W is not chosen).
7. APPROVED (DP1.11, Dave 2026-11-09). Applied to the lane DB on 2026-11-11. Mark `trex-t1-core` and `trex-t2-bench` done. Keep the worktrees.
8. APPROVED (DP1.12, Dave 2026-11-09). Applied to the lane DB on 2026-11-11. Mark `reviews-7d-refresh` and `autoconfirm-enable` done.
9. scanner-tuning: note that it keeps only the zizmor and opengrep items and no longer holds pre-pr.mjs.
10. Drift notes before claim on 4 cards (F4):
    - `re-land-ledger`: five land-pr test scripts, not four; -IgnoreReview never skips a red CI check (1a78c5ca); land-decision.mjs exists (5f27ec2d).
    - `re-gate-ready-b`: the same three facts.
    - `re-cr-rule2`: autoConfirm is "low" since 11-06; reviews_7d_manual is a fallback only since 11-06; matrix.control_plane already lists prompt.mjs and context.mjs; keys and trust lists moved to `re-cr-keys` and `re-cr-trustlist`.
    - `re-prepr-bundle`: 18 pre-pr.mjs commits since 11-05; the no-files skip landed 11-06 (43461fe0); globs moved to `re-test-globs`; the scanner-tuning edge is gone.
11. Lane notes hold counts and paths only. No holdout or gold PR ids.
12. Adopted cards (T08). These cards are not map lanes. A `re-` lane adopts the work of each one, and all were in state `backlog` until 2026-11-11, so a session could claim one and edit a file that the adopting lane owns. APPROVED (DP1.19, Dave 2026-11-09). Applied to the lane DB on 2026-11-11: the 6 cards are done. The rule was: mark each of the 6 cards done with the note "ADOPTED map v2: <adopting lane>":
    - `engine-trusted-findings`: `re-engine-cli-schema` (local-review.mjs and record.mjs items), `re-cr-rule2` (review-router.mjs item), `re-prepr-bundle` (pre-pr.mjs item).
    - `review-status-marker-only-body`: `re-gate-ready-a`.
    - `prepr-fixes-build`, `prepr-no-files-skip`, `pre-pr-auth-fail-cap`, `cli-spend-polish`: `re-prepr-bundle`. [Speculation: the four names come from the Related list of the 11-05 `re-prepr-bundle` section, which says "the four adopted lanes".]
    - No lane depends on these cards, so the close meets no dependency. Dave's tap 2 names only the 3 dropped map lanes. The close of these 6 cards, which are not map lanes, has its own answer: DP1.19. It is not part of the DP1.1 yes.
13. APPROVED (DP1.13, Dave 2026-11-09). The band is applied to the lane DB on 2026-11-11. External lanes (T08): set band P1 on `force-high-security-tier` and `hf-judge-precheck` (ranks 11 and 12 of item 2), set a review-engine worker as owner when one claims the lane under the program claim rules, and write the done check from "External lanes" on each card. Until the seed, a note on both cards says that the lane is on the review-engine path. DECIDED (Dave, 2026-11-10): both cards are in state `blocked`, as the 48 old `re-` cards. This state change is applied to the lane DB (2026-11-10), so `next` offers neither. Both open with wave 0 at GO. They have no Waves row, so the GO step of `program.mjs sync-board` must name them and move them to `backlog` too. The card `brief-bare-wait-dave` stays `blocked` at GO; `re-szz-miner` releases it. The band is applied (2026-11-11). The owner is set when a worker claims the lane. The done check is a note on each card that points to "External lanes".
14. New card `re-live-accrual` (DP1.18, Dave 2026-11-09). Applied on 2026-11-11: the seed made the card, and both notes are written. The rule was: create it with Depends on `re-live-advisory`, state `blocked` (open dependency; the DP1.2 hold ended on 2026-11-09), and the done check from its section. The `re-live-advisory` card keeps its id and gets the build-lane done check. Note on both cards: "SPLIT map v2 (DP1.18)". `re-live-accrual` is not in the P1 rank list of item 2; promote it to P1 when `re-live-advisory` is done.
15. DECIDED (Dave, 2026-11-10; DP1.9). The card `brief-bare-wait-dave` is in state `blocked` since 2026-11-10, with the note "held: DP1.9 gold candidate; re-szz-miner releases it". This state change is applied to the lane DB (2026-11-10). The card is not a map lane, so it has no Waves row. `re-szz-miner` releases it after gold-a.json records the bug.
16. New card `re-answer-key-audit` (Dave's yes, 2026-11-11). Create it in state `blocked`, with no Depends on and the done check from its section. Store its 4 edges: `re-live-advisory`, `re-seed-gold-b`, `re-verifier-replay` and `re-p4-harness` depend on it. Until the board holds them, `sync-board` writes nothing (`edges-differ`). Then run `program.mjs check --board`. The card has no dependency, so `sync-board --apply` then moves it from `blocked` to `backlog` (the program state is GO). Band P1 (Dave, 2026-11-11).
## Not covered / risks

- B1 is not applied as written. B1 keeps `re-repromote-auto` on the CLI track. That lane pulls `re-demote-mechanism`, `re-gate-ready-a` and `re-gate-ready-b` onto the track. (`re-engine-cli-schema` is on the track already under route J.) Here the CLI re-promotion lives in band-state.mjs in `re-prepr-cli-consumer`. `re-repromote-auto` adds the PR-bot triggers later.
- The CRITICAL date depends on sample accrual: about 17 PR-bot PRs a month at most, and no paid PR-bot row since 11-04. At a 5% bound that is about 3.5 months of sample.

- The CLI gate goes first while the CLI is the one CodeRabbit check that runs today (finding 27). The bar decides, but a flip removes the only live CodeRabbit signal. The band-state triggers bring it back only after an escape ships.
- With P5 and `re-refs-impact` deferred, no gating row tests cross-file recall unless the DP2.4 trigger fires. Cross-file is 0 of 6 today.
- Path F counts rows from a pinned engine copy. The copy shows trusted:false once fork/main moves, and the pin path through `--engine-sha` is not yet proven [Speculation]. The `re-live-advisory` done check must prove it.
- The no-files refusal. Since `re-critical-model-check`, cursor-review.mjs refuses a target whose every changed file is excluded (exit 2, reason word `no-files`, export NO_FILES). replay.mjs records that as failed, cli.mjs stops an `--all-majors` batch on it, and shadow.mjs calls the round an engine failure. `re-shadow-retro` maps the reason to a skip in shadow.mjs before its first retro round. `re-p4-harness` maps it in replay.mjs and cli.mjs before a batch run. local-review.mjs has no such guard: a `risk:high` PR with every file excluded still starts the engine agent on an empty list; `re-gate-ready-a` must refuse it.
- Answer-key reads by absolute path. `re-answer-key-audit` sees only what the stream shows. A read that leaves no tool call event is not seen. A void takes its round out of the counted set, so many voids on hard rounds would bias a sample: each counted artifact prints the void count, and a batch with a void is NOTE until the seat has read the stream. The Claude backend stream is not audited; DP1.6 plans no counted Claude run.
- The paired-bar size and the real-label calibration are OPEN. Neither is solved here.
- `re-rule-docs` is not in the CLI gate closure. Until it lands, the rule file does not describe the CLI demotion. pre-pr prints the "demoted" SKIP line as the stopgap.
- The two gate lanes share review-router.config.json with no dependency edge. A hold token orders them (O6: `re-retire-critical` holds `re-retire-prepr-cli`).
- The fresh-holdout cost in `re-p4-winner-evidence` depends on the holdout size; the run count is an estimate.
- The phase 4 run count is now a formula (T04), and its floor passes the P4 scope of 120 with the other P4 lanes. DP1.16 is decided: cut the design to fit 120. DECIDED (Dave, 2026-11-10): the cut has 15 or more controls, and bar row 8 of `re-retire-critical` asks for that count. The other numbers of the cut are not decided. The map gives no lane sizes, so no flip date is given.
- The Cursor pool share is unmeasured (T13). The pool is weekly, additional usage is disabled, and the 152 engine starts of 11-02 to 11-04 cost $0 (facts of 2026-11-09, "Capacity plan / Cursor"). The percent that the engine week used is unknown. The 100 live cap and the 240 stop are our own numbers until the first sweep week measures the share. A run past the pool fails, so a full pool stops the sweep and every other Cursor use of that week. DP1.2 is decided: Dave approved the caps as our own numbers, and no cap goes up before the share is known. The measurement itself is still to do.
- PR-bot use since 11-05 is unverified (free-slot reviews are not in the paid ledger).
- The kanban-sync dry run on 2026-11-09 at 18:10 CST showed 0 pending changes. Edits Dave makes on the board after that time are not in this map.
- The headless day plan assumes non-RE use stays at 6 a day or less. No check enforces the RE slots except each lane's ledger read.
- Weak done checks remain on `re-p7-backlog` (deferred). The `re-scoreboard`, `re-p4-wire`, `re-delta-wire` and `re-demote-mechanism` checks are tightened here; `re-loop-dryrun` gets the NOTE rule.

Added by the premortem (2026-11-09). These risks stay open after the edits:

- Pass forecast (E01). At today's recall of 0.5 a 5% bar row passes with a chance of 16% or less. The v1 engine will most likely not flip the CLI band. Dave chose path F with this note (DP1.5, 2026-11-09). The stop rule is DP2.8; Dave asked for it at DP1.5.
- CRITICAL supply (E02). The CRITICAL gate needs about 60 PR-bot reviews that count only after `re-p4-winner-evidence` is done on the frozen version (wave 7). The paid ledger has no PR-bot row since 11-04, and nobody owns a paid sample. DP1.14 is decided: CRITICAL stays on the CodeRabbit PR bot under the interim rule for now. The paid sample, its owner and its budget wait until `re-p4-winner-evidence` is done on the frozen version. DP1.3 (no PR bot on `re-` PRs) lowers the supply more.
- Sweep sample (T03). The run on an earlier head and withholdBody through the pinned copy are not proven [Speculation]. Until the `re-live-advisory` done check proves them, the CLI gate sample misses most CLI Majors. The 2-week check on the sample is in `re-live-accrual`.
- Coverage (T05). Bar row 7 cannot pass for every band under a live cap of 100 while the CLI reviews about 430 heads a week.
- Per-head rule under path F (T05, found while the fix was applied). Under the first rule (2026-11-09) the CLI was skipped only for a head with an engine record of the counted engineVersion. Under path F the counted version is the pinned copy. `re-engine-seam` and `re-engine-cli-schema` change the reviewer set before the flip, so a live record never carries the counted version. Under that rule the skip and bar row 7 covered only heads that the pinned copy reviewed, and the sweep reviews a head after its pre-pr run. A flip under path F would have skipped few CLI runs. DECIDED (Dave, 2026-11-10; point (a) of "Open after DP1"): the skip is allowed for a record from the pinned copy, or from a later version that a done check proves equal on the default path (same prompt sha and model). The phase 4 winner needs its own window. Risk that stays: a later version with no such proof gives no skip. Under route J (DP1.8) `re-engine-seam` and `re-engine-cli-schema` land before the flip. The done check of `re-engine-seam` names the same prompt sha, and it does not name the model. The done check of `re-engine-cli-schema` does not state the proof yet.
- Model labels (E04). Every "real Major" label is a model label. The only two-rater kappa so far is 0.649 at n=22. Gold A and Gold B are the only outcome truth.
- Tripwire (T19). The CLI-band triggers are not calibrated before `re-prepr-cli-consumer` replays them. A fix in a file that the guilty PR did not change gives no escape row.
- READY under path F (T21). Pinned-copy records cannot feed READY. READY needs live-engine runs, which cost live starts beside the counted sweep.
- External lanes (T08). DP1.13 is decided: band P1, a review-engine worker as owner, the map's done checks. The band is applied since 2026-11-11; the cards of `force-high-security-tier` and `hf-judge-precheck` get an owner at the claim. DECIDED (Dave, 2026-11-10): both cards are `blocked` (applied 2026-11-10), so `next` offers neither.
- Old card (T14, tap 2). Dave's answer of 2026-11-09: mark the old `re-gate-ready` card done with the SPLIT note. Applied on 2026-11-10.
- Adopted cards (T08). DP1.19 is decided: mark the 6 adopted cards done. Applied on 2026-11-11.
- Long lane on the path. Dave split `re-live-advisory` (DP1.18, 2026-11-09). The long lane is now `re-live-accrual`: it stays open for 2 weeks or more, and only `re-retire-prepr-cli` and `re-gate-shadow-run` wait on it by edge. The owner of its daily sweep is decided (DP1.17): the coordinator seat for the first 2 weeks. The CLI gate counts at least 4 weeks, and the accrual check covers 2. A scheduled task after the first 2 weeks needs Dave's own yes. DECIDED (Dave, 2026-11-10): the seat keeps the daily sweep until that yes.
- Frozen SHA (DP1.5). Point (b) of "Open after DP1" is decided (Dave, 2026-11-10): the `main` SHA right after `re-critical-model-check` lands. The coordinator recorded the value on 2026-11-11 (`decisions.md`, "Open after DP1", point (b)). Cost shown to Dave: the first ask moves 2 rounds later.
- Route J cost (DP1.8). The CLI flip now waits for 21 lanes, with two gold lanes, `hf-judge-precheck`, the two P4 prefactor lanes and `re-answer-key-audit`. `re-seed-gold-b` is a long lane (60 seeds at 8 a day take 8 days or more).
- Dave's load (E03). The decision points hold 36 items. DP1 is answered, so 17 remain (DP2 and DP3). The orchestration plan holds the rest of that finding (several lanes per PR, 2 workers at GO, the "waiting on Dave" list).
