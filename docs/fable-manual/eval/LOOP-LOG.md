# Harvest Loop Log — honing Fable-value extraction

Session: `fable-opus-brain-transfer`, 2026-07-12, authored live by `claude-fable-5`. Goal: iterate (≥5 cycles) on the *process* of extracting durable value from Fable before plan access ends — driven by evidence, not assumption. Predecessor evidence: TRAP-TESTS.md gate returned `no_lift` — trap-shaped evals saturate under CCv3 scaffolding + baseline Opus.

## Iteration 1 — Innovate the eval (seeded-defect plan review)

**Hypothesis:** the trap harness failed to discriminate because single, isolated, implicitly-labeled errors are exactly what scaffolding rules catch. Judgment differences (if any exist worth extracting) should show up in *multi-defect recall inside a plausible unlabeled artifact* — the actual shape of Gate-1 plan review and the /game-plan hub's daily work.

**Design:** `plan-A.md` — a realistic CCv3 feature plan (fork-storm bounding wrapper, from the real deferred roadmap) with **8 seeded defects** spanning distinct classes (arithmetic, internal contradiction, silent-failure design, unfalsifiable acceptance, irreversible-no-backout, stale/contradicted fact, deploy-before-test sequencing, TOCTOU race) + **2 good decoys** that must NOT be flagged (over-caution measure). Sealed key: `answer-key-A.md` (never enters reviewer prompts). Scoring: binary per defect (must name the specific problem), decoy-flags counted as over-caution.

**Test:** 2× plain Opus 4.8 reviewers (production scaffolding intact — that's the baseline any artifact must beat), plan text inline, no tool use.

**Why this is the innovation:** extraction inverted from "write down everything Fable knows" (rejected by the trap gate as duplication) to **delta-first extraction** — measure where the successor actually falls short, extract ONLY for the gap, re-test. The answer key itself encodes Fable judgment (defect design = knowing what plausibly hides in plans); the eval doubles as a transferable artifact.

**Result (2026-07-12): SATURATED WITH HEADROOM.** Both plain-Opus reviewers scored **8/8 recall, 0/2 over-caution** (zero tool uses — no key contamination possible). More: both *independently* found the same critical defect I did NOT seed — on Windows, orphaned processes are no longer descendants of the wrapper's child (no reparenting to a stable ancestor), so the plan's `taskkill /T`-on-own-subtree mechanism structurally cannot reach the orphans it exists to kill. Reviewer 1 additionally caught: the PreToolUse-hook registration is architecturally wrong for a process-launcher (hooks allow/deny, they don't parent children), the "zero agent-contract changes" goal contradicts the rollout, fixed-filename telemetry clobbers under the plan's own claimed concurrency, and the 120s "current default" premise was asserted-not-sourced (true — I invented it while seeding). **The successor model out-reviewed the eval's designer.**

**Iteration-1 conclusion:** convergent with the trap gate across a second, much harder eval design — **no extractable reasoning delta from Fable to Opus 4.8-in-CCv3 on review-shaped judgment.** Two independent eval shapes, same answer.

## Iteration 2 — Delta analysis + targeted extraction

**Delta analysis:** the deficit is not in Opus. Remaining candidate audiences for a plan-attack artifact, in order of production relevance: (a) the **Sonnet tier** — 25 of 37 CCv3 agents (kraken, spark, scout, arbiter...) run Sonnet 5 and routinely make judgment-adjacent calls; (b) **foreign-model booth reviewers** (Codex/Grok plan mode) — a standing /game-plan role where any artifact must stay compact (fork-storm constraint). Extraction pivots from "lift Opus" (nothing to lift) to "find which tier/family actually has the gap, extract for THAT."

**Test:** 2× plain Sonnet 5 reviewers, identical prompt/conditions on Plan A. If Sonnet also saturates → the gap thesis dies down-tier too and the loop's value concentrates in the eval instrument + playbook. If Sonnet shows class-shaped misses → iteration 3 extracts a targeted card and validates on a fresh plan.

**Result (2026-07-12): Sonnet 5 ALSO saturates — 15/16 aggregate (r1: 7/8, missed only D7 deploy-before-test; r2: 8/8), 0/2 over-caution both.** Sonnet even produced the most CCv3-native finding of all four Claude reviews: the auto-kill introduces a new destructive-operation class invisible to `destructive-command-guard` AND absent from the `.claude/audit/` trail — a safety-architecture observation neither Opus reviewer made. Both Sonnet runs also independently rediscovered the un-seeded orphan-reparenting flaw. One miss in 16 chances is noise, not a gap worth an extraction artifact.

**Iteration-2 conclusion:** the "deficit lives down-tier" hypothesis is dead. Claude-family models in CCv3 saturate review-shaped judgment at BOTH tiers. The scaffolding + model quality, not any single always-on text, is the operative "intelligence." Remaining untested audience with real production surface: the cross-family booth.

## Iteration 3 — Cross-family booth baseline (Codex + Grok on Plan A)

**Hypothesis:** the foreign-model reviewers (codex-adversary gpt-5.5, grok-adversary grok-4.5) — a standing /game-plan booth role — may show class-shaped recall gaps on plan review, since they lack both Claude's model behavior and (partially) the CCv3 rules context. If so, a compact plan-attack card embedded in the adversary plan-mode prompts is the evidence-backed integration (compact = fork-storm-safe by design).

**Test:** codex-adversary + grok-adversary, mode=plan, on a quarantined copy of Plan A (answer key physically moved OUT of the repo for the duration — these reviewers read files). Same scoring.

**Result (2026-07-12): FULL-STACK SATURATION.** Codex (gpt-5.5 @ xhigh): **8/8, 0/2** — sole reviewer to name BOTH lock-defect halves (TOCTOU + stale-lock) with remediations, plus a unique find no Claude reviewer made (Acceptance never tests the 10s detection SLA). Grok (grok-4.5): **8/8, 0/2** — plus per-run-lock and measurable-SLO recommendations. Every reviewer family beat the eval's designer.

**Unplanned live dividend:** the Grok invocation itself FORK-STORMED (~27 `grok.exe` descendants, manual `taskkill /T` cleanup, clean retry) — empirically refuting Plan A's seeded "Grok is exempt" premise in reality, not just reasoning, and generating a NEW probe-backed fact for the tri-model docs: fork-storm is not Codex-specific. Recorded in `docs/tri-model/CURRENT-STATE.md` fact 1b.

### Final scoreboard (Plan A, 8 seeded defects + 2 decoys)

| Reviewer | Model | Recall | Over-caution | Unique lift |
|---|---|---|---|---|
| Opus r1 | claude-opus-4-8 | 8/8 | 0/2 | zero-contract-changes contradiction; 120s premise unsourced |
| Opus r2 | claude-opus-4-8 | 8/8 | 0/2 | orphan-reparenting impossibility; PreToolUse architecture mismatch |
| Sonnet r1 | claude-sonnet-5 | 7/8 (missed D7) | 0/2 | PID-recycling race; hardened-flag preservation gap |
| Sonnet r2 | claude-sonnet-5 | 8/8 | 0/2 | destructive-guard blind spot + missing audit-log path |
| Codex | gpt-5.5 | 8/8 | 0/2 | 10s SLA never tested; Job Object recommendation |
| Grok | grok-4.5 | 8/8 | 0/2 | live fork-storm self-demonstration; per-run lock design |

## Iteration 4 — Integration per evidence (executed)

No per-model prompt card is justified anywhere — 47/48 aggregate recall with zero over-caution leaves nothing for a card to lift. What the evidence DID justify, shipped:
1. **CURRENT-STATE fact 1b** (Grok fork-storm) — real tri-model operational knowledge from the loop.
2. **The eval instrument retained** as a standing calibration suite (`plan-A.md` + sealed `answer-key-A.md` + this log): re-run it against any NEW model/CLI joining the roster (via `/harness-update`) or after any major prompt-layer change — a reviewer scoring notably below 7/8 with rising over-caution is the signal the current stack never gave.
3. **Leftover `grok.exe` PID 713844** surfaced to the operator (kill = confirm-first).

## Iteration 5 — Codify the playbook

The durable meta-lesson across 5 iterations: **extraction must be delta-first** — measure the successor's actual gap before writing prompt text for it; when measurement says "no gap," the harvest is the *instrument*, the *facts*, and the *process*, not the prose. Codified in `docs/fable-manual/HARVEST-PLAYBOOK.md`.

## Iteration 4 — Integrate or revise

_pending_

## Iteration 5 — Codify the playbook

_pending_
