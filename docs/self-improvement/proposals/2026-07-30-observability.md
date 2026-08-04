---
date: 2026-07-30
component: observability
component_name: Braintrust Observability
verdict: adopt
headline: The sub-agent correlation CCv3 deferred as "Phase 4" is now available first-party — Claude Code's beta OTel traces nest subagent spans under the parent and stamp session.id on every signal, and Braintrust ingests OTLP directly — so the twice-approved-never-run native-OTel spike now attacks the 60.7% corr-null, the sub-agent blind spot, and the measured ~690 ms/tool-call synchronous emit cost with one experiment; meanwhile the calibration gap finally has a named method with public code (PPI / Rogan–Gladen, arXiv:2601.05420) instead of just "build a gold set".
sources: 9
---

# Braintrust Observability — Next-Evolution Proposal (2026-07-30)

> **Third pass on this component.** Prior proposals: [`2026-07-05-observability.md`](./2026-07-05-observability.md) and [`2026-07-18-observability.md`](./2026-07-18-observability.md). This one deliberately does **not** re-derive their frontier scans. Its job is (a) to correct a baseline that both of them got wrong, (b) to report that their ADOPTs have not shipped, and (c) to add what is genuinely new since 07-18. Where I cite a paper, I fetched and quote-verified it myself this run; I did **not** re-verify the arXiv IDs those two proposals cite, so none of their numeric claims are carried forward here.

## 1. Where CCv3 is today

**Layer 1 — deterministic scores, live in the hook path.** Four TypeScript emit sites call `await emitBraintrustScore(...)` from `.claude/hooks/src/shared/braintrust-score.ts`; fail-open by contract, 2 s `AbortSignal.timeout`, POST to `/v1/project_logs/{project_id}/feedback` (`braintrust-score.ts:352`). Seven score dimensions counting Python `store_learning.py`'s `memory_store_quality` (`.claude/docs/architecture/subsystems/braintrust.md:40-48`).

**Layer 2 — LLM judges, offline and sampled.** `opc/scripts/core/judge_session.py`: three judges (`factuality`, `closedqa` via `claude -p`; `plan_rubric` via `codex exec` for cross-family grading), deterministic ~35% sampler (`SAMPLE_RATE_PERCENT = 35`, `judge_session.py:133`), idempotent feedback ids, scheduled locally as `CCv3-Judge-Batch` because subscription CLIs are unreachable from a cloud rule.

**Two guards, deliberately different in kind.** `scripts/audit-braintrust-emits.sh` counts `await emitBraintrustScore(` call sites against `INVARIANT_4=4`. `scripts/hooks/braintrust-emit-guard.mjs` is the newer complement asserting *reachability*, with a `--live` mode that queries the API for distinct recent score names.

### What changed since the 2026-07-18 proposal — and it changes the reading

1. **The entire Layer 1 had been inert, and the presence guard reported green throughout.** The audit script now says so in its own header: it "reported OK 4/4 continuously through the entire period in which ZERO of the four could emit anything (root-caused 2026-07-28: node hooks never received `TRACE_TO_BRAINTRUST` / `BRAINTRUST_API_KEY`, and three emitters resolved their span from an env var set in no location)" (`scripts/audit-braintrust-emits.sh:7-26`). Both prior proposals wrote gap analyses treating Layer 1 as producing data. It was not.
2. **The off switch never worked until `688228f`.** `loadClaudeDotEnv()` merged `~/.claude/.env` (which says `true`) into `process.env` *inside* `isTraceEnabled()`, so an environment `false` was overwritten before the comparison — "proven by execution: the module POSTed … using the **file's** API key while `process.env.TRACE_TO_BRAINTRUST` was `'false'`" (`docs/harness-strategy/README.md:192-200`). Both layers are now fixed and an explicit environment value wins for that one variable (`braintrust-score.ts:200-207`). ✓ VERIFIED live: `~/.claude/.env` currently has `TRACE_TO_BRAINTRUST=true`.
3. **Tracing has a measured price: ~640–690 ms per tool call, on every PostToolUse** (A/B on real turns, 12 per arm: ON p50 955 ms, OFF 317 ms — `README.md:185-187`). The standing decision is "**STAYS ON** … it is the only live telemetry" (`README.md:223-226`). This number did not exist when the earlier proposals were written.
4. **`agent_task_success` is no longer dead by matcher.** ✓ VERIFIED by reading the live registration: `ralph-task-monitor` is registered `PostToolUse` / `matcher=Task` in `~/.claude/settings.json` (and `telemetry-tracker` on `Skill|Task`). `docs/system-update/CURRENT-STATE.md:40` still asserts "`agent_task_success` dead (Agent matcher)" — that line is **stale**.
5. **`BRAINTRUST_SESSION_ID` was retired** by `2542561`; two test files that asserted it were fixed, and some of their "returns null" tests had been passing vacuously (`README.md:121-124`).
6. 🔑 **Key rotation is still outstanding** — a failing test read the real `~/.claude/.env` and printed `Authorization: Bearer sk-…` into its output (`README.md:211-216`). This is Dave's action, not a code change.

### What the prior proposals recommended and has *not* shipped

| Prior ADOPT | Status (verified this run) |
|---|---|
| Step-level / sub-agent judging (07-18 item 1) | **Not started.** `judge_session.py:856-857` still skips with `nested_subagent_no_correlation`. |
| Judge calibration gold set (07-05, 07-18 item 2) | **Not started.** No `judge-gold` fixture or `judge_calibration.py` anywhere under `opc/`. |
| Native OTel side-by-side spike (07-05 WATCH → 07-18 item 3 ADOPT) | **Not run.** No findings doc exists. |

### One more live gap, verified by absence

`braintrust-emit-guard.mjs` — the *only* artifact that can detect the failure mode that hid for months — is referenced in exactly 5 files (ripgrep, whole repo): three `docs/harness-strategy/` documents, `audit-braintrust-emits.sh`'s header, and itself. It is **not** wired into `opc/scripts/health_check.py`, any `.bat` scheduled task, or any test. It is a manual command. Its last recorded run passed: "114 sources, 4 emit sites / 4 hooks, config reachable, 0 dead span sources" (`README.md:20`).

Carried-over structural limits, unchanged: **60.7% corr-null** from 7 competing `getSessionId` schemes (`CURRENT-STATE.md:13`, arc **ST-02**); telemetry joinability is its own arc (**SG-04**, `BACKLOG.md:97`); repo↔active registration drift (only 2 of the 4 emitters appear in the repo's `.claude/settings.json`) is arc **SG-02**.

Also still stale, third proposal running: the component manifest points at `.claude/hooks/src/shared/braintrust-client.ts`, which does not exist.

## 2. Frontier scan

All nine sources below were fetched and quote-verified by me this run (not by a research subagent).

1. **Claude Code emits subagent-correlated spans natively, and stamps `session.id` on every signal.** [code.claude.com/docs/en/monitoring-usage](https://code.claude.com/docs/en/monitoring-usage): tracing is off by default and enabled with `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` + `OTEL_TRACES_EXPORTER`. The span hierarchy is `claude_code.interaction` → `claude_code.llm_request` / `claude_code.hook` / `claude_code.tool` → `claude_code.tool.execution`, and — the load-bearing detail — **`(Agent tool) subagent claude_code.llm_request / claude_code.tool` spans nest under the parent tool span**. `session.id` is a standard attribute, included by default. Traces are explicitly **beta**.
2. **Braintrust ingests OTLP directly.** [braintrust.dev/docs/integrations/sdk-integrations/opentelemetry](https://www.braintrust.dev/docs/integrations/sdk-integrations/opentelemetry): endpoint `https://api.braintrust.dev/otel/v1/traces` (EU variant available), headers `Authorization=Bearer <key>, x-bt-parent=project_id:<id>`; `x-bt-parent` also accepts `project_name:`, `experiment_id:`, or a span slug for nesting. Documented constraint: "Braintrust's logs table only shows traces that have a root span (i.e. `span_parents` is empty)." It references `gen_ai.*` semantic conventions and OpenLLMetry.
3. **Online scoring is async by construction at the vendor layer.** [braintrust.dev/docs/evaluate/score-online](https://www.braintrust.dev/docs/evaluate/score-online): scoring runs "asynchronously in the background" and "without adding latency to your application"; sampling rate is configurable with guidance of "lower rates (1-10%)" for high-volume and "higher rates (50-100%)" for low-volume/critical; scope is trace-level (default) or span-level. Scorers execute inside Braintrust's infrastructure.
4. **Calibrating a noisy judge from a small human-labeled sample is a named, implemented method.** *Efficient Inference for Noisy LLM-as-a-Judge Evaluation*, Chen, Lu, Li, Guo, Li, 8 Jan 2026 — [arXiv:2601.05420](https://arxiv.org/abs/2601.05420). Verbatim: "Two main approaches have recently been proposed to address this issue: (i) direct measurement error correction based on misclassification models such as Rogan-Gladen-style estimators, and (ii) surrogate-outcome approaches such as prediction-powered inference (PPI), which correct bias by calibrating prediction residuals on a small set of gold-standard human labels."
5. **Report Cohen's κ; the rest of the usual agreement panel is redundant.** *Agreement Metrics for LLM-as-Judge Evaluation: What to Report and Why*, Rao & Callison-Burch, 25 May 2026 — [arXiv:2606.00093](https://arxiv.org/abs/2606.00093). Verbatim: "Pearson's r, Spearman's ρ, Kendall's τb, the phi coefficient φ, and the Matthews Correlation Coefficient all reduce to a single number on non-redundant binary data, so reporting several of them only creates an illusion of corroborating evidence." And: "Cohen's κ is the one agreement coefficient that adds information."
6. **Adding judges to a panel buys little independent signal.** *Nine Judges, Two Effective Votes: Correlated Errors Undermine LLM Evaluation Panels*, Kohli, 28 May 2026 — [arXiv:2605.29800](https://arxiv.org/abs/2605.29800). Verbatim: "we find that the 9 judges effectively provide only about 2 independent votes' worth of information"; roughly three-quarters of nominal independence is lost to models erring identically, and the best single model matches or exceeds the full panel across tested conditions.
7. **But a panel of *small, disjoint-family* judges can substitute for one large judge, mainly on cost.** *Replacing Judges with Juries: Evaluating LLM Generations with a Panel of Diverse Models* (PoLL), Verga et al., 29 Apr 2024 — [arXiv:2404.18796](https://arxiv.org/abs/2404.18796). Verbatim: "using a PoLL composed of a larger number of smaller models outperforms a single large judge", "exhibits less intra-model bias due to its composition of disjoint model families", and does so "while being over seven times less expensive".
8. **OTel GenAI semconv has moved and is versionless at its new home.** [opentelemetry.io/docs/specs/semconv/gen-ai/](https://opentelemetry.io/docs/specs/semconv/gen-ai/) now carries only a move notice: "GenAI semantic conventions have moved to the OpenTelemetry GenAI semantic conventions repository" and "This page has moved and is no longer maintained in this repository."
9. **The move target** — [github.com/open-telemetry/semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai), per the notice above. ✗ **UNCERTAIN:** I could not confirm a stability designation from the moved page, and I did not fetch the repo itself. Prior proposals recorded it as Development/experimental; treat "not Stable" as inherited, not verified this run.

**Reconciling 6 and 7** (they look contradictory and are not): PoLL's win is *substitution economics* — several cheap heterogeneous judges instead of one expensive one. Kohli's result is about *marginal information* — piling on judges of the same broad capability adds little. Both can hold. Which one applies to CCv3 depends entirely on whether judge calls cost money, and ours do not (subscription OAuth).

## 3. Gap analysis

**Where CCv3 is ahead or genuinely unusual**
- **Guarding the scorer itself, in two distinct modes** (presence *and* reachability, the second born from the first having lied for months). I found no equivalent in the surveyed vendor or OSS material. As a *novelty* claim this is weak evidence — absence of a search hit is not absence — so: `[Speculation]`.
- **Cross-family judging already in place.** `plan_rubric` routed to Codex so GPT grades Claude-authored plans is precisely the disjoint-family decorrelation PoLL credits for reduced intra-model bias, and it costs zero marginal dollars here.
- **Deterministic-first, judge-second, with deterministic sampling and idempotent ids** — structurally the same shape Braintrust's online scoring implements server-side.

**Where CCv3 is behind**
- **Scoring is *synchronous in the request path*; the frontier's is not.** Braintrust states online scoring adds no application latency. CCv3 pays a measured ~640–690 ms per tool call inside PostToolUse to get its telemetry. This is the sharpest divergence from current practice, and it is what forces the uncomfortable "keep tracing on and eat the latency, or lose the only live telemetry" trade recorded in `README.md:223-226`. Framed as a false dilemma: the cost is an artifact of *when and where* the POST happens, not of tracing itself.
- **Sub-agent work is unscored, and CCv3 does most of its work in sub-agents.** `closedqa` skips nested Task spans; `agent_task_success` only recently regained a live matcher. Meanwhile the harness itself now emits parent-nested subagent spans (finding 1) — the correlation that `judge_session.py:948-956` hand-derives from `parent_span_id` and then gives up on.
- **60.7% corr-null vs. a first-party `session.id` on every signal.** ST-02 proposes collapsing 7 id schemes into 1 by hand. Claude Code already stamps one consistently.
- **Judges have never been calibrated, and now there is no excuse.** 07-05 and 07-18 both said "build a gold set" without a method for turning labels into a correction. Finding 4 supplies the method and public code; finding 5 supplies the single metric to report.
- **The one guard that can detect silent death runs only when a human types it.** Given this component's documented history — a green guard over an inert layer for months — an unscheduled liveness check is the highest-probability repeat of the same failure.

**Where the frontier direction does not fit CCv3** (unchanged, and still correct)
- Server-side online scoring rules assume API-billed scorers. Our judges are subscription-OAuth local CLIs by design. The feature is real; the constraint is deliberate.

## 4. Recommendations

1. **ADOPT — Schedule `braintrust-emit-guard.mjs --live`.** Add it to `opc/scripts/health_check.py` (or the weekly `/health-check` task) so a silent scoring layer produces a red result without anyone remembering to check. This is the smallest change on this list and the one that most directly addresses the component's actual demonstrated failure mode. Keep `--live` out of any per-edit path — the guard's own header argues that a network-dependent gate run too often gets ignored, which is its own failure.
2. **ADOPT — Run the native-OTel spike, now, with a concrete decision brief.** Approved in 07-05 (as WATCH) and 07-18 (as ADOPT); never executed. Both ends are now verified rather than assumed: Claude Code emits parent-nested subagent spans with a consistent `session.id` (finding 1), and Braintrust accepts OTLP at a documented endpoint (finding 2). One experiment tests three things at once — does native `session.id` match the `session_id` hooks see (→ ST-02), do subagent spans arrive correlated (→ the `nested_subagent_no_correlation` deferral), and does exporting via a batching OTel exporter move the ~690 ms off the tool-call path (→ the `README.md:223` trade). **Export to a local collector or console only** in the spike; do not point a beta exporter at a third-party endpoint on the first run, and do not delete any hand-built span code on beta evidence.
3. **ADOPT — Calibrate the three judges properly, once, and report κ.** Hand-label a small sample per judge, then (a) report **Cohen's κ only** rather than a panel of redundant correlations (finding 5), and (b) apply a PPI or Rogan–Gladen-style correction to the aggregate scores using arXiv:2601.05420 as the reference implementation (finding 4). This supersedes 07-18's item 2: same labeling cost, but the labels now buy a *bias-corrected estimate* instead of only a comfort number. Store the labels as a fixture so rubric edits become regression-testable.
4. **ADOPT (documentation correctness, ~10 minutes) — fix two stale assertions.** `CURRENT-STATE.md:40` claims `agent_task_success` is dead on the Agent matcher; the live registration says `matcher=Task`. And the component manifest still points at the non-existent `braintrust-client.ts` — flagged by all three proposals now. Stale docs about a component whose defining failure was believing a green signal are not a cosmetic issue.
5. **SKIP — Judge panels / more judges per dimension.** Sharper rationale than prior passes: PoLL's demonstrated advantage is cost substitution (7× cheaper than one large judge — finding 7), and our judges already cost zero marginal dollars on subscription quota, so the upside PoLL measures is not available to us. What we would be buying is marginal independent signal, and that is what Kohli measures as largely absent (finding 6). Keep one judge per dimension plus the existing cross-family routing, which already captures the disjoint-family benefit PoLL credits.
6. **SKIP — Migrating the judges to Braintrust server-side online scoring.** Confirmed again from the vendor page: scorers run inside Braintrust's infrastructure (finding 3), which cannot invoke local subscription CLIs. Moving them converts zero-marginal-cost quota into metered spend. The local scheduled batch **is** our online-scoring loop.
7. **WATCH — OTel GenAI semconv stabilization.** The conventions moved repos and I could not confirm a stability level (finding 8/9). Also note Claude Code's spans are named `claude_code.*`, not `gen_ai.*`, so recommendation 2 does not depend on semconv stability at all. Revisit if Braintrust announces first-class `gen_ai.*` mapping or the new repo cuts a stable release.
8. **WATCH — Failure-promotion loop** (low-scoring sessions → a local regression set). Unchanged from 07-18: worth doing, but only after 1–3 make scores both trustworthy and joinable.

## 5. Integration approach

| # | Files / subsystems | BACKLOG tie | Effort | Risk |
|---|---|---|---|---|
| 1 | `opc/scripts/health_check.py` (new check invoking `scripts/hooks/braintrust-emit-guard.mjs --live --json`); possibly the weekly health-check task definition | strengthens **FH-03**; feeds **SG-04** | **S** | Low. Main risk is a flaky network check eroding trust in the health report — mitigate by treating a `live-*` finding as WARN-with-detail, reserving FAIL for the structural assertions. No `hooks/src` edit, so no emit-guard exposure. |
| 2 | Env-only experiment + a findings doc under `docs/harness-strategy/`. **No code changes in the spike.** | **ST-02** (native `session.id` could collapse the 7-scheme problem at its source), **SG-04**, closes the documented "Phase 4 sub-agent correlation" deferral | **S** (half-day) | Beta surface may change shape. Real risk is scope creep into replacing the Python span layer on one spike's evidence — resist; the deliverable is a decision brief. Secondary: verify nothing sensitive leaves the machine (local collector only). |
| 3 | New `opc/scripts/core/judge_calibration.py` + a labeled fixture dir; `judge_session.py` untouched initially | none directly; makes **FH-03**'s batch interpretable | **M** (the labeling hour is the real cost) | Low. Worst case: a judge turns out to be unreliable — which is the finding, not a failure. Do not let the κ number become a gate before it has a stable baseline. |
| 4 | `docs/system-update/CURRENT-STATE.md`, `scripts/self-improvement/components-manifest.json` | housekeeping across **SG-02** (drift) | **XS** | None. |

**Sequencing:** 4 → 1 (independent, ship first) → 2 → *decision* → 3 in parallel with 2. Recommendation 3 does **not** depend on ST-02; recommendations 2's *follow-through* does.

**What could go wrong.** The honest risk on 2 is that it succeeds too well: a clean native-trace path is an invitation to rewrite the span layer mid-refinement, while the suite is green and the prune (README Step 10) is still pending — using the instrument you would judge that work with. Gate any migration behind its own plan and premortem. On 1, the failure mode is the one this component keeps producing: adding a check that cannot fail. Before declaring it done, break it on purpose — point it at a bad project id and confirm red — exactly the negative-control discipline that caught the `loadClaudeDotEnv` presence-vs-behaviour bug inside the guard itself (`braintrust-emit-guard.mjs:126-140`).

## 6. Benefits

- **A plausible path out of the 690 ms tax without losing telemetry.** Today the choice is framed as latency vs. blindness. If native OTel's batching exporter carries the spans, ~640–690 ms per tool call moves off the critical path — on a session with hundreds of tool calls that is minutes of wall-clock returned, and it removes the pressure to kill the only live telemetry the harness has.
- **Sub-agent visibility that CCv3 has deferred twice.** Dave's work is mostly kraken/review-pipeline fan-out. Parent-nested subagent spans are the missing join that makes "which sub-agent failed, and where" answerable instead of "the top-level Task scored low".
- **ST-02 gets a cheaper option.** Collapsing 7 id schemes by hand is delicate work in Hook-Source-Regression territory. A harness-authoritative `session.id` is a candidate canonical source that does not require touching seven call sites.
- **Judge scores become quantitatively trustworthy** — a κ per judge plus a bias-corrected aggregate, rather than three rubrics nobody has validated.
- **The layer can no longer die quietly.** The specific, documented, months-long failure gets an automated detector.
- **No new spend.** Every ADOPT runs on existing subscription quota and local scheduling; the two SKIPs are the two most tempting ways to convert this pillar into metered API cost.

## 7. Open questions

1. Does Claude Code's traces-beta `session.id` equal the `session_id` hooks receive on stdin? If yes, ST-02 gains a free canonical source; if no, the spike must document the mapping. (Directly testable in recommendation 2 — and it is the single highest-value bit the spike returns.)
2. Braintrust's logs table only shows traces with a root span. Would Claude Code's `claude_code.interaction` reliably arrive as that root, or would some spans land invisible? (Testable; determines whether OTLP ingestion is usable as-is.)
3. How many labels per judge before κ is stable enough to be worth reporting? The proposal deliberately does not name a number — [Speculation] on my part that a few tens per judge is the right order, and I found no citable standard for it.
4. Is the ~690 ms actually dominated by the feedback POST, or by the Python span-creation hook? The A/B measured tracing on/off as a whole. If the cost is mostly span creation, recommendation 2's latency benefit is larger than framed; if mostly the POST, a local spool-and-flush would capture most of it without any OTel migration. **Worth measuring before committing to 2's larger version** — and cheap to do.
5. Should the emit path spool to a local JSONL and flush out-of-band regardless of how the OTel decision lands? That is the minimal, vendor-independent version of "don't score in the request path", and it is not blocked on a beta feature. Raised as a cheaper fallback to recommendation 2, not proposed outright.
6. Has the Braintrust API key been rotated? Everything above assumes the credential is still trusted; if not, that precedes all of it.
