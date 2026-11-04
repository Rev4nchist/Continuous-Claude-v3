# Review engine: combined build plan (2026-11-04)

Inputs:
- Team 1: `C:\Users\dkhay\continuous-claude\.claudedocs\2026-11-04-review-engine-research.md` (vendors, open source, papers, testing, context, eval ops).
- Team 2: `C:\Users\dkhay\continuous-claude\.claudedocs\2026-11-04-review-engine-graph-and-selfimprove.md` (code graph, PR impact, self-improving loop from Warp skill-doctor).
- Dave's decisions 11-04: the target is no CodeRabbit. In the short term, CodeRabbit runs only above a HIGH/CRITICAL threshold. The interim CodeRabbit rule is adopted. The eval budget goes up a little. ultrareview is never used (cost).

## 1. Answer first

- The prior cursor-review baseline misses most real bugs. Its same-issue recall was 1 of 10 on the holdout and 0 of 12 on the dev set. These runs came from `cursor-review.mjs`. The harness had not yet run the engine itself (phase 1 adds that run).
- Most misses are not cross-file. 17 of 22 real Majors sit in the changed hunk or the same file, and 0 needed a call graph (team 2 §1). So the first build aims at in-file logic, not at a code graph.
- The engine deletes its own findings before we see them (`scripts\github\local-review\prompt.mjs:61`, "disprove each finding"). We cannot see where the misses go until we log the funnel (team 1 R0).
- The plan:
  1. Measure first: log the funnel and the trace of what the reviewer read.
  2. Add $0 deterministic catchers for the in-file class: type checks, mapped tests, CLI smoke runs, hostile-input fixtures.
  3. Build a CodeRabbit-free answer key with 50 or more real Majors.
  4. Split the work into a finder and a refute-only verifier, and test prompt x model.
  5. Add a small, ranked impact list (`git grep` reference map), not a graph service.
  6. Close the loop: rubrics, cause per miss, batch proposals, gated draft PRs, score history (skill-doctor pattern).
- This review loop is the first outer-loop pilot for the CCv3 software factory. Testing and implementation sessions reuse the same spine later (team 2 §4).

## 2. Where the two reports differ, and the call

| Topic | Team 1 | Team 2 | Call |
|---|---|---|---|
| Main recall lever | Context pack (R5) high | Same-file and in-hunk logic first; cross-file reaches about 3 of 19 misses | Team 2. Its claim rests on our own 22 Majors, though one agent labelled them. Phase 1 saves the labels with a second rater, and the order is checked against that. |
| Code graph | No graph tool for the agent; inject a list | Same, plus remove tldr (no JS call graph, exit 0 on error) | Agree. `git grep -F` reference map, 20 rows, about 2 KB. |
| Multi-pass support | R4 cites SWR-Bench | SWR-Bench does not support "union of 2" | Keep R4 as a test arm only. Drop the citation. |
| Metric | Mixed line and same-issue recall | Same-issue only | Same-issue recall only. Line recall is never a lift. |
| Paid alternatives | ultrareview, Bugbot arms | none | Dropped. Dave: no ultrareview. No Bugbot. |

## 3. Phased build plan

Each phase is one lane and one PR. Each PR is tested on `C:\Users\dkhay\continuous-claude\scripts\eval\review-eval\`. Pass bars use same-issue recall and the paired bar from team 1 §3.7: the lower bound is above -5 pts on regression and above 0 on capability, with no caught Major lost and no rise in false Majors on clean controls.

| Phase | Work (source) | Main files | Pass bar | Cursor runs |
|---|---|---|---|---|
| **1. Measure** | Funnel logging with `withdrawn[]` (T1 R0). stream-json trace, `trace.mjs`, condensed.md (T2 G0/L0). Remove tldr from the review path. Kappa gate in `score.mjs` (n 30 or more). `perClassRecall`. Record the cursor-agent version and the judge model. Save the 22-Major `linkType` labels with a second rater from another family. Start `shadow.mjs retro`. **Interim CodeRabbit rule** in `routeBand`: CRITICAL plus a trust-boundary file, or a `risk:high` label; skip docs-only PRs; stop at 160 files a month. | `local-review.mjs` (:331-338, :602, :642, :690), `local-review\prompt.mjs`, `record.mjs`, `context.mjs`, new `trace.mjs`, `score.mjs`, `dataset.mjs` | 100% of runs have funnel counts and `filesRead`. The scorecard prints n, kappa and per-class recall, and reproduces 1 of 10 holdout. Route test: only rule-1 and rule-3 PRs go to CodeRabbit. | about 26 |
| **2. Deterministic catchers** | `tsc --noEmit --checkJs` on changed `.mjs`, tests mapped from `test-map.mjs` (T1 P1). CLI smoke run for changed scripts, and hostile-input fixtures for changed parsers (T2 T1). Results go to the reviewer as facts, and gate as checks. | new `scripts\checks\cli-smoke.mjs`, parser fixture lists, `context.mjs`, `test-map.mjs` | Smoke run fails on PR 211 pre-fix. Fixtures fail on 3 or more of the parser Majors (200, 211, 221, 222). 0 failures on the 11 clean PRs. Errors are reported only on changed lines. | 0 |
| **3. Answer key** | Gold A: SZZ miner on top of `escape.mjs` (15-35 real pairs). Gold B: seeded bugs, Claude-written, kept only when a test breaks, including same-file and cross-file kinds (60-100). Gold C: Qodo and AACR slices, never tuned on. 30 or more clean controls. `dispositions.mjs` and a land-outcomes ledger line in `land-pr.ps1` (T1 P2, T2 L1). | new `mine-szz.mjs`, `seed.mjs`, `dispositions.mjs`; `external-pull.mjs`, `config.json`, `land-pr.ps1` | 50 or more gold Majors across A, B and C. Every Gold B bug breaks a test or a probe. Regression and capability suites are split. | 0 (seeding on `claude -p` within the headless cap) |
| **4. Finder + verifier** | Finder v2 without self-disprove, plus a refute-only `verify.mjs` (T1 R1). Precision wording from R2. Run as a 2x2: prompt v1/v2 x Grok 4.7 / one Claude model on `claude -p` (T1 R3). Screen at 1 run per cell, then 2 runs on the leading pair. | `prompt.mjs` (v2), new `local-review\verify.mjs`, `record.mjs`, `replay.mjs` | Paired bar. Clean false-Major rate no worse than 9 of 11. | about 60 (Grok arms only) |
| **5. Impact and hot files** | `refs.mjs` IMPACT.md: same-file links first, then literal and symbol hits, `owners.json` from dev PRs only, co-change, mapped tests; rank and cap at 20 rows (T2 G1). Offline check first, $0. Focused pass per changed hot file with a state-and-event checklist (T2 G1b). Union of 2 runs plus verifier at HIGH/CRITICAL (T1 R4). **CodeRabbit rule 2**: an UNCERTAIN Major after the verifier at HIGH/CRITICAL. | new `local-review\refs.mjs`, `owners.json`, `hotspots.json`; `context.mjs`, `local-review.mjs`, `review-router.mjs` | Offline: IMPACT.md lists the truth file for 2 or more of 3 cross-file holdout Majors and 3 or more of 4 same-file ones. Online: paired bar. | about 50 |
| **6. Self-improving loop** | Rubrics in git (missed-bug, miss-cause with `in_diff_logic`, false-positive, severity, citation, context-reach, test-value). `judge-calibrate.mjs`. `review-scores.jsonl` with version-change alerts. `aggregate.mjs`: a proposal only from 2 or more PRs (3 or more for a prompt edit). `checklist.json` with ids and counters merged by Node, never rewritten by an LLM. Weekly CCv3-Review-Doctor task. Weekly model and release watch, and a monthly research sweep (T1 §5, T2 L2, L3). | new `rubrics\*.md`, `judge-calibrate.mjs`, `scores.mjs`, `aggregate.mjs`, `checklist.json`, `.claude\scripts\scheduled\scheduled-review-doctor.ps1`, `review-engine-watch.mjs` | No gate uses a judge below about 60 labels. A 4-week dry run: every proposal cites 2 or more PRs and trace lines, and 0 are policy-type. | about 10 per accepted proposal (minibatch), 40 for the full gate |
| **7. Later, on data** | A/B arms: summary block, `impact_checks[]`, top 1-3 code snippets, V8 coverage map (T2 G2). Per-file units for diffs over 150 lines (T1 R6). History feed (R7). Decision memory for the verifier (R8). Stryker and fast-check hints (R9). Calibrated CodeRabbit cut-off fitted on past PRs (T1 §4). A graph tool only when the loop logs 2 or more `not_in_impact` misses on a static edge that tsc missed (T2 G3). | per item | per item | about 20 to 40 |

Order: phases 1 and 2 first (cheap; they aim at the large in-file class). Phase 3 must reach 50 gold Majors before phase 4 makes any keep-or-kill call.

## 3a. Seed the loop with the last two weeks (Dave 11-04)

Source data (counted 2026-11-04): 99 merged PRs (#188-#288) since 2026-10-21, their CodeRabbit and Greptile review threads, fix commits, land records, and 59 session transcripts in `~/.claude/projects/C--Users-dkhay-continuous-claude/`.

| Seed | From | Feeds | Phase |
|---|---|---|---|
| Real Majors with dispositions (fixed, won't fix, wrong) | PR review threads and "Fixed in <sha>" replies (`dispositions.mjs`) | Gold A candidates, R8 decision memory, false-positive rubric | 3 |
| Escapes: bugs fixed after merge, blamed back to the PR that added them | Fix commits since 10-21 (`escape.mjs`, `mine-szz.mjs`) | Gold A, miss-cause rubric | 3 |
| Engine replays on past PRs | `shadow.mjs retro` (capped at 40) | First trace and score rows, per-class recall | 3 (needs the phase 1 trace) |
| Hot-file notes and checklist bullets | Dev-split PRs only (never holdout) | `hotspots.json`, `checklist.json` | 5, 6 |
| Session efficiency and verbosity scores | Read-only skill-doctor-style pass on the 59 transcripts | Second outer-loop stage (implementation sessions) | 6 |

Rules: seeds from holdout PRs never enter notes, checklists or owner maps. The first aggregate run is a dry run on the seeded rows. It writes proposals as files only.

## 4. Eval budget

- Today `cursorEvalBudget` is 80 runs per phase (`scripts\eval\review-eval\config.json:10`).
- Phases 4 and 5 need about 60 and 50 Grok runs, plus re-runs when a screen is close.
- Proposal: raise it to **120 runs per phase** (about $115 at list rate on the Cursor subscription pool). Claude arms run on `claude -p` within the 30-a-day headless cap.

## 5. Decisions for Dave

Already decided 11-04: the interim CodeRabbit rule (yes), the eval budget goes up a little, no ultrareview.

Decided 11-04 (Dave, "yes to all"): budget 120, remove tldr, gate on smoke runs and fixtures, land ledger line. Items below stay for the record.

Open:
1. Eval budget: raise `cursorEvalBudget` from 80 to 120 per phase? Recommendation: yes.
2. Remove tldr from the review path? Recommendation: yes. It has no JS call graph, and an error can pass as success.
3. Gate on the CLI smoke runs and parser fixtures, not only feed them to the reviewer? Recommendation: yes. A crash is not a policy opinion, so this does not repeat the TREX noise problem.
4. Add one line to `land-pr.ps1` for a land-outcomes ledger? Recommendation: yes.
5. Later, at their phase: registering scheduled tasks (confirm-first), the skill-doctor pilot install (the package guard asks), and any graph-tool install (only on the phase 7 trigger).

## 6. What not to do (merged)

- No TREX revival. No majority voting. No paid reviewers (ultrareview, Bugbot).
- No graph service or graph tool for the agent first. No RAG first.
- Do not push the finder harder without the verifier.
- Do not quote line recall as a lift. Do not tune on external holdouts. Do not seed from holdout PRs. Rotate the holdout each quarter.
- Do not judge a reviewer with its own model family. Do not ask Dave to label findings.
- Do not let the loop rewrite `prompt.mjs` whole or self-update without ground truth. One change per proposal, Dave approves each draft PR.
