---
date: 2026-08-09
component: workflows
component_name: Workflows
verdict: adopt
headline: Ralph and Maestro are dormant — no Ralph agent output since 2026-02-04 and no Maestro state file exists — so the five items three prior passes kept re-proposing are improvements to code paths that have not run in six months; close them, ship the now-unambiguous doc fix, and re-target the frontier upgrades at the orchestration surfaces that actually execute (hand-run kraken waves, lane.mjs, /review + /premortem).
sources: 9
---
# Workflows — Next-Evolution Proposal (2026-08-09)

Fourth pass on this component, after [2026-07-03](./2026-07-03-workflows.md), [2026-07-15](./2026-07-15-workflows.md) and [2026-07-28](./2026-07-28-workflows.md).

The 07-28 pass ended with a hard statement: *"A fourth identical proposal has negative expected value. The choice now is ship or close, and either is a legitimate outcome."* I re-verified every carried item this session. **None shipped.** So this pass does not re-propose them. Instead it does the two things that can actually break the loop:

1. **Resolves the ambiguity that made R6 (doc truth-up) hard to execute** — I traced the enforcers to their `permissionDecision` and can now state, per file and line, which doc is lying in which direction.
2. **Measures whether Ralph and Maestro are used at all.** They are not. That reframes the whole backlog: the five items improve machinery that has not executed in ~6 months, while the orchestration work Dave actually does runs on three other surfaces that carry none of these upgrades.

It also settles 07-28's open question 2 from our own telemetry, and corrects the recommendation that question was attached to.

## 1. Where CCv3 is today

### The three declared layers

1. **Ralph** — `.claude/skills/ralph/SKILL.md` (326 lines) + `.claude/scripts/ralph/` (11 Python modules + 7 test modules). Phase 2.5 mandatory adversarial premortem (`SKILL.md:187-196`), Phase 3 delegation loop with a `ralph_status` JSON contract required in every agent prompt (`SKILL.md:225-230`), Phase 3.5 external verification with max-3 retry (`SKILL.md:234-238`), Phase 4.1.5 independent goal verification by `plan-reviewer` (`SKILL.md:270-280`).
2. **Maestro** — `.claude/skills/maestro/SKILL.md` (368 lines), recon → interview → approval → execute with hook-enforced phase gates (`SKILL.md:36-40`).
3. **The native deterministic Workflow tool** — `agent()` / `parallel()` / `pipeline()` with JSON-schema-forced returns and journal-based resume. Available in this headless run. **Zero saved scripts** — `.claude/workflows/` does not exist (verified `ls` this session).

### Verified corrections to the tracking docs

`docs/system-update/CURRENT-STATE.md:39` (the Workflows row) states *"`ralph-task-monitor` dead (Agent matcher). `maestro-enforcer` never fired (Agent matcher dead, `D10c-03`) — RULES.md asserts C:10 blocking that is **false**."* Three of those four clauses are now wrong. Verified this session:

| Claim | Verified reality | Evidence |
|---|---|---|
| QW-04 matcher flip outstanding (`BACKLOG.md:37,49`) | **Shipped, both surfaces.** Repo `.claude/settings.json`: 69 hook entries, **0** with `matcher: "Agent"`, **13** with `matcher: "Task"`. Active `~/.claude/settings.json`: 86 entries, same 0/13 split. | direct JSON parse of both files |
| The flip might be inert (the two-gate defect class) | **Not inert.** Every workflow hook accepts both names at runtime. | `maestro-enforcer.ts:132`, `ralph-task-monitor.ts:343`, `agent-verification.ts:225` — all `!== 'Agent' && !== 'Task'` |
| `maestro-enforcer` never fires / does not block | **It is registered on `Task` and it hard-denies.** | `settings.json` PreToolUse/`Task`; `maestro-enforcer.ts:104-105` emits `permissionDecision: 'deny'` |
| `ralph/SKILL.md:33` "blocks Edit/Write/Bash" | **False — soft.** | `ralph-delegation-enforcer.ts:131,134`: logs `"Ralph active (soft-enforce, allow)"`, comment `// Always allow - soft enforcement only`. RULES.md is the correct one here. |
| `maestro/SKILL.md:36-40` "Hook will BLOCK" ×3 | **True.** | as above |

So the doc debt is now fully resolved, not merely "contradictory": **`CURRENT-STATE.md:39` and `BACKLOG.md:37,49` under-claim; `ralph/SKILL.md:33` over-claims; `maestro/SKILL.md:36-40` is correct.** That is a four-line edit with the answers supplied.

### The finding this pass adds: Ralph and Maestro are dormant

| Signal | Value | What it means |
|---|---|---|
| `.ralph/agent-output.json` mtime | **2026-02-04** | last Ralph agent result written in this repo — ~6 months ago |
| `maestro-state.json` | **does not exist** in repo or `~/.claude/` | Maestro has not been activated recently (the enforcer reads a 4h-TTL state file, `maestro-enforcer.ts:45-46`) |
| newest `tasks/prd-*.md` | **2026-03-08** | no Ralph PRD generated since |
| last git touch of either SKILL | `a02911e` **2026-07-25** — an *agents-portfolio* commit, not a Ralph/Maestro feature | the skills are being maintained incidentally, not developed |
| `scripts/coordination/` | commits through `11a6e26` **2026-07-29**; live lane board carried **142 lane updates** into this session | this is where orchestration engineering is going |
| the largest recent multi-agent build | report registry — `tasks/tasks-report-registry.md`, `5aa2264` 2026-07-06 — built by **~8 sequential hand-run kraken waves** | its hard-won rules landed in `.claude/rules/proactive-delegation.md` ("Multi-Agent Orchestration (kraken/Ralph waves)"), **not** in the Ralph skill |

**The live orchestration surfaces are therefore:** (a) the main session hand-running kraken waves under `proactive-delegation.md`'s serialize-commits / externally-verify rules; (b) `lane.mjs` for cross-session lane leasing; (c) `/review` + `/premortem` cross-model gates — **34 logged runs between 2026-05-22 and 2026-08-07**; (d) the native Workflow tool, used ad hoc (`codex-lift.jsonl` has one `via:"workflow"` row, 2026-06-12) but never saved.

Ralph and Maestro are on none of that list.

### Our own answer to 07-28's open question 2

07-28 recommended pruning the reviewer fan-out and named `.claude/logs/codex-lift.jsonl` as the instrument. I read it. **34 rows, 2026-05-22 → 2026-08-07; 32 are `/premortem`, 1 is `/review`, 1 is a workflow deep-review.**

Across the 32 premortem runs:

| Measure | Value |
|---|---|
| findings only Claude found (`claude_only`) | 151 |
| findings only the cross-model reviewer found (`codex_only`) | **226 (53.8% of all findings)** |
| findings both found (`both`) | 43 (**10.2%** overlap) |
| runs where `codex_only > 0` | **32 / 32** |
| runs where `codex_only > claude_only` | 24 / 32 |
| runs with **zero** overlap | 12 / 32 |
| runs needing a fallback invocation path | 2 / 32 (`direct-powershell-fallback`, `inline-powershell-fallback`) |

The `/review` surface is effectively **uninstrumented**: one row (2026-07-06, `critic_only: 6, codex_only: 4, both: 4`). n=1.

## 2. Frontier scan

Nine sources. **Every one was fetched by me this session**, not taken from a research summary. Where a summary I received disagreed with the source, I state the correction.

1. **Anthropic — "Building effective agents"** ([anthropic.com](https://www.anthropic.com/engineering/building-effective-agents), 2024-12-19). Verified: **workflows** are "LLMs and tools orchestrated through predefined code paths"; **agents** are "systems where LLMs dynamically direct their own processes and tool usage." Guidance: "Finding the simplest solution possible, and only increasing complexity when needed." Agents suit "open-ended problems where it's difficult or impossible to predict the required number of steps"; workflows suit tasks with "fixed, predictable paths." The **evaluator-optimizer** pattern works best "when we have clear evaluation criteria, and when iterative refinement provides measurable value." *(Predates the 12-month window; it is the document everything below reacts to.)*

2. **Cognition — "Don't Build Multi-Agents"** ([cognition.com](https://cognition.com/blog/dont-build-multi-agents), Walden Yan, 2025-06-12). Verified verbatim: two principles — *"Share context, and share full agent traces, not just individual messages"* and *"Actions carry implicit decisions, and conflicting decisions carry bad results."* Recommends a single-threaded linear agent "where the context is continuous" as the simplest way to follow them, and says it "will get you very far." For work exceeding a context window it proposes "a new LLM model whose key purpose is to compress a history of actions & conversation into key details, events, and decisions" — while conceding this "is hard to get right."

3. **Geoffrey Huntley — "Ralph Wiggum as a 'software engineer'"** ([ghuntley.com/ralph](https://ghuntley.com/ralph/), 2025-07-14). The origin of the technique our Ralph is named for. Verified verbatim: the whole mechanism is `while :; do cat PROMPT.md | claude-code ; done`. Also verified, and rarely quoted: *"the technique is deterministically bad in an undeterministic world"*, it "requires faith and belief in eventual consistency", and users will *"wake up to a broken code base from time to time."* It fans out aggressively for read work ("up to 500 parallel subagents") but restricts build/test validation to "only 1 subagent."

4. **"Where LLM Agents Fail and How They can Learn From Failures"** — arXiv [2509.25370](https://arxiv.org/abs/2509.25370), Zhu, Liu, Li, Tian, Yang et al. (18 authors), submitted 2025-09-29. Verified abstract: sophisticated agent architectures "amplify vulnerability to cascading failures, where a single root-cause error propagates through subsequent decisions"; current systems "lack a framework that can comprehensively understand agent error in a modular and systemic way." Three artifacts: **AgentErrorTaxonomy** (memory / reflection / planning / action / system-level), **AgentErrorBench** (annotated failure trajectories from ALFWorld, GAIA, WebShop), and **AgentDebug** (root-cause isolation + corrective feedback). Reported: "24% higher all-correct accuracy and 17% higher step accuracy compared to the strongest baseline", and "up to 26% relative improvements in task success."

5. **"Shrinking the Generation-Verification Gap with Weak Verifiers"** — arXiv [2506.18203](https://arxiv.org/abs/2506.18203), Saad-Falcon, Buchanan, Chen, Huang, McLaughlin, Bhathal, Zhu, Athiwaratkun, Sala, Linderman, Mirhoseini, Ré; submitted 2025-06-22 (v3 2026-08-06). Verified: "While LM judges and reward models have become broadly useful as general-purpose verifiers, a significant performance gap remains between them and oracle verifiers (verifiers with perfect accuracy)." Also verified: "Weighted ensembles of verifiers, which typically require learning from labeled data, significantly outperform unweighted combinations due to differences in verifier accuracies." Weaver reaches 87.7% average by combining weak verifiers.

6. **"Large Language Models Cannot Self-Correct Reasoning Yet"** — arXiv [2310.01798](https://arxiv.org/abs/2310.01798), Huang, Chen, Mishra, Zheng, Yu, Song, Zhou; ICLR 2024. Verified verbatim: studies "intrinsic self-correction, whereby an LLM attempts to correct its initial responses based solely on its inherent capabilities, without the crutch of external feedback"; finds "LLMs struggle to self-correct their responses without external feedback, and at times, their performance even degrades after self-correction." Domain limit stated in the paper: reasoning tasks.

7. **"LLM Critics Help Catch LLM Bugs"** — arXiv [2407.00215](https://arxiv.org/abs/2407.00215), McAleese, Pokorny, Ceron Uribe, Nitishinskaya, Trebacz, Leike; submitted 2024-06-28. Verified verbatim: "On code containing naturally occurring LLM errors model-written critiques are preferred over **human** critiques in 63% of cases, and human evaluation finds that models catch more bugs than human contractors paid for code review." **Correction to a research summary I received:** the 63% is preference over *human* critiques, **not** over the base model's own self-critiques. I do not make the self-critique claim.

8. **METR — "Measuring AI Ability to Complete Long Tasks"** ([metr.org](https://metr.org/blog/2025-03-19-measuring-ai-ability-to-complete-long-tasks/), 2025-03-19). Verified verbatim: the metric is "the length (for humans) of tasks that the model can successfully complete with x% probability"; it "has been doubling approximately every 7 months for the last 6 years"; and "Current models have almost 100% success rate on tasks taking humans less than 4 minutes, but succeed <10% of the time on tasks taking more than around 4 hours." *(The companion arXiv ID circulated in secondary sources — I did not verify it and do not cite it.)*

9. **LangChain — LangGraph durable execution docs** ([docs.langchain.com](https://docs.langchain.com/oss/python/langgraph/durable-execution)). Thin fetch: confirmed only that checkpointers "persist a thread's graph state as checkpoints" supporting "conversation continuity, human-in-the-loop workflows, time travel, and fault tolerance." I could **not** retrieve the determinism/side-effect/idempotency guidance (the deeper page redirected). **I therefore make no claim about exactly-once side-effect semantics.** [Speculation: the checkpoint-vs-durable-execution distinction discussed in vendor blogs is real, but I have no primary source for it and it does not carry any recommendation below.]

**Not carried into this pass:** several arXiv IDs and vendor figures surfaced in research that I could not verify (a 2026 "self-correction illusion" paper, a structured-feedback repair paper, an LLM-as-verifier framework, an OpenHands SDK paper, a sandbox-session growth statistic, and framework GA dates for Google ADK / Microsoft Agent Framework). They are omitted rather than hedged.

## 3. Gap analysis

| Dimension | CCv3 today | Frontier | Verdict |
|---|---|---|---|
| Loop shape on the surfaces that **run** | `proactive-delegation.md` mandates sequential waves, disjoint-file parallelism, and orchestrator-side external verification; `/premortem` gates plans; `/review` gates diffs | External feedback is the requirement self-correction cannot substitute for (src 6); execution-grounded oracle verifiers still beat LM judges (src 5); external critics beat unaided human review (src 7) | **Ahead** — the live practice is the recommended shape |
| Loop shape on the surfaces that **don't run** | Ralph's 2.5 / 3.5 / 4.1.5 gates are a more structured elaboration of Huntley's raw loop (src 3), which itself admits it is "deterministically bad" and leaves a broken tree "from time to time" | Anthropic: prefer the simplest thing that works (src 1) | **Even, and unused** — the sophistication is real and idle |
| Coding-task fan-out | hand-run kraken waves are **sequential** per repo, parallel only on disjoint surfaces or worktrees | Cognition: single-threaded linear agent, because parallel subagents make conflicting implicit decisions (src 2) | **Ahead / converged** — our practice independently arrived at Cognition's recommendation |
| Cross-model review | one Claude-family reviewer + one cross-family reviewer, 34 logged runs | Src 5: verifier ensembles beat single verifiers when the verifiers differ in accuracy; src 7: an external critic model catches bugs unaided review misses | **Ahead, now with own-data proof** — 53.8% of premortem findings were cross-model-only, 10.2% overlap |
| `/review` instrumentation | 1 logged row vs 32 for `/premortem` | n/a | **Behind our own standard** — we instrumented one gate and not its sibling |
| Failure classification | none; no trace corpus | src 4 gives a modular taxonomy, an annotated benchmark, and a root-cause debugger with reported gains | **Behind — but currently unusable**: Ralph produces no traces to classify |
| Long-horizon posture | bounded 10/30/50 tiers, max-3 retry, fresh context per agent | success falls off sharply with task duration (src 8); root-cause errors cascade (src 4) | **Ahead in design** |
| Doc truthfulness | 4 contradictions, now individually resolved (§1) | n/a — internal correctness | **Open, but no longer ambiguous** |
| Deterministic control plane | Workflow tool: 0 saved scripts. `lane.mjs`: leased, atomic, fail-loud, actively developed | predefined code paths remain the reliability position (src 1) | **Split** — behind on one, ahead on the other |

**The meta-gap has changed.** 07-28 framed it as "the items keep getting re-proposed and never shipped." The sharper framing after this session's measurement is: **the items are improvements to dormant machinery.** R1 (plan-compliance at Ralph's merge gate) cannot pay off in a Ralph that has not produced an agent result since February. That is not a scheduling failure; it is a targeting failure, and it explains why three passes of "ship this, it's an hour" never got an hour spent on it. Re-proposing them a fourth time would repeat the error at higher confidence.

## 4. Recommendations

**W-1 — Ship the doc truth-up. ADOPT (highest priority, ~15 minutes, answers supplied).**
This is R6 from three prior passes, but it is no longer blocked on "which side is right" — §1 resolves all four with file:line evidence. Four edits: correct `CURRENT-STATE.md:39` (both enforcers are live; `maestro-enforcer` hard-denies at `maestro-enforcer.ts:104`); mark `QW-04` shipped in `BACKLOG.md:37,49` (0 `Agent` matchers, 13 `Task` matchers, both surfaces); correct `ralph/SKILL.md:33` to say soft-enforce/log-only (matching RULES.md and `ralph-delegation-enforcer.ts:134`); leave `maestro/SKILL.md:36-40` alone — it is accurate. Risk: near zero. **This is correctness debt, not enhancement** — every session reading any of those files today is misled.

**W-2 — Close R1, R2 and R4 against Ralph/Maestro; re-target R1 and R2 at the surface that runs. ADOPT.**
The evidence in §1 says these three have no delivery vehicle. Close them in `BACKLOG.md` as *"considered — re-targeted, see below"* so the loop stops re-costing them, and move the two that still carry value:
- **R1 (plan-compliance)** → `.claude/rules/proactive-delegation.md`'s "Multi-Agent Orchestration" section and/or `.claude/skills/review/SKILL.md`: after a wave, grade the diff against the declared file list — flag files touched outside it and tasks marked complete with no corresponding diff. This is the same check R1 proposed, aimed at where waves are actually run. It is also the check src 4's taxonomy would call an action/system-level error and src 6 says the agent cannot be trusted to make about itself.
- **R2 (cross-model second opinion at the merge gate)** → already exists as `/review`; the gap is that nothing *requires* it at a wave boundary. One line in `proactive-delegation.md`.
- **R4 (first saved Workflow script)** → close for now. It was scoped to encode `/review` Phase 1, and W-3 says that fan-out is correct as-is; encoding an unchanging two-reviewer call in a script buys little, and `.claude/workflows/` still has no answer for `SYNC_DIRS` (`.claude/rules/sync-known-gaps.md`), which has blocked it for four passes. **[Speculation: it would be worth revisiting if a genuinely repeated ≥4-way fan-out emerges.]**

**W-3 — Keep the cross-family reviewer. ADOPT — and this reverses part of 07-28's R-B.**
07-28 recommended pruning the reviewer fan-out on the strength of a 9-judge correlated-errors study, and flagged that the study tested NLI/RewardBench rather than code review. Our own data now covers the actual domain: across 32 premortem runs the cross-model reviewer produced **226 findings no Claude reviewer produced — 53.8% of all findings — with only 10.2% overlap, and `codex_only > 0` in 32 of 32 runs.** These reviewers are not correlated on our workload. Src 5 predicts exactly this: ensembles pay when members differ, and LM verifiers still trail oracle verifiers, so a second independent look is buying real coverage. **Concretely: a naive read of 07-28's R-B ("best single judge matches the panel") would have pruned the reviewer carrying the majority of findings.** Keep both. The *same-family* half of that recommendation — whether `critic` adds anything over `plan-reviewer` — remains **unmeasured**: `/review` has logged one row, ever.

**W-4 — Instrument `/review` the way `/premortem` is instrumented. ADOPT (small).**
32 rows vs 1 row is why W-3 can answer half a question and not the other half. Have `/review` write a `codex-lift.jsonl` row on every run with the same `claude_only` / `codex_only` / `both` shape, plus a `critic_only` field (the schema already has one — the single 2026-07-06 row uses it). Two or three months of rows then answers the same-family question with the same rigor. Effort S. Risk: near zero.

**W-5 — AgentErrorTaxonomy / AgentDebug as the successor to 07-28's MAST item (R-C). WATCH — downgraded, with a reason.**
Src 4 is a better instrument than the taxonomy 07-28 proposed: it adds root-cause *isolation* on top of classification, and reports concrete gains (24% higher all-correct detection accuracy; up to 26% relative task-success improvement). But 07-28 marked R-C ADOPT on the assumption there was a Ralph/agent trace corpus to classify. §1 shows there is not — Ralph has produced no agent output since 2026-02-04. Classifying *hand-run wave* failures is possible in principle but those traces live in session transcripts, not a structured store, and that joinability problem is **ST-02**'s (canonical `session_id` + `agent_id`) and **SG-04**'s. Revisit after W-4 has produced a few months of structured rows, or after ST-02 lands.

**W-6 — Close the resume-idempotency audit (R3 / 07-28's R-E). SKIP.**
It has been carried through four passes as a hypothetical window in `ralph-state-v2.py` / `ralph-progress-sync.py`. Those scripts have not run in six months. Auditing a crash-resume race in dormant code is not a good use of an hour. Close it; if Ralph is ever revived, reopen it as a precondition of the revival rather than as standing debt.

**W-7 — Difficulty-aware iteration tiering. SKIP.** Unchanged from 07-15 and 07-28. Src 8 says horizon length is the dominant failure axis, which argues for *bounds* — which we have — not for a learned estimator. Fourth pass, same answer.

**W-8 — Decide Ralph's status explicitly. ADOPT (a decision, not an edit).**
This is the question underneath everything else, and it deserves a stated answer rather than another year of drift. Three defensible options: **(a) Retired** — archive the skills, keep the scripts, note in `CURRENT-STATE.md` that the Workflows component now means hand-run waves + lanes + review gates. **(b) Dormant-by-design** — keep them documented as the tool for a future greenfield build, and stop scheduling improvements to them. **(c) Revive** — pick one real feature and run it through Ralph end-to-end, which would also produce the trace corpus W-5 needs. My recommendation is **(b)**, on the frontier's own logic: src 1 says use the simplest thing that works, src 2 says single-threaded linear agents get you very far on coding work, and src 3's author — who invented the loop — concedes it leaves a broken tree "from time to time." Our hand-run wave practice already converged on the recommended shape. Ralph's dormancy is plausibly a *correct* outcome, not a failure to maintain it. It should be recorded as one.

## 5. Integration approach

| Rec | Files / subsystems | BACKLOG tie | Effort | Risk |
|---|---|---|---|---|
| **W-1** doc truth-up | `docs/system-update/CURRENT-STATE.md:39`; `docs/system-update/BACKLOG.md:37,49`; `.claude/skills/ralph/SKILL.md:33` | **Closes `QW-04`** (verified shipped both surfaces) | S (~15 min) | Near zero — doc-only |
| **W-2** close + re-target | `docs/system-update/BACKLOG.md` (close R1/R2/R4); `.claude/rules/proactive-delegation.md` (add plan-compliance + merge-gate review to the wave protocol); optionally `.claude/skills/review/SKILL.md` | Removes three items from the standing backlog | S | The rule file is always in context — keep the addition to a few lines or it costs tokens every session |
| **W-3** keep cross-family reviewer | no code change; record the finding in `.claude/logs/codex-lift.README.md` so the next pass does not re-litigate it | Settles the `SG-04` codex-lift ROI line item **in favour of keeping it** | XS | None — this is a decision to not change something |
| **W-4** instrument `/review` | `.claude/skills/review/SKILL.md` (emit a row); `.claude/logs/codex-lift.jsonl` (schema already supports `critic_only`) | Feeds **SG-04** telemetry; unblocks W-5 | S | A logging step the model can skip — make it part of the skill's output contract, not prose |
| **W-5** AgentDebug-style classification | new one-off analysis script under `scripts/` | Gated on **ST-02** (canonical `session_id` + `agent_id`) → **SG-04** | M, deferred | Runs on a corpus that does not exist yet — that is why it is WATCH |
| **W-6/W-7** closures | `docs/system-update/BACKLOG.md` | Retires two carried items | XS | Losing a real concern if Ralph is revived — mitigated by tying W-6 to option (c) in W-8 |
| **W-8** status decision | `docs/system-update/CURRENT-STATE.md` Workflows row; possibly `.claude/skills/ralph/`, `.claude/skills/maestro/` | Redefines what this component means for future passes | S (decision) + S (record it) | Archiving something Dave intends to use — hence the recommendation is (b) *dormant-by-design*, which archives nothing |

**Sequencing.** W-1 first — it is correctness and it is 15 minutes. W-8 second, because the answer determines whether W-2's closures are "declined" or "re-targeted." W-2 and W-3 follow immediately (both are cheap and W-3 is a no-op). W-4 any time. W-5 stays parked behind ST-02.

**What could go wrong.** W-2's re-targeting adds prose to `proactive-delegation.md`, which loads into every session — the context-budget lesson from the duplicate-rules work applies, so it must be a few lines, not a section. W-3 is a decision *not* to prune, so its risk is the inverse of 07-28's: we keep paying Codex quota for a second reviewer. The 53.8%/10.2% figures say that is the right trade today, but W-4 is what keeps the question answerable rather than assumed. W-8 option (b) risks becoming a polite way of never deciding — the mitigation is that it must be *written into* `CURRENT-STATE.md`, so the next pass reads a decision instead of re-measuring dormancy. And a caveat on my own data: `codex-lift.jsonl` rows are self-reported counts entered by the session that ran the gate, not independently audited findings; the ratio is robust across 32 runs but the absolute counts should be treated as approximate.

## 6. Benefits

- **The loop stops re-costing a dead branch.** Four passes have analysed improvements to Ralph. This pass supplies the measurement that explains why none were ever worth an hour, and closes them. That is the concrete saving: no fifth pass re-derives R1/R2/R4.
- **The docs stop lying — with the answers already looked up.** Today `CURRENT-STATE.md:39` tells a session the workflow enforcers are dead while `ralph/SKILL.md:33` tells it they hard-block. Both are wrong, in opposite directions, and §1 gives the corrected text for each.
- **A reviewer decision made on our data instead of a paper analogy — and a reversal caught.** 226 cross-model-only findings across 32 runs, 10.2% overlap, positive lift in every single run. The prior pass's prune recommendation, applied literally, would have removed the reviewer producing the majority of premortem findings. This pass catches that before it ships.
- **The upgrades land where work actually happens.** Plan-compliance and a cross-model merge gate move from a dormant skill into `proactive-delegation.md` — the rule that governed the ~8-wave report-registry build. Same idea, a delivery vehicle that runs.
- **A component definition that matches reality.** After W-8, "Workflows" means the surfaces that execute (hand-run waves, `lane.mjs`, `/review` + `/premortem`, the native Workflow tool), and the next pass researches those rather than re-auditing idle machinery.
- **Confirmation that the expensive parts are right.** Bounded iteration, fresh-context delegation, premortem gating, and orchestrator-side external verification are each independently supported by src 1, 2, 6, 7 and 8. Nothing here is a rebuild.

## 7. Open questions

1. **W-8 is the decision that matters: is Ralph retired, dormant-by-design, or due a revival run?** Recommendation: dormant-by-design. But this needs Dave's answer, because it determines whether the other closures are "declined" or "re-targeted."
2. **Does `critic` (same family as `plan-reviewer`) contribute findings neither of the others catches?** Unmeasurable today — `/review` has one logged row against `/premortem`'s 32. W-4 is the fix; the answer is ~2-3 months out.
3. **Do the now-live `Task`-matcher enforcers gate correctly in a fan-out?** `maestro-enforcer` provably *can* deny (`maestro-enforcer.ts:104`), but whether it discriminates orchestrator from subagent still depends on **ST-02**'s two-level identity. Carried from 07-15 Q4 and 07-28 Q4 — genuinely blocked, not neglected.
4. **Should `proactive-delegation.md` become the canonical orchestration spec?** It already holds the serialize-commits rule, the disjoint-surface parallelism rule, and the never-trust-`ralph_status` rule — the three lessons the report-registry build actually produced. If yes, the Ralph/Maestro skills become reference material rather than the primary doc.
5. **Two of 32 premortem runs needed a fallback invocation path.** A ~6% harness-path failure rate on a gate we rely on is small but non-zero. Worth a look, or worth accepting explicitly?
6. **Is there a repeated fan-out wide enough to justify the first saved Workflow script?** W-2 closes R4 on the grounds that the reviewer fan-out is only two agents. If a genuinely ≥4-way recurring fan-out exists that I have not seen, that closure is wrong and should be reopened.
