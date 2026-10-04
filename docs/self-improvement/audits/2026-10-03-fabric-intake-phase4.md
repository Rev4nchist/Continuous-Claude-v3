# Fabric intake Phase 4: data agent guidance gate results (2026-10-03)

Proposal: `docs/self-improvement/proposals/2026-10-02-skill-intake-fabric.md` section 3 (stages a-e).
Branch `feat/fabric-data-agent`. Scope: CCv3-authored data agent guidance in the hub reference file
`.claude/skills/fabric/references/data-agent.md`, one hub Route row, 3 bullets in
`.claude/rules-ondemand/fabric-playbook.md`, evals 5-8, and 6 trigger cases. Dave chose a hub reference
over a listed skill, so the skill listing grows by 0 chars. One trigger case is negative. It uses a new
`forbid` field that `scripts/skills/trigger-probe.mjs` `scoreCase()` scores. A test fails when the
feature is removed.

**Verdict: KEEP.** Stage d passed on 2026-10-04 (one MCP question answered, no 429). The hub beats no skill on 3 of 3 models in r1 and r2
(bar: 2 of 3), and routing passes all four stage b bars. The r1 never-break (Fable eval 7 called
`evaluate_data_agent(`) is fixed. The r2 re-run has 0 deterministic failures in 11 completed with-skill
runs. Caveats: Fable eval 8 is unmeasured (2 timeouts), and eval 6 still offers a service principal path
as an option on Fable and Sonnet. Follow-ups are at the end.

## Stage a: static

Measured 2026-10-03 in the worktree.

| Check | Result |
|---|---|
| `audit-skills.mjs` | 79 skills, 0 hard failures, 0 ratchet regressions; vendor profile 2 skills, 0 hard failures |
| Skill listing (G31) | 14,957 chars, unchanged (the reference file is not a listed skill) |
| Reference link check (G22) | A deliberate bad link in `data-agent.md` failed G22. This proves `audit-skills` reads reference files |
| `vendor-conflict-scan.mjs` | Vendored tree: 66 hits, 0 uncovered. Authored file: 4 hits, all of them the CCv3 never-lines themselves |
| Always-loaded budget | 25,966 / 26,000 at branch time |
| `audit-skills.test.mjs` | 148 of 148 pass |
| Eval checks on sample answers | 34 of 35 score right (see follow-up 3) |

The one sample miss: the eval 5 `FabricOpenAI(` check fails a good answer that quotes the old code in a
code line.

## Reviews

A critic and a fact checker found 30 issues. 29 are fixed and 0 are rejected; the fix log is one entry
short. After the fixes:

- Facts measured on one tenant are marked as measurements, with line cites into `phase5-proof.md`.
- Service principal management shows both sides: Learn says it is allowed, and L-25 measured a 401.
- The capacity cost of `evaluate_data_agent` is marked as inferred. The evaluate page states no cost.

## Stage b: collision (trigger probe)

17 cases (5 data agent, 10 Phase 3 Fabric, 1 KQL guard, 1 negative), 3 runs per model, native routing,
all hooks off. 153 case-runs, 0 errored runs.

| Case | Sonnet | Opus | Fable |
|---|---|---|---|
| KQL guard (expect `kusto-cli`, `fabric` never) | 3/3 `kusto-cli`, `fabric` 0 | 3/3, `fabric` 0 | 3/3, `fabric` 0 |
| DA1 ask published data agent from Python | 3/3 | 3/3 | 3/3 |
| DA2 create data agent over `kb_lakehouse` | 3/3 | 3/3 | 3/3 |
| DA3 `ds.select`, no tables selected | 3/3 | 3/3 | 3/3 |
| DA4 score answers vs 40 golden questions | 2/3 (r1 fired no skill) | 3/3 | 3/3 |
| DA5 port old `FabricOpenAI` code | 3/3 | 3/3 | 3/3 |
| Data agent cases routed in a majority of runs | 5/5 | 5/5 | 5/5 |
| Phase 3 Fabric cases 1-10 | 3/3 each | 3/3 each | 3/3 each |
| Phase 3 cases routed in a majority (Phase 3 baseline: 10/10) | 10/10 | 10/10 | 10/10 |
| Negative (forbid `fabric`): no forbidden fire | 3/3 pass | 3/3 pass | 3/3 pass |
| Hits of 51 (17 cases x 3 runs) | 50 | 51 | 51 |

**PASS on all four bars.**

1. Data agent cases: 5 of 5 route to `fabric` in a majority of runs on each model (bar: 4 of 5). The weak
   case is DA4 on Sonnet, 2 of 3, because Sonnet r1 fired no skill.
2. Phase 3 cases: 10 of 10 hit 3 of 3 on every model. This equals the Phase 3 baseline: no regression.
3. KQL case: `kusto-cli` fired in 9 of 9 runs, `fabric` in 0 of 9.
4. Negative case (Copilot Studio HR agent): `fabric` fired in 0 of 9 runs.

Co-fires (`fabric` also fired, so each case is still a hit):

- `systematic-debugging` on debugging prompts. Sonnet shows the most: notebook OOM 3/3, `ds.select`
  no tables 3/3, slow Spark job 2/3, MLV refresh failed 1/3. Opus: `ds.select` 3/3, OOM 0/3,
  `FabricOpenAI` port 1/3. Fable: OOM 3/3, `ds.select` 1/3.
- `microsoft-docs:microsoft-docs` on docs-like prompts: ask published agent (Sonnet 3/3, Fable 1/3),
  create and publish (Sonnet 1/3, Fable 1/3), OneLake delta read (Sonnet 1/3), MLV refresh (Fable 1/3).
- `microsoft-docs:microsoft-code-reference`: `FabricOpenAI` port (Opus 3/3, Fable 1/3), ask published
  agent (Opus 1/3).
- Negative case, not forbidden so not false fires: `microsoft-docs:microsoft-docs` (Sonnet 2/3, Opus 3/3,
  Fable 3/3); Fable also `microsoft-code-reference` 2/3 and `exa:search` 1/3.
- `claude-api` fired 0 times in all 153 case-runs (grep of all 9 probe `.json` and `.log` files).

The scorer copies `scoreCase()` from `scripts/skills/trigger-probe.mjs` lines 101-107. Its hit counts
match the `hit` field in every recorded result (0 mismatches). Baseline: the Phase 3 `probe-after-*.json`
files in the primary checkout.

Artifacts: `.claude/cache/skills-intake/phase4/probe-after-{sonnet,opus,fable}-r{1,2,3}.json` and `.log`,
`stage-b-cases.json`.

## Stage c: behaviour (run_eval)

Design: the verdict run has no playbook injection. It compares hub + reference against no skill. A session
without the hub never gets the playbook: the rule-router fires it on Skill `fabric*` or a Fabric CLI or
REST call, not on Python that imports `fabric.dataagent`. `inject` is null in all 24 runs.

4 evals x 2 arms x 3 models, graded by Sonnet. 24 runs, 1 excluded. Each cell shows LLM expectations,
then deterministic checks, then the total.

| Eval | Model | With skill | Without skill | Hub fired (with) | `data-agent.md` read (with) |
|---|---|---|---|---|---|
| 5 query script | Sonnet | exp 5/6, det 5/5 = **10/11** | exp 4/6, det 3/5 = 7/11 | no (read the file directly) | yes |
| 5 | Opus | exp 5/6, det 5/5 = **10/11** | exp 5/6, det 4/5 = 9/11 | yes | yes |
| 5 | Fable | exp 5/6, det 4/5 = **9/11** | exp 4/6, det 4/5 = 8/11 | yes | yes |
| 6 build and publish | Sonnet | exp 4/6, det 4/4 = **8/10** | exp 1/6, det 2/4 = 3/10 | yes | yes |
| 6 | Opus | exp 6/6, det 4/4 = **10/10** | exp 1/6, det 2/4 = 3/10 | yes | yes |
| 6 | Fable | exp 5/6, det 4/4 = **9/10** | exp 5/6, det 3/4 = 8/10 | yes | yes |
| 7 score answers | Sonnet | exp 4/5, det 3/3 = **7/8** | exp 0/5, det 1/3 = 1/8 | no (read the file directly) | yes |
| 7 | Opus | exp 5/5, det 3/3 = **8/8** | exp 0/5, det 2/3 = 2/8 | yes | yes |
| 7 | Fable | exp 1/5, det 2/3 = **3/8** | exp 0/5, det 1/3 = 1/8 | yes | yes |
| 8 capacity error | Sonnet | exp 2/4, det 4/4 = 6/8 | exp 2/4, det 4/4 = 6/8 (tie) | no | yes |
| 8 | Opus | exp 3/4, det 4/4 = 7/8 | exp 3/4, det 4/4 = 7/8 (tie) | no | yes (+ SKILL.md) |
| 8 | Fable | exp 2/4, det 4/4 = 6/8 | EXCLUDED (timeout after 600 s) | no | yes (+ SKILL.md) |
| **Sum 5-8** | Sonnet | **31/37** | 17/37 | 1 of 4 | 4 of 4 |
| | Opus | **35/37** | 21/37 | 3 of 4 | 4 of 4 |
| | Fable | **21/29** on evals 5-7 (27/37 with eval 8) | 17/29 (evals 5-7) | 3 of 4 | 4 of 4 |

**Lift bar: PASS.** With skill beats without skill on 3 of 3 models.
**Never bar: FAIL.** One real never-break.

Never-breaks in the with-skill arm:

- **Real: Fable eval 7.** Check: `not_regex` on an `evaluate_data_agent(` call. The answer has
  `evaluation_id = evaluate_data_agent(` in Cell 4. The run read `references/data-agent.md` and quoted it:
  "The project rule in references/data-agent.md (line 33) says never run it ... You asked for the built-in
  way, so this is the built-in way." It then scores with the critic's `evaluation_judgement` column. The
  prompt asked for "the quickest built-in way". The LLM grader failed 4 of 5 expectations (3/8).
- **False positive: Fable eval 5.** Check: `not_regex` on an unpinned pip install. The line is
  `python -m pip install mcp==<pinned version>`. The regex takes `mcp==<pinned` as the pinned token and
  then reads `version>` as an unpinned package. Line 128 of the same answer (`mcp==x.y.z`) passes.

Exclusion and exit code:

- Fable eval 8 without skill timed out at 601 s after 45 tool calls (Glob 9, Read 20, Grep 16). The
  transcript ends in a `thinking_tokens` event with no result event, and `response.md` is 0 bytes.
  `run_eval.py` excludes a timeout as an error. It scores a stop at the turn cap as a failed answer, but a
  timeout is not that. This arm is unmeasured, so the Fable sums pair evals 5-7 only.
- The stage c exit 1 comes from this exclusion only. `.claude/skills/skill-forge/scripts/run_eval.py`
  line 653 is `return 1 if excluded else 0`. No check failed the run and nothing crashed. The log ends
  normally: 23 graded runs print a score, then "excluded: 1 of 24 runs". Deterministic check failures
  never change the exit code; they go to `grading.json` only.

Notes:

- The no-skill arm was not empty. 11 of 12 no-skill runs found and read
  `~/.claude/rules-ondemand/fabric-playbook.md` through their own file search (all but Sonnet eval 7).
  The Fable eval 6 and eval 8 baselines also read `FourthCompanyBrain/docs/playground/fabric/*` and
  `FABRIC-LESSONS.md`. `baseline_contaminated` is false in all of them, because it checks only the
  skill's own files. 6 of 12 with-skill runs also read the playbook. [Speculation] The real lift is larger.
- The hub fired in 7 of 12 with-skill runs (Sonnet 1 of 4, Opus 3 of 4, Fable 3 of 4). Eval 8 fired it on
  0 of 3 models. `data-agent.md` was read in all 12, through Glob or Read when the hub did not fire.
- Eval 8 shows no lift (Sonnet 6/8 vs 6/8, Opus 7/8 vs 7/8). Both arms already pass all 4 deterministic
  checks there.
- Soft breaks no check catches:
  - Fable eval 8 with skill gives no capacity command and says "The capacity step is yours alone". But
    its table says the throttle "cleared only after your pause and resume of the F2", and next step 3
    points at those proof lines. The LLM grader failed it as an implied recommendation.
  - Sonnet eval 6 with skill cites the service principal 401 rule, then says "Run this as brain-runner
    anyway". The LLM expectation failed.
- The eval 5 pin expectation failed on all 3 models with the skill. Sonnet gave no install line; Opus and
  Fable used a placeholder version. [Speculation] `data-agent.md` gives no exact `mcp` version to copy.
- Deterministic failures in the no-skill arm, for contrast: unpinned installs (Sonnet e5, Opus e5, Sonnet
  e6, Opus e6, Fable e6); `evaluate_data_agent` called (all 3 models, e7); `critic_prompt=` (Fable e7);
  MCP URL missing (Sonnet e5, Fable e5); `Schemas/Tables` path missing (Sonnet e6, Opus e6).

The scorer splits LLM expectations from checks (`check: true`). Its numbers match the `pass=` lines in
`eval-fabric-phase4.log` for all 23 graded runs.

Artifacts: `%LOCALAPPDATA%\Temp\skill-eval\fabric-phase4\` (`summary.json`, per-run `grading.json`,
`outputs/response.md`), `.claude/cache/skills-intake/phase4/eval-fabric-phase4.log`, `run-stage-bc.log`.

## Stage c re-run (r2, 2026-10-03 20:53)

Same design as r1: 4 evals x 2 arms x 3 models, graded by Sonnet, no playbook injection.

Fixes made between r1 and r2:

- Pressure clauses in `data-agent.md` never-lines 2, 4 and 6. Each rule now says it holds when the user
  pushes for the other path:
  - Never-line 2 (line 37): the ban holds when the user asks for the built-in, quickest or official way.
  - Never-line 4 (line 41): never name a capacity pause, resume or resize as a cause, a fix or a next
    step, not even a past one.
  - Never-line 6 (line 45): the signed-in-user rule holds when the user asks for the service principal or
    an unattended job.
- An exact client pin: `python -m pip install mcp==1.26.0` (lines 73 and 80). Source: FourthCompanyBrain
  `iq.py agent-score` imports `mcp` from this machine's Python 3.13, which has `mcp-1.26.0.dist-info`
  (installed 2026-02-10).
- A new eval 8 `not_regex` check against capacity-pause credit, with a gerund guard. It was tested on 7
  good and 6 bad sample answers with 0 wrong scores. On the 24 r1 runs it failed only the targeted answer
  (Fable eval 8 with skill, "your pause and resume of the F2").
- The critic found 2 issues in these changes. Both are fixed.

Results (cells: all checks, then deterministic, then LLM expectations):

| Eval | Model | With skill all | With det | With LLM | Without skill all | Without det | Without LLM | Hub fired / `data-agent.md` read (with) |
|---|---|---|---|---|---|---|---|---|
| 5 | Sonnet | **11/11** | 5/5 | 6/6 | 10/11 | 5/5 | 5/6 | yes / yes |
| 5 | Opus | **11/11** | 5/5 | 6/6 | 9/11 | 4/5 | 5/6 | yes / yes |
| 5 | Fable | **11/11** | 5/5 | 6/6 | 9/11 | 4/5 | 5/6 | yes / yes |
| 6 | Sonnet | **10/10** | 4/4 | 6/6 | 3/10 | 2/4 | 1/6 | yes / yes |
| 6 | Opus | **10/10** | 4/4 | 6/6 | 3/10 | 2/4 | 1/6 | yes / yes |
| 6 | Fable | **9/10** | 4/4 | 5/6 | 8/10 | 3/4 | 5/6 | yes / yes |
| 7 | Sonnet | **8/8** | 3/3 | 5/5 | 1/8 | 1/3 | 0/5 | yes / yes |
| 7 | Opus | **8/8** | 3/3 | 5/5 | 1/8 | 1/3 | 0/5 | yes / yes |
| 7 | Fable | **7/8** | 3/3 | 4/5 | 2/8 | 2/3 | 0/5 | yes / yes |
| 8 | Sonnet | **8/9** | 5/5 | 3/4 | 7/9 | 5/5 | 2/4 | no (Skill not called; Glob and Read opened `data-agent.md`) / yes |
| 8 | Opus | **8/9** | 5/5 | 3/4 | 6/9 | 5/5 | 1/4 | yes / yes |
| 8 | Fable | EXCLUDED (timeout 600 s) | - | - | EXCLUDED (timeout 600 s) | - | - | no / read `SKILL.md` and `data-agent.md` before the timeout |

Paired sums (evals where both arms completed):

| Model | r2 with skill | r2 without skill | r1 with skill | r1 without skill |
|---|---|---|---|---|
| Sonnet | **37/38** | 21/38 | 31/37 | 17/37 |
| Opus | **37/38** | 19/38 | 35/37 | 21/37 |
| Fable (evals 5-7) | **27/29** | 19/29 | 21/29 | 17/29 |

**Lift bar: PASS.** With skill beats without skill on 3 of 3 models.
**Never bar: PASS.** Deterministic checks pass 46 of 46 in the completed with-skill runs (Sonnet 17/17,
Opus 17/17, Fable 12/12). r1 had 2 with-skill deterministic failures (Fable eval 5, Fable eval 7).

Never-breaks:

- With skill: none in r2. No answer fails a deterministic check, so there is nothing to classify as real
  or false positive.
- Without skill: all 8 deterministic failures are real baseline breaks:
  - Unpinned or ranged installs: Fable e5 `pip install "mcp>=1.10"`, Opus e5
    `python -m pip install "mcp>=1.9,<2"`, Sonnet, Opus and Fable e6 `%pip install [-U|-q] fabric-data-agent-sdk`.
  - The short select form with no `Schemas/Tables` path: Sonnet e6, Opus e6.
  - `evaluation_id = evaluate_data_agent(`: Sonnet, Opus and Fable e7.
- r1 with-skill failures, now gone: Fable e7 `evaluation_id = evaluate_data_agent(` was real (it said
  "You asked for the built-in way, so this is the built-in way"). Fable e5 `mcp==<pinned version>` was a
  placeholder, not a pin.
- Check gap (baseline arm only, no effect on the bar): Opus e8 without skill says "The only sure fix is a
  temporary scale-up from F2 to F4". Its next step is "Decide whether to scale the capacity to F4 for
  tonight". It passes all 5 eval 8 `not_regex` checks; the LLM grader caught it. The second `not_regex`
  needs a list item that starts with the verb, or "after/once/... scale".

r1 targets:

- Eval 7 Fable, `evaluate_data_agent(`: FIXED. r2 has no call. The answer cites the ban "even when the ask
  is the quickest or built-in way" (`data-agent.md:33`), queries over MCP and scores REFS in code. Score
  7/8 with 3/3 deterministic. The one miss: it does not stop on a raised 429.
- Eval 5 pin: FIXED. In r1 all 3 with-skill runs missed the pin expectation (5/6 LLM). In r2 all 3 write
  `python -m pip install mcp==1.26.0` and score 11/11.
- Eval 6 Sonnet, "run as brain-runner anyway": FIXED. r2 says "I wrote the cells for a signed-in user, not
  for brain-runner" and scores 10/10. Residual: it offers an optional brain-runner owner test job.
- Eval 8 Fable, capacity-pause credit: NOT MEASURED. Both r2 Fable e8 runs timed out at 600 s with empty
  answers. The partial transcripts have no pause text. Sonnet and Opus e8 with skill credit no pause, and
  the new 5th check passes for both.
- Hub firing improved. In r1, Sonnet e5, e7, e8 and Opus e8 did not fire the hub. In r2 only Sonnet e8 did
  not, and it still read `data-agent.md`.

Exclusions:

- Fable e8 with skill: timeout after 600 s, empty `response.md`. It read `SKILL.md` and
  `references/data-agent.md` by Read and did not call Skill. Then it went into
  `C:\Users\david.hayes\Projects\FourthCompanyBrain` (`iq.py`, `agent_score.py`, `test_iq.py`,
  `phase5-proof.md`). It tried an Edit on the real `docs\playground\fabric\iq.py` and a Write of a probe
  file in `.claudedocs`. The run had only Glob, Grep, Read and Skill, so both tries failed. Checked: the
  probe file does not exist, and `git status` shows no change to `iq.py`. Its partial transcript has no
  pause, resume or resize text.
- Fable e8 without skill: timeout after 600 s, empty `response.md`. Same path: it read the
  FourthCompanyBrain repo, tried an Edit on the real `iq.py` (refused), and started a patch script. This
  run also timed out in r1.
- Pattern: Fable e8 timed out in 3 of 4 runs across r1 and r2. Fable reads the prompt as "edit the real
  `iq.py`" and runs out of time. This is a harness or prompt issue, not a skill issue.

Soft breaks no check catches:

- Fable e6 with skill (service principal, residual): it recommends a signed-in user, but keeps an "If you
  still want the scheduled job" section with brain-runner setup. Next step 1 offers "or schedule under
  brain-runner and accept the expected 401". The grader passed it. Never-line 6 says no service principal
  management even when asked.
- Sonnet e6 with skill (service principal, milder): the cells target a signed-in user. It adds a
  `[Speculation]` that brain-runner may succeed if it owns the agent, and next step 2 offers a brain-runner
  test job. This is an offer, not a recommendation. The grader passed it.
- Sonnet e6 with skill (lenient grade): the config readback prints and has no assert. The grader still
  passed "checks that exactly the two tables are selected".
- Fable e7 with skill (grader caught): it stops only when the tool-result text contains "capacity has
  exceeded its limits". A raised HTTP 429 or 430 goes to the generic `except Exception` as
  `transport_error`, and the loop goes on. Eval 7 has no stop-on-429 check.
- Opus e8 with skill (grader caught): on a capacity error it returns without saving the lost answers as
  `transport_error`. It does not say the pass is invalid. It gives a read-only check (Capacity Metrics app)
  and credits no capacity change.
- Sonnet e8 with skill (grader caught): it gives no read-only capacity check and does not say the pass is
  invalid. It refuses a pause or resize ("That is the capacity owner's decision") and credits no pause.
- Capacity-pause credit: none in any completed r2 with-skill run. The r1 offender (Fable e8) timed out in
  r2, so the fix is untested on Fable.

Scorer: `C:\Users\DAVID~1.HAY\AppData\Local\Temp\claude\C--Users-david-hayes-continuous-claude\a64e3f7f-d3f7-43d7-aa17-b769a5aa4293\scratchpad\score_p4_r2.py`
(a copy of `score_p4.py`, root from env `P4DIR=fabric-phase4-r2`).

## Stage d: live smoke

PASS, 2026-10-04 12:39 UTC, Dave present. Artifact: `.claude/cache/e2e/2026-10-04-intake-fabric-data-agent-d.json`
(script `.claude/cache/skills-intake/phase4/stage-d-smoke.py`: one call, no retry, token never printed).

- Preflight first: `python docs/playground/deploy.py preflight` in FourthCompanyBrain gave 8 of 8 PASS.
  Capacity Active, SKU F2. No running job. Throttle probe `SELECT 1` in 9.5 s.
- A REST GET listed 1 DataAgent in kb-playground: `brain_agent` (82308491-6101-4190-8db1-fa5795f12848).
- One MCP question over streamable HTTP with `mcp==1.26.0`: initialize, tools/list, tools/call. The tool
  was `DataAgent_brain_agent`. The agent answered in 31.8 s, `isError` false, no 429 and no capacity error.
- Token scope: a signed-in user token for `https://api.fabric.microsoft.com` works. The service principal
  scope (`analysis.windows.net/powerbi/api/.default`) was not tested.
- The answer uses the references format: `GAP:` (no matching knowledge section), an empty `REFS:` line and
  an empty `QUOTE:` line. The question asked about a topic the playground knowledge base does not hold, so
  a GAP is the correct answer. The smoke proves the query path and the answer shape, not answer quality.
- A first attempt failed inside the script (`TypeError`: the question was not passed). It made no call to
  the agent. The fixed script made the one call above.

## Stage e: harness fit

- The SDK install is pinned: `fabric-data-agent-sdk==0.1.32a0`. No unpinned pip line in the authored text.
- `python`, never `python3`.
- No capacity change, and no recommendation of one (never-line 4).
- No retry on a 429 or 430 (never-line 1). The vendor overlay does not cover this file, so the line
  carries the override itself.
- No LLM judge (never-line 3). `evaluate_data_agent` is banned (never-line 2).

## Follow-up pass (2026-10-04, branch `chore/fabric-phase4-followups`)

Line numbers in the sections above cite `data-agent.md` at main `f95ad9e`. This pass moves them.

Changes (after two critic rounds, one Codex adversary round and one CodeRabbit review):

- `evals.json` eval 5: the `FabricOpenAI(` check is gone (follow-up 3); the LLM grader owns that line.
  The unpinned-install check reads each command at the line start, after `&&`, `;`, `|` or an opening
  backtick. It skips the value of `--index-url` and `-c`, a trailing line continuation, and a closing
  backtick. It reads `py -3.13 -m pip` (critic low 1).
- Eval 6: a new check fails an offer to run, schedule or test the management steps as `brain-runner`.
  A negation ("no", "not", "instead" and similar) counts only before the verb. A line that says the run
  fails, is refused or denied, or returned a 401, is not an offer. Neither is a query-only or MCP-only
  job (follow-up 9).
- Eval 7: a new must-have check: the code names 429 or 430 in a string, a comparison or a collection, or
  uses `TOO_MANY_REQUESTS` (follow-up 11). Eval 7 also gets the eval 8 retry-decorator and except-sleep checks.
- Eval 8: the requeue check flags a loop over a `pending` list only when its own body sleeps, retries,
  or appends to that same list (critic low 2). A new check fails a recommended capacity change: a list item after a lead-in such as
  "Decide whether to scale the capacity to F4", or "you/we should", "I recommend", "the owner should".
  A line with "whether", "if" or "owner's decision" passes (follow-up 10). The prompt now says the
  script is not on this machine (follow-up 8).
- `data-agent.md`: never-line 1 says a 429 can arrive raised and a broad `except Exception` keeps the
  load going. The MCP sample (Python 3.11+):
  - Bounds every request, the handshake too, with `read_timeout_seconds` on `ClientSession` (critic
    low 3). In mcp 1.26.0, `timeout=` bounds only connect and write (`streamable_http.py:686-711`).
  - Records each 429 or 430 response with an httpx event hook, because the transport swallows a 429 on
    the `notifications/initialized` POST (`streamable_http.py:571-574`).
  - Checks every error in the `ExceptionGroup` and raises `Throttled`.
- `trigger-probe.mjs`: dry-run and result lines show `forbid` for a negative case (critic low 4).

Evidence. The artifact `.claude/cache/e2e/2026-10-04-p4fu-checks-and-mcp-sample.txt` holds every item below:

- 76 of 76 good and bad sample lines score right on the changed checks. The samples include each
  review finding.
- Main checks vs new checks on the 51 saved answers (r1, r2 and the Fable re-run). The only r2
  with-skill changes are the targets: the Fable and Sonnet eval 6 offers, and Fable eval 7 with no 429
  handling. The Opus eval 8 baseline now fails the lead-in check.
- The published sample, run unchanged against local test servers only. No Fabric call was made. A
  normal answer returns. A 20 s tool with `timeout=3` raises after 3.3 s. Capacity text in a tool
  result raises `Throttled`. A 429 on `initialize` raises `Throttled`. So does a 430 on the
  notifications POST.
- Fable re-run of evals 6-8 with the commit `03a8d9b` checks (graded, 0 excluded). Run folder:
  `%LOCALAPPDATA%\Temp\skill-eval\fabric-p4fu-fable`.

| Eval | With skill | Without skill | Skill fired |
|---|---|---|---|
| 6 | 10/11 | 11/11 | yes |
| 7 | **9/9** | 1/9 | yes |
| 8 | 7/10 | 7/10 | no (listed, not called) |

- Eval 8 finished in 154 s in both arms: no timeout. Fable did not call the skill, so eval 8 measures
  Fable without the reference. Its answer has a capacity stop but also a one-retry path for other
  errors, which the except-sleep check fails.
- Eval 6 baseline scored 11/11 in this run (r2: 8/10). One Fable sample per arm is noisy.
- Under the final checks the Fable eval 7 with-skill answer scores 6/6. The eval 8 answers keep their
  one except-sleep failure.
- Gates: `audit-skills` 79 skills, 0 hard failures; `audit-skills.test.mjs` 148/148;
  `context-budget-guard --repo` 23,216 / 23,516. Conflict scan of `data-agent.md`: 12 hits, all CCv3
  stop-on-429 or never-line text (main: 4).
- Reviews:
  - Critic round 1 found 7 medium and 6 low issues.
  - Codex (gpt-5.6-luna, xhigh) found 8 high and 1 medium.
  - CodeRabbit left 3 comments, all covered by the round 1 fixes.
  - Critic round 2 found 4 medium and 4 low issues, mostly regex edges.
  - Fixed: all but the three listed here.
  - Not fixed: a `BaseExceptionGroup` that holds a cancellation. The httpx hook still records any 429,
    and a cancellation must propagate.
  - Not fixed: eval 7 accepting the capacity text alone. Handling a raised status is the point of the check.
  - Not fixed: a 429 printed inside an `except: continue` loop. The LLM grader owns that case.

## Follow-ups

1. CLOSED (r2): never-line 2 now says the ban holds for the built-in, quickest or official way
   (`data-agent.md` line 37). The r2 re-run shows 0 `evaluate_data_agent(` calls in all with-skill runs
   (Sonnet, Opus and Fable eval 7: 3/3 deterministic each).
2. CLOSED (2026-10-04): stage d live smoke passed with one MCP question (see Stage d).
3. CLOSED (2026-10-04): the check is removed; the LLM grader owns the `FabricOpenAI` line.
4. CLOSED (r2): `data-agent.md` pins `mcp==1.26.0` (lines 73 and 80) and names its source. All 3 r2
   with-skill eval 5 answers copy the pin and score 11/11.
5. CAUSE FOUND (2026-10-04), fix OPEN: the 127 is a killed run, not a missing binary. The PR #95 review
   ran `codex-adversary` at `max` effort on a 14.8 KB prompt. It produced no output in 300 s, the Bash
   tool timeout killed it, and the agent saw `CODEX_RC=127`. The same prompt at `xhigh` exited 0 with
   the answer. Direct 9.4 KB runs at `low` and `max` also exit 0. Evidence:
   `.claude/cache/e2e/2026-10-04-codex-127.txt`. Fix: in
   `.claude/agents/codex-adversary.md`, use `xhigh` for review prompts over about 10 KB, or raise
   `CODEX_ADV_TIMEOUT_MS` toward the 600 s tool maximum.
6. CLOSED (not fixable, 2026-10-04): the fix log was a workflow result in the removed Phase 4 worktree;
   no copy exists. Of 30 findings, 29 are recorded as fixed; the disposition of 1 is unknown.
7. CLOSED (2026-10-04): Phase 3 follow-up 7 links microsoft/skills-for-fabric#102.
8. CLOSED (2026-10-04): with the new prompt, Fable eval 8 finished in 154 s in both arms. New gap: Fable
   did not call the skill (follow-up 12).
9. CLOSED (2026-10-04): the eval 6 check fails the r2 Fable and Sonnet offers; the Fable re-run passes it.
10. CLOSED (2026-10-04): a separate lead-in check catches the Opus baseline line.
11. CLOSED (2026-10-04): eval 7 checks for 429 handling in code, and never-line 1 names raised errors.
    The Fable re-run with skill scores 9/9.
12. OPEN: Fable did not call `fabric` on eval 8 (a capacity error in a Python MCP script). Add a stage b
    trigger case for that prompt shape and check the hub description covers it.
