---
date: 2026-08-03
component: learning-loop
component_name: Self-Improvement / Learning Extraction
verdict: adopt
headline: Our learning loop is now a well-built one-way street — the 2026-07-24 cycle fixed the write side, but nothing anywhere records whether a stored learning ever helped, and the recall log does not even record WHICH rows were returned; instrument that link first (small, verified-dead `was_helpful` column already exists), because every frontier utility/pruning technique is gated on a signal we do not yet emit.
sources: 16
---

# Self-Improvement / Learning Extraction — Next-Evolution Proposal (2026-08-03)

## 1. Where CCv3 is today

**First: the component manifest is stale.** The stated implementation pointer
`.claude/hooks/src/memory-extractor.ts` **does not exist** (✓ VERIFIED — Glob over
`.claude/hooks/src/*memory*.ts` and `*extract*.ts`). The real pipeline is four files:

| Layer | File | What it actually does now |
|---|---|---|
| L0 | `.claude/hooks/src/periodic-extract.ts` | **No longer stores anything.** Counts tool uses, emits a checkpoint system message every 50. The `store_learning.py --type OPEN_THREAD` write was deleted 2026-07-24 (`periodic-extract.ts:18-24`, citing proposal 07-09 R1). |
| L1 | `.claude/hooks/src/pre-compact-extract.ts` | On PreCompact, spawns `incremental_extract.py` detached, `--max-learnings 5`, with a 5-minute cooldown (`pre-compact-extract.ts:150-155`). |
| L2 | `.claude/hooks/src/session-end-extract.ts` | On SessionEnd, ≥10 turns, spawns the same script detached, `--max-learnings 15` (`session-end-extract.ts:33, 96`). |
| L3 | `opc/scripts/core/store_learning.py`, `/remember`, `.claude/skills/extract-v2/`, `.claude/skills/memory-curate/` | Manual, deliberate stores. |

The engine underneath is `opc/scripts/core/incremental_extract.py` (735 lines). Its shape:

- **Regex candidate harvest** — `PERCEPTION_SIGNALS` / `ERROR_PATTERNS` over thinking blocks and tool
  errors (`incremental_extract.py:62-113`).
- **Heuristic quality gate** — `score_extraction()` (`:149-192`): base score 5, keyword-regex bonuses,
  penalties for short/generic/repetitive text, clamped 0–10, classified `SIGNAL` (≥5) / `NOISE` (<3).
  NOISE is dropped before storage (`:558-581`).
- **LLM distillation** — landed 2026-07-24 as proposal 07-09 R2 (`:583-629` → `distill_learning.py`).
  One batched headless `claude -p` per extraction run, Mem0-shaped prompt demanding atomic
  lesson/why/how_to_apply and explicitly allowing an empty list (`distill_learning.py:_PROMPT_HEADER`).
  It is genuinely well-hardened: recursion sentinel `CCV3_DISTILL_CHILD` checked by both extraction
  hooks (`pre-compact-extract.ts:111`, `session-end-extract.ts:146`), a secret-shape egress block
  (`SECRET_RE`), a prompt-injection reject on model output (`INJECTION_RE`), a post-distillation
  re-score through the same NOISE gate, fail-open to verbatim storage, and kill switch `CCV3_DISTILL=0`.
- **Bi-temporal supersession** — `valid_from` / `valid_until` on `archival_memory`, driven by
  `opc/scripts/core/supersede.py`; recall filters `valid_until IS NULL OR valid_until > NOW()`
  (`recall_learnings.py:470-481`).

**This is a good write path.** The 2026-07-24 cycle removed the noise firehose, added LLM distillation
with a real safety posture, and kept the cheap keyword gate as a pre-filter. Judged as a capture
pipeline, CCv3 is at or slightly ahead of what shipping products do (§2, §3).

### The limitation — the loop is not a loop

Everything above is write-side. Nothing closes back.

- **No outcome attribution exists anywhere.** ✓ VERIFIED: `was_helpful BOOLEAN` is declared at
  `opc/scripts/core/artifact_schema.sql:94` and SELECTed at `opc/scripts/core/artifact_query.py:146` —
  and a `was_helpful` grep across `opc/` returns **exactly those two lines**. No INSERT or UPDATE ever
  sets it. The utility-feedback slot was designed and has never been populated. (Note: this is the
  SQLite artifact index, a different store from `archival_memory` — but the point stands for both.)
- **The recall log cannot support attribution even in principle.** `.claude/logs/memory-recall.jsonl`
  (950 events) records `results_count`, `top_score`, `kept_after_floor`, latency, daemon routing and
  RAM pressure — ✓ VERIFIED by reading the actual keys of the last record. It does **not** record which
  memory ids were returned, nor any signal about what happened next. You cannot join a stored learning
  to an outcome because the join key is not written.
- **The read side is measurably weak and unexplained.** `docs/system-update/CURRENT-STATE.md:35`:
  hit rate **27.4%** over 281 events; **sub-agent recall 0 of 281 rows** — the agent layer is
  memory-blind. Whether the 72.6% miss is a retrieval problem or a *corpus* problem is currently
  unanswerable, because corpus quality is only ever scored at write time.
- **Quality is scored once, at ingestion, by regex.** A learning admitted by `score_extraction()` is
  never re-examined. A learning rejected as NOISE is gone with no record and no re-test path.
- **`eval_recall.py` measures retrieval, not usefulness.** It computes NDCG@5 against a fixed
  hand-labeled `(query, relevant_id)` set (`eval_recall.py:1-20`). That is offline retrieval quality —
  a genuinely useful instrument, and the 07-25 proposal leans on it — but it says nothing about whether
  an injected memory changed a session's outcome.

## 2. Frontier scan

All arXiv IDs below were verified this session by querying the arXiv API directly and reading the
returned title and abstract. Post-cutoff (2026) IDs were the specific fabrication risk and were
checked individually; all eight resolved to real papers matching their attributed content.

**Utility feedback / outcome attribution — the hot area, and our exact gap**

- **MemCon — "Memory as a Controlled Process"** (https://arxiv.org/abs/2607.13591). Models memory
  operations as an MDP and learns an online policy deciding "when, what, and how much to retrieve,
  when to inject a distilled plan, and when to consolidate or forget." Abstract, verbatim: it "learns
  from task-by-task binary feedback with no pretraining and no additional LLM calls, and uses a
  lightweight tabular contextual bandit with UCB exploration that converges within tens of tasks,"
  reporting "up to 15.2 points in task success while reducing token consumption by 5--20%." It is
  explicitly **backend-agnostic — it wraps any existing memory implementation.** Its stated premise is
  that "nearly all existing approaches… access memory through fixed, hand-designed heuristics" — which
  is a precise description of CCv3's static `HYBRID_FLOOR` + regex gate.
- **Risk-sensitive contextual bandits for abstention-aware memory retrieval in LLM coding agents**
  (https://arxiv.org/abs/2604.27283). Same family, aimed at our exact domain: "retrieved memory is
  useful only when the current failure is genuinely compatible with a previous one" — i.e. learning
  when to **abstain** from injecting.
- **FSFM — biologically-inspired selective forgetting** (https://arxiv.org/abs/2604.20300). Splits
  forgetting into efficiency (pruning), quality (stale updates), and security (malicious/sensitive
  content). Useful vocabulary: our dedup is efficiency-only.
- **Memory for Autonomous LLM Agents (survey)** (https://arxiv.org/abs/2603.07670). Cautionary
  counterweight — surveys learned-forgetting and its risks.

**Reflection — the skeptical literature is the important half**

- **"LLMs Cannot Self-Correct Reasoning Yet"** (https://arxiv.org/abs/2310.01798, ICLR 2024).
  *Intrinsic* self-correction — critique with no external feedback signal — often fails to improve and
  can degrade performance. This is the single most load-bearing citation against building any more
  self-judgment into our loop before we have an external signal.
- **"Honest Lying: Understanding Memory Confabulation in Reflexive Agents"**
  (https://arxiv.org/abs/2605.29463). Abstract: Reflexion-style agents assume they "can accurately
  diagnose their own failures. We show that this assumption can fail systematically: across ALFWorld
  and HumanEval, agents store confident but incorrect interpretations."
- **BenchTrace** (https://arxiv.org/abs/2605.29225). Existing evaluation "measures only task scores,
  leaving reflection quality unknown" — exactly our position with `eval_recall.py`.
- **Meta-Policy Reflexion** (https://arxiv.org/abs/2509.03990). The constructive answer: consolidate
  ephemeral reflections into a reusable predicate-like memory with a **hard rule-admissibility check**.

**Skill / procedure induction**

- **Agent Workflow Memory** (https://arxiv.org/abs/2409.07429). Induces reusable abstracted workflows
  from past trajectories; "24.6% and 51.1% relative success rate" on Mind2Web/WebArena. The canonical
  precedent for promoting episodes into procedures.
- **Agentic Context Engineering** (https://arxiv.org/abs/2510.04618). Names **brevity bias** and
  **context collapse** — iterative rewriting erodes detail — and prefers append-and-curate playbooks.
  "+10.6% on agents and +8.6% on finance."
- **NEGATIVE: "More Skills, Worse Agents? Skill Shadowing…"** (https://arxiv.org/abs/2605.24050).
  Abstract: performance "degrades as libraries grow -- by up to 21% when scaling from a small set."
- **A-MEM** (https://arxiv.org/abs/2502.12110) — linked, evolving notes where new memories update old
  ones. **AgentHER** (https://arxiv.org/abs/2603.21357) — recovers signal from *failed* trajectories
  via hindsight relabeling; relevant because our pipeline captures errors but never revisits them.

**What actually shipped**

- **Claude Code auto memory** (https://code.claude.com/docs/en/memory) — ✓ VERIFIED by fetching the
  doc. Claude writes `MEMORY.md` itself, no confirmation step; 200-line/25KB load cap; since v2.1.210
  Claude Code measures the file after a write and tells Claude to "merge or drop stale entries"; since
  v2.1.214 it stamps a `modified` ISO timestamp. That is **size and freshness pressure — not utility
  measurement.** There is no described mechanism scoring whether a memory later helped.
- **Devin Knowledge** (https://docs.devin.ai/product-guides/knowledge) — ✓ VERIFIED: auto-**suggests**,
  human edits/saves/dismisses. The fetched doc describes no usage tracking, rating, or automated
  pruning by effectiveness; quality is maintained by human curation.
- **OpenAI Codex `AGENTS.md`** (https://agents.md/) — static, human-authored, no learning loop.
- **Cursor Memories** — auto-generated from conversations, managed in Settings, beta. Flagged weak:
  the documentation page redirected to the docs root when fetched 2026-08-03, so current behavior is
  unconfirmed and I do not rely on it below.

**The cross-cutting finding:** of the shipping products checked, **none documents a loop that scores
whether a stored memory helped and prunes on that basis.** This is an industry-wide gap, not a CCv3
deficiency — which is why the frontier work on it (MemCon, 2604.27283) is all 2026-dated research
rather than product.

## 3. Gap analysis

**Where we are ahead or even.** Our capture pipeline compares well. Distillation with atomic
lesson/why/how_to_apply matches the Mem0-shaped consensus. The secret-egress block, injection reject,
recursion sentinel, and fail-open-to-verbatim posture in `distill_learning.py` are more defensive than
anything documented in the shipped products. Bi-temporal `valid_until` supersession is a genuine
capability that Claude Code's auto memory does not have — its staleness story is a `modified` timestamp
and a nudge to drop entries when the file gets long. Deleting the L0 periodic write was the right call
and is supported by ACE's context-collapse and the noise-accumulation literature.

**Where we are behind.**

1. **No outcome signal at all** — and, more fundamentally, **no join key**. This is the whole gap. Every
   technique in §2's first block (MemCon, 2604.27283, FSFM's quality axis) presupposes a feedback
   signal per memory item. We emit none, and `memory-recall.jsonl` does not even record which ids were
   returned, so the signal cannot be reconstructed retroactively from 950 logged events.
2. **Write-time-only scoring by regex.** `score_extraction()` is a fixed hand-designed heuristic — the
   precise thing MemCon argues is the bottleneck. Worse, per *Honest Lying*, a wrongly-rejected
   candidate is discarded silently with no re-test path, which is the self-reinforcing-error failure
   mode named in that paper.
3. **Corpus health is unmeasurable.** With a 27.4% hit rate we cannot currently distinguish "retrieval
   is weak" from "the corpus is full of things nobody needed." Both hypotheses predict the same number.
4. **Failed episodes are captured but never mined.** We extract tool errors into learnings; AgentHER's
   point is that failure trajectories carry recoverable signal that a success-shaped pipeline discards.

**Where we should deliberately NOT move.** Skill induction (AWM-style promotion of learnings into
skills) is attractive and wrong for us right now: the skill-shadowing result (up to 21% degradation)
plus our own 2026-07-20 skills proposal — which found our ~150-skill catalog already sits in the range
where routing measurably degrades — means auto-promoting learnings into skills would push a known
problem in the wrong direction.

## 4. Recommendations

**R1 — Log the recall→memory join key and a usage signal. ADOPT.**
The one thing that unblocks everything else, and the cheapest item here. Add the returned memory ids
(and their scores) to each `memory-recall.jsonl` event, plus a coarse downstream signal. Without ids,
no attribution scheme of any kind is possible later. Rationale: MemCon (2607.13591) demonstrates that a
useful memory policy needs only **binary task-level feedback and no extra LLM calls** — the bar for the
signal is low, but it must exist. Start by *recording*, not by acting on it.

**R2 — Populate or delete `was_helpful`. ADOPT.**
`artifact_schema.sql:94` is a designed-and-abandoned feedback column that is SELECTed into results and
is always NULL. Either wire it (the artifact Q&A path is a natural place for a thumbs signal, since a
query has a discrete answer) or drop it. A dead feedback column is worse than none — it reads as if
attribution exists. This is the same class of defect as the harness's recent `hook-output-contract` and
`agent-error-capture` findings: a contract that looks live and is inert.

**R3 — Give the NOISE gate a re-test path. ADOPT (small).**
Currently a rejected candidate vanishes (`incremental_extract.py:558-567` logs to stderr and drops).
Persist rejections with their score to a rotating local log so the gate's false-negative rate can be
audited. Directly motivated by *Honest Lying* (2605.29463): a confident-but-wrong rejection that is
never revisited becomes permanent. Cheap, no behavior change, makes the gate falsifiable.

**R4 — MemCon-style adaptive memory policy. WATCH.**
The right long-term shape and explicitly backend-agnostic, so it could wrap our existing store. Not
yet, for a concrete reason: MemCon learns from **task-by-task binary success feedback**, and an
interactive coding harness has no clean binary task boundary or success oracle the way its 6 benchmarks
do. Revisit once R1 has accumulated real data and we can see whether a usable success proxy exists
(tests passing, a commit landing, absence of a correction). Re-evaluate after ~30 days of R1 data.

**R5 — Auto-inducing skills/procedures from repeated learnings. SKIP (for now).**
Skill shadowing (2605.24050, up to 21% degradation) against a catalog already at the documented
degradation threshold per our own 07-20 proposal. The AWM idea is sound; our catalog is the wrong
substrate. Revisit only if the skills-pruning arc lands first.

**R6 — RLAIF / Constitutional-style self-improvement. SKIP.**
It is a training-time technique (reward model + RL fine-tuning). No evidence was found of local,
single-user, inference-time deployment. The applicable takeaway is narrow and we already act on it:
self-generated signals can substitute for human labels *for scoring*, not for training. Framing our
loop as "RLAIF-lite" would be a category error.

**R7 — Fix the stale component manifest. ADOPT (trivial).**
The self-improvement loop's own manifest points at `.claude/hooks/src/memory-extractor.ts`, which does
not exist. A research loop that cannot correctly name its own subject will keep re-deriving the
baseline every cycle — I spent the first phase of this run rediscovering the real file set.

## 5. Integration approach

| Item | Files | Effort | Risk |
|---|---|---|---|
| R1 join key + usage signal | `.claude/hooks/src/memory-awareness.ts` (writes the log), `opc/scripts/core/recall_learnings.py` (already returns ids — plumb them into the log record) | ~half day for the id logging; the usage signal needs a design decision first (see Open questions) | **Low for logging, medium for the signal.** Log-only changes are additive and fail-open. Do NOT let this grow into a synchronous write on the recall hot path — ST-05/ST-03 exist because that path is already a latency problem. Append-only, off the critical path. |
| R2 `was_helpful` | `opc/scripts/core/artifact_schema.sql`, `artifact_query.py` | ~1–2h | Low. If wiring is not obviously cheap, delete the column instead — that is a legitimate outcome. |
| R3 rejection log | `opc/scripts/core/incremental_extract.py:558-581` | ~1h | Low. Already runs detached in background. Bound the file size. |
| R7 manifest | the self-improvement loop's component manifest | minutes | None |

**Ties to `docs/system-update/BACKLOG.md`:**

- **SG-01** ("Memory recall floor + corpus-health SLO; re-baseline the 27.4% hit rate") is the direct
  parent of R1. SG-01 as written re-baselines *retrieval*; R1 supplies the missing **corpus-health**
  half — you cannot define a corpus-health SLO without a per-item utility signal. R1 should be folded
  into SG-01 rather than tracked separately.
- **SG-04** (telemetry joinability + intel-bus consumer) is the natural home for R1's data. SG-04
  already owns "accepted/rejected disposition tracking" for codex-lift; recall disposition is the same
  pattern applied to memory. It also correctly notes joinability depends on **ST-02** (canonical
  session/agent identity) — which is the real sequencing constraint: **per-session attribution is only
  trustworthy after ST-02**, and the 0-of-281 sub-agent recall figure is partly an identity artifact.
- **ST-08** (shared `storeLearning(content, opts)` helper) is the right seam to add a provenance field
  to every write, if R1 grows to need one. Coordinate — do not add a competing write path.
- **ST-10** (`agent-recall-injector` 0-for-78) is flagged **DELICATE** with hook-source-regression
  history. R1 touches neighbouring code; keep them in separate commits and run
  `scripts/audit-braintrust-emits.sh` after any hook edit.

**What could go wrong.**

1. **Latency regression on the recall path.** The biggest real risk. Mitigate: append-only log write,
   no DB round-trip, no blocking.
2. **The usage signal is not measurable and R1 stalls at id-logging.** Acceptable — id-logging alone is
   still net-positive and is the prerequisite. Ship it and say so, rather than blocking on the harder half.
3. **Acting on a weak signal.** The literature is explicit that automated pruning can delete
   safety-critical items (2603.07670) and that self-judgment without external feedback misfires
   (2310.01798). R1/R2/R3 are all *instrumentation*; nothing here should auto-delete a learning. Any
   pruning policy is a later, separately-gated decision.
4. **Measurement changes the thing measured** — a stored learning becomes part of the context that
   produces the next outcome, confounding naive attribution. Worth naming now so the eventual analysis
   does not over-claim causality from correlation.

## 6. Benefits

- **The 27.4% question becomes answerable.** Today Dave cannot tell whether recall underperforms
  because retrieval is weak or because the corpus is padded. With ids logged, that is a query, not a
  debate — and it is the difference between fixing retrieval (SG-01's current framing) and fixing the
  corpus.
- **Pruning stops being guesswork.** `memory-curate` currently scores entries by rubric — a human
  judgment about text. Utility data replaces "this looks like noise" with "this was never retrieved, or
  was retrieved 40 times and never used."
- **Cheaper sessions.** MemCon reports 5–20% token reduction alongside its accuracy gain, largely by
  not injecting memory that will not help. Our injectors currently always inject their top-k.
- **A dead contract gets closed.** `was_helpful` joins the recent list of things in this harness that
  looked wired and were inert. Each one found and closed makes the next audit cheaper.
- **Honest scope.** The most valuable output of this cycle may be the SKIPs: not building skill
  induction into a catalog already past its degradation threshold, and not chasing RLAIF, are decisions
  that save real effort.

## 7. Open questions

1. **What is the usage signal, concretely?** Options, roughly in order of cost: (a) did the session
   subsequently reference a file/identifier that appeared only in the recalled memory; (b) an explicit
   lightweight thumb via `/recall`; (c) an LLM judge at session end asked "did any recalled memory
   change what you did." (c) is the most informative and the most suspect — it is intrinsic
   self-assessment, which 2310.01798 warns about. Leaning (a): mechanical, external, no extra inference.
2. **Is there a usable binary success proxy in this harness?** MemCon needs one. Tests passing, a commit
   landing, or the absence of a user correction are candidates. Unresolved, and it gates R4.
3. **Does the R2 distiller actually fire in practice?** ✗ UNCERTAIN — I read the code and it is
   well-formed, but I did not execute it, and this machine has documented headless `claude -p` failures
   (spawn-tree leaks, silent hangs). Before building on top of distilled content, confirm distilled rows
   are actually landing rather than every run falling open to the verbatim path. Fail-open means a
   totally broken distiller looks exactly like a working one from the outside.
4. **Attribution across the ST-02 boundary.** How much of the 0-of-281 sub-agent recall is genuine
   memory-blindness versus identity mislabeling? R1's data will be partly uninterpretable until ST-02
   lands.
5. **Should rejected candidates be recoverable, or only counted?** R3 as scoped only counts. Retaining
   full rejected text is a larger privacy/size commitment.
