---
date: 2026-07-28
component: workflows
component_name: Workflows
verdict: adopt
headline: Three passes (07-03, 07-15, 07-28) have now proposed the same five workflow items and verified all five still unshipped — so the recommendation changes from "propose" to "ship the two ~1-hour items or formally close them", plus one newly-verified simplification: a 9-judge panel carries ~2 independent votes and the best single judge matches or beats the panel, which argues our /review fan-out should be pruned to cross-FAMILY reviewers rather than grown.
sources: 7
---
# Workflows — Next-Evolution Proposal (2026-07-28)

Third pass on this component (after [2026-07-03](./2026-07-03-workflows.md) and [2026-07-15](./2026-07-15-workflows.md)). Both prior passes concluded CCv3's workflow *shape* is at or ahead of the frontier and that the work is a handful of cheap, concrete items. This pass re-verified those items against the repo. **All of them are still unshipped.** That fact — not any new frontier technique — is the finding that should drive this component's next move.

I therefore keep the frontier scan deliberately narrow (7 sources, every one fetched and quoted this session) and spend the proposal's weight on: what shipped vs. what didn't, one evidence-backed *subtraction*, and a measurement instrument to replace speculation.

## 1. Where CCv3 is today

**The three layers are unchanged since 07-15** (verified by direct file read this session; `git log` was unavailable — the Bash tool was in an MSYS fork-storm and PowerShell's git is permission-gated — so this section cites file contents, not commit history):

1. **Ralph** — `.claude/skills/ralph/SKILL.md`. Phase 2.5 adversarial premortem gate (`SKILL.md:187-196`, "MANDATORY, not optional"); Phase 3 delegation loop where every agent returns a `ralph_status` JSON block (`SKILL.md:225-230`); Phase 3.5 external verification with a max-3 retry chain (`SKILL.md:234-238`); Phase 4.1.5 independent goal verification by a `plan-reviewer` agent (`SKILL.md:270-280`).
2. **Maestro** — `.claude/skills/maestro/SKILL.md`, interview-gated phases.
3. **The native deterministic Workflow tool** — `agent()`/`parallel()`/`pipeline()` with schema-forced returns and journal-based resume, available in this headless run.

**Re-verification of the five carried recommendations — all five still open:**

| Item (from 07-03, re-proposed 07-15) | Status verified this session | Evidence |
|---|---|---|
| **R1** plan-compliance check at Ralph's merge gate | **Unshipped.** 4.1.5 still checks *PRD acceptance criteria* against the diff only; nothing grades the diff against the approved task list. | `.claude/skills/ralph/SKILL.md:270-280`; `grep` for "plan-compliance" in `.claude/skills/ralph/` returns no match |
| **R2** one cross-model second opinion at the merge gate | **Unshipped.** No `codex-adversary`/`grok-adversary` reference anywhere in the Ralph skill. | `grep -n "codex-adversary\|grok-adversary" .claude/skills/ralph/` → no matches |
| **R3** resume-idempotency audit | **No evidence of an audit artifact.** (Absence of a report is weaker evidence than the others — marking `? INFERRED`.) | no audit doc under `docs/`; `scripts/coordination/` additions are unrelated |
| **R4** first saved Workflow-tool script | **Unshipped.** `.claude/workflows/` still does not exist. | `Test-Path .claude/workflows` → `False` |
| **R6** doc truth-up (docs say the enforcers are dead; SKILLs say they hard-block) | **Unshipped, both halves still contradictory.** | `CURRENT-STATE.md:39` still reads "`ralph-task-monitor` dead (Agent matcher). `maestro-enforcer` never fired (Agent matcher dead)"; `BACKLOG.md:37,49` still list `QW-04` as remaining; meanwhile `ralph/SKILL.md:33` still asserts the enforcer "blocks Edit/Write/Bash" — which RULES.md ("Ralph Mode") contradicts, describing it as soft/log-only since 2026-04-23; `maestro/SKILL.md:37-39` still asserts "Hook will BLOCK" three times |

**What *did* ship in this window is real workflow engineering — it just landed in the coordination lane, not in Ralph/Maestro.** `scripts/coordination/lane.mjs` (23KB) plus `render-board.mjs`, `load-probe.mjs`, `lease-probe.mjs`, and a `migrations/` dir now implement atomic, durably-leased, human-named work lanes for concurrent sessions — with an explicitly documented failure posture ("fails LOUD -- a coordination command that silently no-ops is worse than one that errors", `lane.mjs:29-33`) and an identity contract written specifically to prevent a previously root-caused bug ("8,179 claims, 0 owned by a live session", `lane.mjs:15-26`). This is deterministic orchestration built to a high standard. So the accurate characterization is **not** "the workflow component stalled" — it is "workflow effort was reallocated to coordination, and the Ralph/Maestro items were never closed out or explicitly deprioritized; they just kept getting re-proposed."

## 2. Frontier scan

Seven sources, each fetched this session; I quote only what the source actually states.

1. **"Why Do Multi-Agent LLM Systems Fail?" (MAST)** — arXiv [2503.13657](https://arxiv.org/abs/2503.13657), Cemri, Pan, Yang, Agrawal, Chopra, Tiwari, Keutzer, Parameswaran, Klein, Ramchandran, Zaharia, Gonzalez, Stoica. Verified: they built **MAST-Data**, "over 1600 annotated traces from 7 multi-agent system frameworks", derived the **Multi-Agent System Failure Taxonomy** from 150 traces, yielding **14 distinct failure modes in 3 categories: system design issues, inter-agent misalignment, and task verification**, at inter-annotator "kappa = 0.88", and shipped an "LLM-as-a-Judge pipeline with high agreement with human annotations". Abstract framing: "Despite enthusiasm for Multi-Agent LLM Systems (MAS), their performance gains on popular benchmarks are often minimal." *(Correction to a research summary I received: the first category is "system design issues", not "specification issues".)* — **Strong: peer-track empirical study with published dataset + classifier.**

2. **"Nine Judges, Two Effective Votes: Correlated Errors Undermine LLM Evaluation Panels"** — arXiv [2605.29800](https://arxiv.org/pdf/2605.29800), Guneet Kohli. Verified verbatim: a panel of "9 frontier LLMs from 7 model families on three natural language inference datasets" provides "only about 2 independent votes' worth of information"; "roughly three-quarters of the panel's nominal independence is lost because the models make the same mistakes on the same items"; "the panel's actual accuracy falls 8-22 percentage points short of what independent voting would achieve, **and the best single judge matches or outperforms the full panel across all conditions**"; "Neither adding more judges nor using smarter aggregation algorithms helps". Robust "across prompt variants, temperatures, chain-of-thought reasoning, and a pairwise preference task (RewardBench)". Conclusion: "The bottleneck is correlated judges, not the aggregation algorithm." — **Strong empirical study. Scope caveat: NLI datasets + RewardBench, NOT code review** — extrapolation to our reviewer fan-out is directional, not proven.

3. **"Large Language Models Cannot Self-Correct Reasoning Yet"** — arXiv [2310.01798](https://arxiv.org/abs/2310.01798), Huang et al., ICLR 2024. Verified verbatim: studies "intrinsic self-correction, whereby an LLM attempts to correct its initial responses based solely on its inherent capabilities, without the crutch of external feedback"; finds "LLMs struggle to self-correct their responses without external feedback, and at times, their performance even degrades after self-correction." Domain is **reasoning tasks specifically** — extending it to code-with-a-test-suite is an extrapolation, and arguably the opposite case (a test suite *is* external feedback). — **Strong (ICLR 2024), with a stated domain limit.**

4. **"Is there a half-life for the success rates of AI agents?"** — arXiv [2505.05115](https://arxiv.org/pdf/2505.05115), Toby Ord. Verified verbatim: building on Kwa et al. (2025), agent performance on longer tasks "can be explained by an extremely simple mathematical model -- a constant rate of failing during each minute a human would take to do the task. This implies an exponentially declining success rate with the length of the task and that each agent could be characterised by its own half-life." — **Moderate: a modelling analysis over METR's data, not an independent experiment.** I do **not** cite specific decay percentages or a human-vs-agent comparison; the abstract states neither.

5. **Terminal-Bench 2.0** — arXiv [2601.11868](https://arxiv.org/abs/2601.11868), Merrill et al. Verified verbatim: "89 tasks in computer terminal environments inspired by problems from real workflows. Each task features a unique environment, human-written solution, and comprehensive tests for verification. We show that frontier models and agents score less than 65% on the benchmark". — **Strong: community benchmark with public leaderboard.**

6. **Anthropic — "Effective context engineering for AI agents"** ([anthropic.com](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents), Sept 2025). Verified: "Context, therefore, must be treated as a finite resource with diminishing marginal returns"; "as the number of tokens in the context window increases, the model's ability to accurately recall information from that context decreases"; compaction = "taking a conversation nearing the context window limit, summarizing its contents, and reinitiating a new context window with the summary"; sub-agents = "Rather than one agent attempting to maintain state across an entire project, specialized sub-agents can handle focused tasks with clean context windows." — **Vendor engineering guidance, not a benchmark.**

7. **Anthropic — "How we built our multi-agent research system"** ([anthropic.com](https://www.anthropic.com/engineering/multi-agent-research-system)). Verified verbatim, including the caveat usually omitted when this post is cited as pro-fan-out evidence: a lead-plus-subagents system "outperformed single-agent Claude Opus 4 by 90.2%"; "token usage by itself explains 80% of the variance"; "multi-agent systems use about 15× more tokens than chats"; and — **directly relevant to a coding harness** — "some domains that require all agents to share the same context or involve many dependencies between agents are not a good fit for multi-agent systems today. For instance, **most coding tasks involve fewer truly parallelizable tasks than research**." — **Vendor engineering blog reporting an internal eval.**

## 3. Gap analysis

| Dimension | CCv3 today | Frontier | Verdict |
|---|---|---|---|
| Loop shape (plan → act → verify) | Ralph 2.5 premortem → 3.5 per-task verification → 4.1.5 goal verifier; Maestro gated phases | External-feedback verification is the established fix for the self-correction limit (src 3); tool-grounded tests are the signal (src 5) | **Even/ahead** — unchanged conclusion from two prior passes |
| Bounded iteration + fresh context | 10/30/50 tiers, max-3 retry, fresh-context re-prompting | Exponentially declining success with task length (src 4); frontier agents <65% on 89 realistic terminal tasks (src 5); context is finite with diminishing returns (src 6) | **Ahead** — bounded loops with context resets are precisely the mitigation the evidence implies |
| Reviewer fan-out breadth | `/review` Phase 1 runs `critic` ∥ `codex-adversary` ∥ `plan-reviewer`; roster also offers `grok-adversary`, `principal-reviewer` | 9 judges ≈ 2 effective votes; best single judge ≥ full panel; more judges and better aggregation don't help (src 2) | **Over-built along the wrong axis** — our value comes from cross-*family* diversity (Codex/Grok), not reviewer count |
| Fan-out on coding work | Ralph fans subagents across tasks; agents proposals push structured parallel returns | Vendor states coding has "fewer truly parallelizable tasks than research" and costs ~15× tokens (src 7) | **Watch the cost side** — the 90.2% headline we've leaned on is a *research* result the same post declines to extend to coding |
| Deterministic control plane | Workflow tool available (incl. headless) with **0 saved scripts**; but `lane.mjs` is a genuinely deterministic, leased, fail-loud coordination plane | Predefined code paths remain the reliability-leader position | **Split** — behind on the Workflow tool, ahead in the coordination lane |
| Knowing *which* workflow failures actually occur | No failure taxonomy, no classified trace corpus | MAST: 14 modes / 3 categories, 1600+ annotated traces, plus a reusable LLM-as-Judge classifier (src 1) | **Behind — and this is the gap that explains all the others** |
| Doc/skill truthfulness | `CURRENT-STATE.md:39` says the enforcers are dead; `ralph/SKILL.md:33` + `maestro/SKILL.md:37-39` say they hard-block; RULES.md says soft since 2026-04-23 | n/a — internal correctness | **Open, third pass running** |

**The meta-gap.** R1/R2/R4 have been re-derived from frontier reading three times and executed zero times. Continuing to re-propose them is the loop's own version of the failure MAST names in category 3 (task verification): work is declared and never verified as landed. A fourth identical proposal has negative expected value. The choice now is *ship or close*, and either is a legitimate outcome.

## 4. Recommendations

**R-A — Ship R1 + R6 in one sitting, or formally close them. ADOPT (highest priority).**
These are the two genuinely ~1-hour items and neither needs a plan or a premortem.
- **R6 (doc truth-up)** is pure correctness debt with a live contradiction in three files: `CURRENT-STATE.md:39` under-claims (says dead), `ralph/SKILL.md:33` and `maestro/SKILL.md:37-39` over-claim (say hard-block), and RULES.md says soft-since-2026-04-23. Every session that reads any of them is misled in one direction or the other. Edit the three files to state what is verified; leave the *behavioral* gate probe as a separate follow-up (it depends on ST-02 identity).
- **R1 (plan-compliance)** is a prompt extension to `SKILL.md:274-278`: have the 4.1.5 `plan-reviewer` also grade the diff against `/tasks/tasks-<feature>.md` — flagging files touched outside the declared list and tasks marked complete with no corresponding diff. Additive, blocks nothing new by itself.
**If they are not shipped in the next interactive session, close them in BACKLOG.md as "considered, declined"** so the loop stops re-costing them. Effort **S**. Risk near zero.

**R-B — Prune the reviewer fan-out to cross-family, don't grow it. ADOPT (a subtraction).**
Src 2 is the sharpest new evidence of the period and it points *against* more reviewers: 9 judges from 7 families carried ~2 independent votes, the panel came in 8–22pp under the independent-voting ideal, and the best single judge matched or beat the panel in every condition — because errors correlate, not because aggregation was naive. Applied to `/review` Phase 1: keep the tool-grounded signal (tests/typecheck) plus **one Claude-family reviewer and one non-Claude-family reviewer** (`codex-adversary`, or `grok-adversary` when Grok is unparked — it is currently parked per the harness notes), and treat a *third same-family* reviewer as buying little. This also settles 07-15's open question 2 (one cross-model opinion vs. a fuller panel) in favor of one, and it converges with the 07-18 observability digest's independent conclusion to "skip judge panels". **Caveat stated plainly: src 2 tested NLI and RewardBench, not code review** — so this is a defensible default, not a proven transfer. The `codex-lift.jsonl` telemetry we already write (`claude_only`/`codex_only`/`both`) is the instrument that can confirm or refute it on our own data. Effort **S** (skill edit + a telemetry read). Risk: losing a reviewer that was catching real findings — mitigated by checking `codex-lift.jsonl` before pruning.

**R-C — Classify our own workflow failures against MAST before building more verification. ADOPT (measurement, replaces speculation).**
Every prior pass has had to write `[Speculation]` next to "does this failure actually happen to us?" — R3's resume-idempotency window is the standing example, unanswered since 07-03. MAST (src 1) supplies exactly the missing instrument: a 14-mode / 3-category taxonomy validated at κ=0.88 **and a published LLM-as-Judge classifier** for auto-labeling traces. Run it over the Ralph/agent traces we already retain and produce a one-page distribution: which of the 14 modes actually fire in CCv3, and how often. That converts the workflow backlog from "frontier says X is good" into "our category-3 (task verification) failures are N% of incidents, so R1/R2 are worth it" — or into evidence to close them. Effort **M** (one-off analysis script + a read over retained traces). Risk: our traces may not be rich enough to classify — in which case *that* is the finding, and it feeds SG-04's telemetry-joinability arc.

**R-D — First saved Workflow-tool script (`/review` Phase 1). WATCH (demoted from ADOPT).**
Carried unchanged in substance from 07-03 and 07-15, but I am demoting it because R-B may *shrink* the fan-out it was going to encode, and because the still-unresolved question of where `.claude/workflows/` lives in `SYNC_DIRS` (`.claude/rules/sync-known-gaps.md`) has blocked it twice. Sequence it after R-B settles the reviewer set, so we encode the final shape once rather than encoding and then editing. Effort **M**.

**R-E — Resume-idempotency audit (R3). WATCH (folded into R-C).**
Rather than a standalone audit that has failed to get scheduled three times, let R-C's trace classification answer whether a crash-during-resume double-apply has *ever* occurred. If MAST classification shows zero such incidents, this closes cheaply; if it shows any, the audit gets a concrete specimen to work from instead of a hypothetical. **[Speculation: the window exists but has never fired in practice — the classification tests this.]**

**R-F — Re-examine fan-out cost on coding tasks. WATCH.**
Src 7 is the post CCv3 has cited as validation for multi-agent work, and it contains a caveat we have not carried: coding involves "fewer truly parallelizable tasks than research", at ~15× the tokens of chat. This does not argue against Ralph's *sequential* delegation (which is about context isolation, not parallelism — and is supported by src 6). It argues against reflexively widening *parallel* coding fan-out. No action now; note it wherever the 90.2% figure gets cited as justification.

**R-G — Difficulty-aware iteration tiering. SKIP.** Unchanged from 07-15's R7. Ralph's 10/30/50 size tiers work at single-operator scale; a learned difficulty estimator is over-built. Revisit only if tiers visibly mis-allocate.

## 5. Integration approach

| Rec | Files / subsystems | BACKLOG tie | Effort | Risk |
|---|---|---|---|---|
| **R-A** doc truth-up + plan-compliance | `docs/system-update/CURRENT-STATE.md:39`, `BACKLOG.md:37,49`, `.claude/skills/ralph/SKILL.md:33,274-278`, `.claude/skills/maestro/SKILL.md:37-39` | Closes the `QW-04` reporting loop; behavioral gate-probe stays blocked on **ST-02** (shared `session_id` can't separate orchestrator from subagent) | S | Near zero — doc + prompt edits |
| **R-B** prune reviewer fan-out | `.claude/skills/review/SKILL.md` Phase 1; reads `.claude/logs/codex-lift.jsonl` | Converges with the 07-18 observability digest; feeds **SG-04** (codex-lift ROI re-examination is already an SG-04 line item) | S | Removing a reviewer that was earning its slot — check telemetry first |
| **R-C** MAST classification of our traces | New one-off script under `scripts/` (analysis only); reads retained Ralph/agent traces + Braintrust rows | Directly serves **SG-04** (telemetry joinability / intel-bus consumer); may retire or confirm R-D/R-E | M | Traces may be too thin to classify — that is itself a SG-04 finding |
| **R-D** saved Workflow script | new `.claude/workflows/`; `.claude/rules/sync-known-gaps.md` (SYNC_DIRS decision) | delivers the agents-proposal structured-return contract for the review path | M | Skill/script behavior fork — have the skill *invoke* the script |
| **R-E** resume idempotency | `scripts/ralph/ralph-state-v2.py`, `ralph-progress-sync.py` (+ `test_ralph_state_v2.py` as the net) | folded into R-C | S audit | Touches Hook-Source-Regression-class state files — emit-guard discipline applies |

**Sequencing.** R-A first (it is the cheapest and it is *correctness*, not enhancement). R-C next, because it is the only item that can retire other items. R-B is independent and can go any time after a `codex-lift.jsonl` read. R-D waits on R-B. R-E is subsumed.

**What could go wrong.** R-A's plan-compliance addition makes the 4.1.5 prompt longer and could dilute the goal-verification it already does — keep it as a clearly separated second section with its own output block. R-B could remove a reviewer that was quietly catching real defects; the mitigation is a telemetry read before the edit, not a judgment call. R-C could produce an unclassifiable trace corpus and burn effort for a null result — bound it to one pass and treat "our traces are too thin" as a publishable finding rather than a failure. R-D remains at risk of forking behavior between skill prose and script.

## 6. Benefits

- **The loop stops paying for the same analysis.** Three passes have now costed R1/R2/R4. R-A forces the binary — ship the two cheap ones or close them — which either delivers the value or stops the recurring spend. That is the concrete win from this pass.
- **Docs that don't lie in two directions at once.** Today `CURRENT-STATE.md:39` tells a session the workflow enforcers are dead while `ralph/SKILL.md:33` tells it they hard-block, and RULES.md contradicts the latter. Any session reading one of the three acts on a false premise.
- **A cheaper, evidence-defensible review gate.** R-B is a *subtraction* justified by a verified study: more reviewers from correlated families do not buy independent signal, and the best single judge matched the 9-judge panel in every condition tested. Fewer spawns, same expected precision, lower Codex/Grok quota burn.
- **Decisions from our own data instead of frontier analogy.** R-C gives Dave a one-page answer to "which workflow failures actually happen here" — the question every prior pass had to mark `[Speculation]`. It can also *retire* backlog items, which is the rarest and most valuable outcome a research pass can produce.
- **Confirmation that the expensive parts are right.** Bounded iteration, fresh-context re-prompting, premortem gating, and external (tool-grounded) verification remain vindicated by src 3–7. Nothing here is a rebuild.

## 7. Open questions

1. **Ship or close?** Are R1/R6 (and R2/R4) still wanted, or should they be closed in `BACKLOG.md` as declined? Three passes of re-proposal without execution is the signal that this needs an explicit decision, not a fourth proposal.
2. Does `codex-lift.jsonl` show `codex_only` findings at a rate that justifies the cross-model reviewer — and does `critic` (same family as `plan-reviewer`) contribute findings neither of the others catches? R-B's pruning should follow that data, not the NLI study alone.
3. Are our retained Ralph/agent traces rich enough for MAST classification (agent boundaries, task ids, failure reasons), or does that require ST-02 identity joinability first? This determines whether R-C is runnable now or is gated.
4. Do the now-live `Task`-matcher enforcers actually *gate* or merely log? Unchanged from 07-15 Q4 — still blocked on ST-02's two-level `session_id` + `agent_id` identity.
5. Should the workflow component's centre of gravity formally move to the coordination lane? `lane.mjs` is the deterministic, leased, fail-loud orchestration surface that actually got built this month; Ralph/Maestro have not changed. If that reallocation is intentional, the component definition (and `CURRENT-STATE.md`'s Workflows row) should say so.
6. Where does `.claude/workflows/` live so it syncs like skills? Still absent from `SYNC_DIRS` (`.claude/rules/sync-known-gaps.md`) — open since 07-03 and blocking R-D for a third pass.
