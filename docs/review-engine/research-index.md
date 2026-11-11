# Review-engine research index

The folder `.claudedocs/` is outside git. It exists only on this machine. It has no history and no review.
`docs/review-engine/` is in git. When the two disagree, `docs/review-engine/` wins.

This file lists every review-engine document that a session could mistake for the current plan. Each row has one mark.
Paths are relative to the repo root.

## Marks

- **in force**: read it and follow it.
- **superseded by <file>**: do not follow it. Read the named file instead.
- **record**: history or evidence. It is never a plan. Cite it. Do not follow it.
- **record (unclear)**: the sources do not settle the mark. Treat it as a record until Dave or the coordinator decides. Section "Open marks" names each one. No row has this mark today.

Dates come from the file name or the file head.

## In force

| Path | Date | Subject | Mark |
|---|---|---|---|
| `docs/review-engine/README.md` | 2026-11-10 | The entry point: the goal, the lane loop, the rules and the build status of the board tooling. | in force |
| `docs/review-engine/map.md` | 2026-11-10 | The one program map: Waves table, lane sections, shared contracts. | in force |
| `docs/review-engine/evidence-bar.md` | 2026-11-10 | The bar for each gate and the open items. | in force |
| `docs/review-engine/decisions.md` | 2026-11-10 | Each decision point with Dave's answer and date. | in force |
| `docs/review-engine/capacity.md` | 2026-11-10 | Each cap, the ledger that enforces it, and the last measured use. | in force |
| `docs/review-engine/research-index.md` | 2026-11-10 | This file: each review-engine document with one mark. | in force |
| `.claudedocs/re-decisions-journal.md` | 2026-11-09 | Log of Dave's answered decisions. It is the log between PRs. It wins over older text. | in force |
| `.claudedocs/2026-11-09-review-engine-orchestration-plan.md` | 2026-11-09 | Plan for several sessions to work the program without collisions. It holds the readiness list R1 to GO. The docs PR does not copy it. | in force (file head says PROPOSED; the decisions of 2026-11-09 and 2026-11-10 apply) |
| `.claudedocs/2026-11-09-multi-session-coordination-proposal.md` | 2026-11-09 | Proposal for the dependency gate and other coordination tools. It holds the T2.1 design. The docs PR does not copy it. | in force (file head says PROPOSED; the decisions of 2026-11-09 and 2026-11-10 apply) |
| `.claudedocs/2026-11-01-review-matrix.md` | 2026-11-01 | Design for when CodeRabbit runs and what runs instead. The rule file `.claude/rules-ondemand/pr-review-loop.md` names it as the spec of the live review matrix. | in force (review router matrix; not a program plan) |

## Superseded

| Path | Date | Subject | Mark |
|---|---|---|---|
| `.claudedocs/2026-11-09-review-engine-lane-map-v2.md` | 2026-11-09 | Lane map v2 with the premortem edits applied. | superseded by docs/review-engine/map.md |
| `.claudedocs/2026-11-05-review-engine-lane-map.md` | 2026-11-05 | First lane map for phases 3 to 7 and the CodeRabbit retirement gate. | superseded by docs/review-engine/map.md |
| `.claudedocs/2026-11-04-review-engine-combined-plan.md` | 2026-11-04 | Combined build plan from research teams 1 and 2. The two lane maps replaced its phase table. | superseded by docs/review-engine/map.md |
| `.claudedocs/2026-11-02-local-review-engine-plan.md` | 2026-11-02 | First plan for the local review engine and the eval harness. | superseded by docs/review-engine/map.md |
| `.claudedocs/2026-11-03-review-capacity-strategy.md` | 2026-11-03 | Strategy draft on why review runs are limited. | superseded by docs/review-engine/capacity.md |

## Records

### Program planning, 2026-11-09

The orchestration plan and the coordination proposal are in the "In force" table.

| Path | Date | Subject | Mark |
|---|---|---|---|
| `.claudedocs/2026-11-09-review-engine-plan-eval.md` | 2026-11-09 | Evaluation of the 11-05 map and the changes Dave accepted. | record |
| `.claudedocs/2026-11-09-review-engine-premortem.md` | 2026-11-09 | Premortem findings as first written. The mitigations went into the plan files. | record |
| `.claudedocs/2026-11-09-review-engine-premortem.json` | 2026-11-09 | Data file for the premortem. | record |
| `.claudedocs/2026-11-09-review-engine-assessment-page.html` | 2026-11-09 | Page that shows the plan evaluation. | record |
| `.claudedocs/premortem-backup-2026-11-09/2026-11-09-review-engine-lane-map-v2.md` | 2026-11-09 | Copy of map v2 from before the premortem edits. | record |
| `.claudedocs/premortem-backup-2026-11-09/2026-11-09-review-engine-orchestration-plan.md` | 2026-11-09 | Copy of the orchestration plan from before the premortem edits. | record |
| `.claudedocs/premortem-backup-2026-11-09/2026-11-09-multi-session-coordination-proposal.md` | 2026-11-09 | Copy of the coordination proposal from before the premortem edits. | record |
| `.claudedocs/premortem-evidence-2026-11-09/` | 2026-11-09 | Folder of 53 proof scripts and outputs for the premortem. It includes `check-map-waves.mjs`. | record |
| `.claudedocs/e2e-re-program/` | 2026-11-10 | Evidence folder of the master lane `re-program`. It holds the second-model check of 2026-11-10 (the answer of Grok 4.7 through Cursor, and the verified findings). | record |

### Engine research, builds and results, 2026-11-04 to 2026-11-07

| Path | Date | Subject | Mark |
|---|---|---|---|
| `.claudedocs/2026-11-07-prepr-checks-effectiveness.md` | 2026-11-07 | Judge verdict on how well the pre-PR and CI gates caught defects. | record |
| `.claudedocs/2026-11-04-review-engine-p2-plan.md` | 2026-11-04 | Plan for phase 2, the deterministic catchers. The phase is done. | record |
| `.claudedocs/2026-11-04-review-engine-p1-results.md` | 2026-11-04 | Phase 1 measurement results for the engine. | record |
| `.claudedocs/2026-11-04-review-engine-graph-and-selfimprove.md` | 2026-11-04 | Research report on a code graph, PR impact and a self-improving loop. | record |
| `.claudedocs/2026-11-04-review-engine-team2-refutation.md` | 2026-11-04 | Adversarial review of the team 2 program. | record |
| `.claudedocs/2026-11-04-review-engine-research.md` | 2026-11-04 | Research report on how to raise recall without CodeRabbit. | record |
| `.claudedocs/2026-11-03-engine-trusted-run-findings.md` | 2026-11-03 | Open findings from one trusted engine run on main. | record |
| `.claudedocs/2026-11-03-dave-review-suite-seed-research.md` | 2026-11-03 | Dave's seed notes on open-source review and security tools. | record |
| `.claudedocs/e2e-pr262/` | 2026-11-02 to 2026-11-03 | Folder of 16 raw output files from engine end-to-end runs. | record |

### Engine build specs, 2026-11-02

These specs describe code at base `361dc1b5`. The code is the truth now.

| Path | Date | Subject | Mark |
|---|---|---|---|
| `.claudedocs/2026-11-02-local-review-engine-spec.md` | 2026-11-02 | Build spec for the local review engine, P0 and P1. | record |
| `.claudedocs/2026-11-02-local-review-engine-spec-critique.md` | 2026-11-02 | Principal review of the engine build spec. | record |
| `.claudedocs/2026-11-02-review-engine-p0-eval-harness-spec.md` | 2026-11-02 | Spec for the P0 eval harness. | record |
| `.claudedocs/2026-11-02-review-engine-p1-engine-core-spec.md` | 2026-11-02 | Spec for the P1 engine core. | record |
| `.claudedocs/2026-11-02-review-engine-integration-spec.md` | 2026-11-02 | Spec for how the engine joins the existing factory scripts. | record |
| `.claudedocs/2026-11-02-review-engine-shadow-spec.md` | 2026-11-02 | Spec for the shadow protocol, engine against CodeRabbit. | record |
| `.claudedocs/2026-11-02-huggingface-review-data-eval.md` | 2026-11-02 | Decision document on public review datasets as a second signal. | record |

### TREX (execution-based review), parked

The TREX P0 bench result was stop. The verify stage did not cut noise. No TREX document is a plan.

| Path | Date | Subject | Mark |
|---|---|---|---|
| `.claudedocs/2026-11-04-trex-verify-p1-result.md` | 2026-11-04 | P1 result for the verify stage. It did not meet its goal. | record |
| `.claudedocs/2026-11-03-trex-verify-design.md` | 2026-11-03 | Design to reproduce review findings in a sandbox before reporting them. | record |
| `.claudedocs/2026-11-03-trex-review-baseline.md` | 2026-11-03 | Review-only baseline run and its scoring rule. | record |
| `.claudedocs/2026-11-03-trex-pivot-eval.md` | 2026-11-03 | Decision memo that parks blind TREX authoring. | record |
| `.claudedocs/2026-11-03-trex-p0-bench.md` | 2026-11-03 | P0 bench result for blind scripted flows. The verdict is stop. | record |
| `.claudedocs/2026-11-02-local-trex-plan.md` | 2026-11-02 | Plan for execution-based PR review. | record |
| `.claudedocs/2026-11-02-local-trex-spec.md` | 2026-11-02 | Build spec for TREX, P0 and P1. | record |
| `.claudedocs/2026-11-02-local-trex-spec-critique.md` | 2026-11-02 | Principal review of the TREX build spec. | record |
| `.claudedocs/2026-11-02-trex-runtime-spec.md` | 2026-11-02 | Runtime build spec for TREX. | record |
| `.claudedocs/2026-11-02-trex-integ-spec.md` | 2026-11-02 | Integration build spec for TREX. | record |
| `.claudedocs/2026-11-02-trex-bench-spec.md` | 2026-11-02 | Build spec for the TREX P0 replay bench. | record |
| `.claudedocs/2026-11-02-trex-model-arms-spec.md` | 2026-11-02 | Spec for a model comparison on blind flow authoring. | record |

### Early review work, 2026-11-01

The review matrix design is in the "In force" table.

| Path | Date | Subject | Mark |
|---|---|---|---|
| `.claudedocs/2026-11-01-prepr-checks-build-plan.md` | 2026-11-01 | Build plan for the first three pre-PR checks. | record |
| `.claudedocs/2026-11-01-findings-to-checks.md` | 2026-11-01 | Analysis that turns CodeRabbit findings into pre-PR checks. | record |
| `.claudedocs/2026-11-01-pr-review-dataset.json` | 2026-11-01 | Labeled review findings. It holds the answer key. Never tune on it. | record |
| `.claudedocs/2026-11-01-review-eval-results.md` | 2026-11-01 | Results for the CodeRabbit PR bot against our reviewers. | record |
| `.claudedocs/2026-11-01-cursor-bakeoff.md` | 2026-11-01 | Blind comparison of two Cursor models as reviewer. | record |
| `.claudedocs/2026-11-01-cursor-review-eval.md` | 2026-11-01 | Blind eval of the Cursor CLI as a local PR reviewer. | record |
| `.claudedocs/2026-11-01-review-knowledge-library.md` | 2026-11-01 | Study on whether CodeRabbit learnings can feed CCv3 review. | record |
| `.claudedocs/2026-11-01-review-knowledge-library-critique.md` | 2026-11-01 | Refuter critique of the knowledge library study. | record |
| `.claudedocs/2026-11-01-review-knowledge-surfaces.md` | 2026-11-01 | Scout map of review knowledge surfaces. | record |

### Documents in git

| Path | Date | Subject | Mark |
|---|---|---|---|
| `docs/self-improvement/proposals/2026-11-03-review-testing-system.md` | 2026-11-03 | Proposal for a review and testing system. It was never approved. | record |
| `docs/research/2026-11-03-review-testing-sota.md` | 2026-11-03 | Cited research digest on code review and testing. | record |

## Open marks

No mark is open today. Two groups were open in the first draft of this file. Both are settled (2026-11-10).

- `.claudedocs/2026-11-09-review-engine-orchestration-plan.md` and `.claudedocs/2026-11-09-multi-session-coordination-proposal.md`: in force.
  The plan holds the readiness list R1 to GO. The proposal holds the T2.1 design.
  The docs PR copies neither of them, so both stay in force.
  Each file head says "Status: PROPOSED". The decisions of 2026-11-09 and 2026-11-10 apply.
- `.claudedocs/2026-11-01-review-matrix.md`: in force for the review router matrix. It is not a program plan.
  The rule file `.claude/rules-ondemand/pr-review-loop.md` names it as the spec of the live review matrix.

## Judgment marks

These marks follow from the superseded maps. The sources do not state them. The reviewer of the docs PR should confirm them.

- The combined plan and the first engine plan are marked superseded by `docs/review-engine/map.md`. The two lane maps took over their phases.
- The capacity strategy is marked superseded by `docs/review-engine/capacity.md`. That file holds each cap.

## Not listed

- Generated codemap files in `docs/codemap/` mention the program name. They are not plans.
- The CodeRabbit documents dated before 2026-11-01 in `.claudedocs/` are not review-engine documents.
- Files in `.claudedocs/e2e-pr262/` and `.claudedocs/premortem-evidence-2026-11-09/` are listed as folders.
