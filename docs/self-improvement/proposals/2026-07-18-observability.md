---
date: 2026-07-18
component: observability
component_name: Braintrust Observability
verdict: adopt
headline: Keep the deterministic-first/judge-second split (frontier-validated); the real gap is step-level scoring of sub-agent work — extend the judges from session-outcome to step/trajectory once ST-02 makes ids joinable, and skip judge panels (verified evidence they add ~nothing).
sources: 9
---

# Braintrust Observability — Next-Evolution Proposal (2026-07-18)

## 1. Where CCv3 is today

Two-layer design (documented in `~/.claude/docs/architecture/subsystems/braintrust.md`; the repo-side manifest pointer to `.claude/hooks/src/shared/braintrust-client.ts` is stale — the actual helper is `.claude/hooks/src/shared/braintrust-score.ts`):

- **Layer 1 — deterministic scores, live in the hook path.** Four TS emit sites call `await emitBraintrustScore(...)` via `braintrust-score.ts` (fail-open, 2s timeout, feedback POST to `/v1/project_logs/{project_id}/feedback` — `braintrust-score.ts:30,211`). Seven score dimensions total (incl. Python `store_learning.py`'s `memory_store_quality`). The emit invariant is guarded by `scripts/audit-braintrust-emits.sh` (`INVARIANT_4=4`, `await`-only grep, plus the WS-2 context-bus export surface guard at lines 44–63) after the May-2026 regression cluster.
- **Layer 2 — LLM judges, offline, sampled.** `opc/scripts/core/judge_session.py` runs 3 judges (`factuality`, `closedqa`, `plan_rubric`) on a deterministic ~35% sample, via **subscription-OAuth CLIs** (`claude -p` for two, `codex exec` for cross-model plan grading) — no API keys. Idempotent feedback ids; scheduled as `CCv3-Judge-Batch` (Windows Task Scheduler, local-only because a Braintrust UI rule cannot reach local CLIs — subsystem doc §Layer 2).

Known limitations (already named in `docs/system-update/CURRENT-STATE.md:40` and BACKLOG):

1. **`agent_task_success` is dead** — its emitter `ralph-task-monitor.ts` is caught in the Agent/Task matcher split-brain (CURRENT-STATE.md Braintrust row + Workflows row). One of the 4 guarded emit sites produces no data.
2. **60.7% corr-null** — 7 competing `getSessionId` schemes mean most scores can't be joined to their spans/sessions (`docs/system-update/BACKLOG.md:59`, ST-02).
3. **Sub-agent blindness** — `closedqa` skips nested Task spans with reason `nested_subagent_no_correlation`; sub-agent correlation is explicitly "deferred Phase 4 work" (subsystem doc §closedqa).
4. **Outcome-only judging** — all three judges score a whole artifact (recall chunk, task answer, plan) with no step-level view of *where* a session went wrong.
5. **Telemetry joinability** is an open arc (SG-04, `BACKLOG.md:97`).

## 2. Frontier scan

All URLs below were fetched and verified this run (2026-07-18).

- **OTel GenAI semantic conventions: still not Stable, and mid-migration.** The agent-spans page on opentelemetry.io now redirects to a dedicated repo — [github.com/open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai) — covering GenAI spans/metrics/events + MCP; no Stable designation is visible on the repo, and the schema URL is still a TODO. Vendor adoption is fragmented (Arize Phoenix remains on its own OpenInference semconv per oracle research, snippet-verified only).
- **Claude Code now ships native OTel, including hook and tool spans.** [code.claude.com/docs/en/monitoring-usage](https://code.claude.com/docs/en/monitoring-usage): `CLAUDE_CODE_ENABLE_TELEMETRY=1` exports 8 metrics and 15+ event types (incl. `claude_code.tool_result`, `claude_code.tool_decision`, `claude_code.hook_execution_complete`), and a **traces beta** (`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`) emits a span hierarchy `claude_code.interaction → llm_request / hook / tool.execution` with `session.id` on every signal. This is first-party span substrate that CCv3's homegrown Python span layer currently builds by hand.
- **Online/production scoring is mature at the vendor layer.** Braintrust online scoring rules auto-run scorers on production logs with sampling rates, SQL span filters, and `POST /v1/project_score` ([braintrust.dev/docs/evaluate/score-online](https://www.braintrust.dev/docs/evaluate/score-online)). Langfuse shipped **observation-level (per-span) LLM-as-judge evals** in Feb 2026 — scoring individual tool executions/LLM calls instead of only whole traces ([langfuse.com/changelog/2026-02-13-observation-level-evals](https://langfuse.com/changelog/2026-02-13-observation-level-evals)). The industry direction is step-level, not more whole-session judges.
- **Step-level agent evaluation has a strong verified result.** *AgentEval: DAG-Structured Step-Level Evaluation for Agentic Workflows with Error Propagation Tracking* ([arXiv:2604.23581](https://arxiv.org/abs/2604.23581), ACL 2026 Industry Track) formalizes agent runs as evaluation DAGs with a 3-level/21-subcategory failure taxonomy; DAG dependency modeling alone adds **+22pp failure-detection recall and +34pp root-cause accuracy** over flat step scoring with the same judge.
- **Judge panels are largely wasted spend.** *Nine Judges, Two Effective Votes: Correlated Errors Undermine LLM Evaluation Panels* ([arXiv:2605.29800](https://arxiv.org/abs/2605.29800)): a 9-judge panel "effectively provide[s] only about 2 independent votes' worth of information" — roughly three-quarters of nominal independence is lost to correlated errors.
- **Judge scoring bias is quantifiable.** *Evaluating Scoring Bias in LLM-as-a-Judge* ([arXiv:2506.22316](https://arxiv.org/abs/2506.22316)) identifies rubric-order bias, score-ID bias, and reference-answer-score bias, with a framework for quantifying them and "actionable insights for designing more robust scoring prompts." (Note: specific calibration-technique names circulating in secondary sources are not in this abstract.)
- **Closest prior art to our pattern.** [langfuse/claude-observability-plugin](https://github.com/langfuse/claude-observability-plugin) — Stop + SessionEnd hooks incrementally read the session transcript and emit one span per turn with nested generations and child tool spans, deduped via a local state file. [disler/claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability) — 12 hook event types → HTTP → SQLite → live multi-agent dashboard. Both confirm hooks-emit-to-backend is the community-standard mechanism; neither does scoring, which remains CCv3's differentiator.

## 3. Gap analysis

**Where we're ahead or even:**
- *Deterministic-first, judge-second split* — the 2026 practice guidance is exactly this: prefer code-based graders wherever deterministic, gate on an LLM judge only where needed ([Digital Applied methodology guide, snippet-verified via oracle]; the structural point also follows from Braintrust's own sampling-based online-scoring design). Our split is validated, not legacy.
- *Cross-model judging* — `plan_rubric` routed to Codex so GPT grades Claude plans is a form of decorrelation the Nine-Judges paper implicitly endorses (different family ≈ the only way to get a genuinely independent vote).
- *Emit-invariant + audit guard* — no equivalent found in the surveyed ecosystem; "the harness scores its own hook layer and guards the scorer itself against regression" appears to be a relatively novel framing (oracle found no counter-evidence; weak claim, [Speculation] as a novelty assertion).
- *Idempotent, deterministic sampling* — matches the Braintrust online-scoring sampling model, just executed locally.

**Where we're behind:**
- *Step-level visibility.* Langfuse scores individual spans; AgentEval shows large measured gains from step-level + dependency-aware evaluation. Our judges are outcome-only and explicitly skip sub-agent (nested Task) spans. Combined with `agent_task_success` being dead, the agent layer is close to observability-blind — precisely the layer where CCv3 does most of its work (kraken waves, review pipeline).
- *Score joinability.* 60.7% corr-null means a majority of emitted scores can't answer "which session/span did this score describe" — frontier online-scoring pipelines assume joinable ids as table stakes.
- *Judge calibration.* We have rubrics but zero measurement of judge-vs-human agreement or scoring bias; arXiv:2506.22316 shows judges have systematic score-level biases that rubric prose alone doesn't fix.
- *First-party trace substrate unused.* Claude Code's native OTel (esp. the traces beta with `claude_code.hook`/`tool` spans and consistent `session.id`) overlaps heavily with what our Python span hooks hand-build; we haven't evaluated it.

## 4. Recommendations

1. **ADOPT — Step-level judging of sub-agent work (the "Phase 4" that never got scheduled).** After ST-02 lands (single canonical `session_id` + `agent_id`), extend `judge_session.py` `closedqa` to nested Task spans, and add a *lightweight* per-step failure tag (a 5–8 category taxonomy: wrong-tool, bad-input, ignored-context, fabricated-success, scope-creep, env-failure) recorded in score metadata. Do NOT build a full AgentEval DAG — the paper's core lesson (score steps, attribute failures to upstream steps) is capturable with parent-span links we already have. Rationale: largest measured frontier gain (+22pp/+34pp class results for step-aware evaluation, arXiv:2604.23581); directly fixes our named sub-agent blind spot.
2. **ADOPT — Judge calibration gold set.** One-time: hand-label ~30–50 sampled judge outputs (Dave or an interactive session grades the same inputs), compute agreement per judge, and apply the arXiv:2506.22316 bias checks (vary rubric order and score-ID format on a small grid). Cheap, turns "we have judges" into "we know how much to trust each judge." Store the gold set under `opc/` as a fixture so rubric edits can be regression-checked against it.
3. **ADOPT (gated spike, ~half a day) — Turn on Claude Code native OTel side-by-side.** Enable `CLAUDE_CODE_ENABLE_TELEMETRY=1` (+ traces beta) exporting to console/local collector for a few sessions and compare against the homegrown Python span layer. Decision output: whether native `claude_code.*` spans (with their consistent `session.id`) can become the span substrate our feedback POSTs attach to — which would shrink the 60.7% corr-null problem at the source and retire hand-built span code. Gated: traces are beta; do not rip anything out on the spike's evidence alone.
4. **SKIP — Panel-of-judges / adding more judges per dimension.** Verified evidence says correlated judges add almost no independent signal (arXiv:2605.29800). Our one-judge-per-dimension + cross-family routing is the right shape; spend on calibration (item 2) instead.
5. **SKIP — Migrating judges to Braintrust online-scoring UI rules.** Already correctly ruled out in the subsystem doc: the judges run on subscription CLIs a cloud rule can't invoke, and moving them would convert zero-marginal-cost subscription quota into metered API spend. The local scheduled batch IS our online-scoring loop.
6. **WATCH — OTel GenAI semconv alignment.** Still Development-status and mid-repo-migration; vendors haven't converged. Revisit when the semconv-genai repo cuts a Stable (or Braintrust announces native `gen_ai.*` ingestion). If item 3's spike goes well we get OTel-shaped data for free anyway.
7. **WATCH — Failure-promotion loop (production traces → regression dataset).** The Braintrust/Langfuse converged pattern is "score a sample, promote failures into an eval suite." For us: sessions scoring low on any judge get their input/output pair appended to a small local regression set. Valuable, but only meaningful after items 1–2 make the scores trustworthy and joinable.
8. **Precondition (internal hygiene, not frontier) — revive `agent_task_success`.** The dead Agent/Task matcher on `ralph-task-monitor.ts` (CURRENT-STATE.md:40) should be fixed with the rest of the matcher split-brain cluster; step-level judging (item 1) is far less useful while the deterministic agent-success signal is dark.

## 5. Integration approach

| Item | Files/subsystems | BACKLOG tie | Effort | Risk |
|------|------------------|-------------|--------|------|
| 1. Step-level sub-agent judging | `opc/scripts/core/judge_session.py` (closedqa span walker + failure-tag metadata); subsystem doc; possibly +1 judge dimension → bump `INVARIANT_4` only if a TS emit is added (none planned) | **ST-02** (hard prerequisite — ids must join), **SG-04** (the new step scores are exactly the joinable telemetry SG-04 wants), closes the documented "Phase 4 sub-agent correlation" deferral | M (judge-runner-only change; no hook-path edits, so no emit-guard exposure) | Judge quota growth — mitigate by keeping the 35% sampler and capping steps judged per session (e.g. top-level + first-level Tasks only); prompt-injection surface unchanged (same read-only CLI backends) |
| 2. Calibration gold set | new `opc/scripts/core/fixtures/judge-gold/` + a small `judge_calibration.py` compare script | none directly; strengthens FH-03's judge batch | S–M (the labeling hour is the real cost) | Low; worst case we learn a judge is unreliable — which is the point |
| 3. Native OTel spike | env-only experiment + a short findings doc under `docs/`; NO code changes in the spike | **ST-02** (native `session.id` could collapse the 7-scheme problem), SG-04 | S (half-day) | Traces are beta and may change shape; also verify nothing sensitive leaves the box — export to console/local collector only, never a third-party endpoint in the spike |
| 8. Revive `agent_task_success` | `~/.claude/settings.json` matcher fix (Node atomic write) + `ralph-task-monitor.ts` verification; `audit-braintrust-emits.sh` re-run | part of the CURRENT-STATE matcher split-brain cluster (QW-class) | S | **Hook Source Regression territory** — any `hooks/src` edit must follow the emit-guard + post-edit audit discipline (`scripts/audit-braintrust-emits.sh`), per the documented regression history |

Sequencing: **8 → 2 (parallel-safe) → ST-02 lands → 1 → 3's decision → 7.**

What could go wrong: item 1 depends on ST-02, which is itself gated and DELICATE-adjacent — if ST-02 slips, item 1 should not be attempted against the current 7-scheme identity mess (it would inherit the 60.7% corr-null and produce unjoinable step scores). Item 3's temptation is to start replacing the Python span layer on beta evidence — resist; spike is read-only.

## 6. Benefits

- **Dave can finally see *where* agent sessions fail, not just that they did.** Today a bad kraken wave shows up (at best) as one low `closedqa` score on the top-level Task; with step-level judging + failure tags, the Braintrust UI answers "which sub-agent, which step, which failure class" — the AgentEval-class capability, at local scale.
- **Trustworthy judges.** After calibration, a low `plan_rubric` score is actionable instead of "maybe the judge is biased" — and rubric edits become regression-testable against the gold set.
- **Cheaper, simpler plumbing (potential).** If the native-OTel spike pans out, hand-built span code shrinks and the session-id fragmentation problem gets attacked at the source rather than patched at 7 call sites.
- **No new spend.** Everything proposed runs on the existing subscription-CLI judge model and local scheduling; the explicit SKIPs (panels, cloud scoring rules) avoid the two most tempting ways to convert this pillar into metered API cost.

## 7. Open questions

1. Does Claude Code's traces-beta `session.id` match the id the hooks see (`session_id` from hook input)? If yes, ST-02 gets a free canonical source; if no, the spike must document the mapping. (Testable in the item-3 spike.)
2. How much judge quota does first-level Task-span coverage add in practice? Need a dry-run count (`judge_session.py --dry-run` extended to report candidate step spans per session) before fixing the cap.
3. Is there appetite to hand-label the ~30–50 gold examples (item 2's only real cost), or should an interactive session pre-label and Dave spot-check?
4. [Speculation] The emit-invariant guard as "self-scoring harness" framing may be worth a short write-up — oracle found no named equivalent in the ecosystem; if genuinely novel it's a candidate for the public repo's docs.
