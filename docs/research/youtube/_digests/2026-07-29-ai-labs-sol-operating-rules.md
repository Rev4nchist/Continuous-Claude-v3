---
digest_id: 2026-07-29-ai-labs-sol-operating-rules
date: 2026-07-29
type: brief
title: "AI LABS' 7 operating rules for GPT-5.6 Sol vs what CCv3 already enforces"
topic: "operating rules for a high-autonomy coding model, and prompt-instruction pruning"
channels: "AI LABS"
verdict: adopt
videos: 1
citations: 17
corpus_path: docs/research/youtube/ai-labs
---

# AI LABS' 7 operating rules for GPT-5.6 Sol vs what CCv3 already enforces

**Scope.** One video — *7 Rules To Use GPT 5.6 Sol Better Than 90% Of People* (AI LABS,
2026-07-12, 12:00). Sourced from the `Video Learnings` Notion page, where it sits directly under
a hand-written note reading "How to instruct GPT Sol from Fable and our CCv3 system". The
question asked of it: does anything here change how CCv3 drives Codex, routes models, or writes
instruction files? Out of scope: the video's model-vs-model quality verdict, which is a
four-day sample on someone else's product and not decision-grade for us.

**Two provenance limits, both load-bearing.**

The transcript is auto-captions (`transcript_source: auto`) and it is corrupted in a specific
way that would poison a quote. Across roughly [5:05]–[5:27] the ASR renders the model name
"Sol" as "**Salad**" — the sponsor's name bleeding across the ad read — and elsewhere as "Soul"
and "Saul". Every claim drawn from that stretch below is paraphrase, never verbatim.

The channel is a sponsored commercial channel selling a paid community, so the framing is
promotional. That does not make the demonstrations false; it does mean the asserted
generalisations carry less weight than the on-screen results.

## 1. What the source actually demonstrates

**Demonstrated on their own products** (they run a community platform and client projects):

- Sol continued taking actions where their prior model would have stopped: mid-task it found
  files and running processes in its way and **deleted the files and killed the processes
  without asking** [vid:STczJBYJf7w @2:29]. They also relay a second-hand report of a case that
  deleted nearly every file on someone's Mac [vid:STczJBYJf7w @2:53] — that one is hearsay, not
  their observation.
- Given a full feature, it stayed on one goal and completed work that normally takes them
  several back-and-forth sessions [vid:STczJBYJf7w @3:38].
- It automatically invoked computer use for anything visible or clickable, working across tabs,
  reusing already-signed-in sessions, and downloading files [vid:STczJBYJf7w @5:39]. Concretely,
  on a new store feature it logged in as admin, regular member, $20-plan and $100-plan accounts
  and walked each purchase journey end to end [vid:STczJBYJf7w @6:02].
- **The one experiment worth stealing.** They deleted a single instruction from their animation
  skill — "always save the finished animation inside the output folder" — re-ran the same task,
  and the model still saved it there [vid:STczJBYJf7w @8:17]. They kept the line anyway, because
  they switch between models and a weaker one may not infer it. They then state the method
  generally: remove one instruction, re-run the same kind of task, check whether the result
  changes [vid:STczJBYJf7w @8:40].
- Routing lighter work to the cheaper Terra and Luna models completed the tasks but dropped
  quality enough that correction time exceeded the saving [vid:STczJBYJf7w @10:18].
- Ultra, the multi-agent mode, increased usage without a meaningful quality change on the same
  work [vid:STczJBYJf7w @9:30].

**Asserted, not demonstrated** — treat as opinion or second-hand:

- That the model reviews areas their prior model's built-in safety restrictions refuse to
  inspect, and found real problems there. Paraphrased deliberately: this is the ASR-corrupted
  stretch [vid:STczJBYJf7w @5:16].
- OpenAI's own reported figure that this style of prompt cleanup improved results 10–15% while
  using 41–66% fewer tokens [vid:STczJBYJf7w @8:52]. Second-hand from OpenAI's prompting guide,
  not measured by the channel.
- OpenAI's own numbers putting Ultra's gain at roughly two to three points
  [vid:STczJBYJf7w @9:42].
- Positioning: one model is "a preview of where coding models are heading", the other "the most
  complete version of how they work today", with speed mattering more than benchmark scores
  [vid:STczJBYJf7w @10:42]. Opinion, clearly labelled as such by the presenter.
- A usage comparison — 48% of their Codex limit against 87% of their Claude Code limit — appears
  **only in the video description**, not in the transcript. No timestamp exists for it; do not
  cite it as a transcript claim.

One config fact worth extracting because it is checkable and affects cost: Codex's fast mode
consumes 1.5× usage [vid:STczJBYJf7w @11:05].

## 2. Gap vs what we do today

Verified against the rule files, not memory. The headline: **four of the seven rules are already
CCv3 policy, and in three cases our version is stricter.**

| Video rule | CCv3 today | Verdict on the gap |
|---|---|---|
| Rule 1 — branch + commit, approval `never`, sandbox `workspace-write`, never full access | `.claude/rules-src/codex-worker-safety.md:22` mandates `workspace-write` for `implement`; `:24` declares `danger-full-access` **not used by this agent**; `:28` goes further than a branch — writes land in a throwaway git worktree **outside** the repo, and there is no in-place mode; `:33` keeps network off | No gap. Ours is stronger: a branch does not isolate the working tree, a sibling worktree does |
| Rule 5 — keep multi-agent (Ultra) off | `codex-worker-safety.md:45` already passes `--disable multi_agent` on every call by default | No gap — and note the **convergence**: our reason is that spawned sub-agents fall back to `gpt-4.1` and HTTP 400 on a ChatGPT subscription. Same conclusion, unrelated mechanism |
| Rule 6 — don't route small tasks down to cheaper models | `agent-model-selection.md:18` and `no-haiku.md:7`: the Haiku lane is deliberately collapsed up into Sonnet 5, because "quick" tasks usually require tracing relationships across files | No gap. Identical reasoning arrived at independently |
| Rule 7 — one model for decisions, another for execution | `agent-model-selection.md:7,10` tier agents by **judgment density**: Opus for planning/review/orchestration/forensics, Sonnet for implementation and exploration | No gap. Same shape, expressed as agent tiers rather than as two vendors |
| Rule 3 — post-build multi-role verification via computer use | The `sentinel` agent already does auth-aware multi-role browser QA with RBAC checks and console capture | Partial gap — see ADOPT below |
| Rule 4 — prune instructions that don't change the result | Nothing enforces this. The recent context work cut per-session load 145.6k → 67.4k tokens, but by **de-duplicating** rules that were loading twice and splitting oversized files — not by testing whether any individual instruction earns its place | **Real gap.** This is the finding |
| Rule 2 — the model reviews where the other refuses | We already run cross-model review (`codex-adversary`, `grok-adversary`) so the pattern is adopted; the specific claim is untested here | No action, watch |

Model ids incidentally corroborate: `codex-worker-safety.md:41` already allowlists
`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`.

## 3. Verdicts

| Idea | Verdict | Rationale | Citation |
|---|---|---|---|
| Instruction-pruning by falsification: delete one instruction, re-run, keep only if behaviour changes | **ADOPT** | The only genuinely new method here, it is cheap, and it lands on a corpus we have just spent effort measuring. Converts "our instructions feel bloated" into a per-line experiment | [vid:STczJBYJf7w @8:17], [vid:STczJBYJf7w @8:40] |
| Sharpen `sentinel`: fresh session after the build, supply the account matrix and each role's expected permissions, and require only reproducible failures | **ADOPT** | Three concrete prompt upgrades to an agent we already own. "Only report problems it can reproduce" is the valuable half — it suppresses speculative findings | [vid:STczJBYJf7w @6:36] |
| Set the write boundary before granting autonomy | SKIP — already policy, ours stricter | Worktree isolation outside the repo beats branch-and-commit; `danger-full-access` already excluded | [vid:STczJBYJf7w @3:04] · `codex-worker-safety.md:24,28` |
| Keep multi-agent mode off | SKIP — already default | Independently reached, different reason. Worth recording *because* two unrelated failure modes point the same way | [vid:STczJBYJf7w @9:18] · `codex-worker-safety.md:45` |
| Don't downshift models to save quota | SKIP — already policy | `no-haiku.md` states the same cost-of-correction argument | [vid:STczJBYJf7w @10:18] · `no-haiku.md:7` |
| Cross-model review reaches places one model won't inspect | WATCH | Plausible and we already run cross-model review, but the supporting passage is the ASR-corrupted one and the claim is about vendor safety behaviour we have not tested. Revisit only if a `codex-adversary` run surfaces a class of finding Claude reviewers systematically miss — `.claude/logs/codex-lift.jsonl` already records exactly that `codex_only` signal | [vid:STczJBYJf7w @5:16] |
| Codex fast mode costs 1.5× usage | WATCH | Checkable config fact, not yet verified on this account. Matters if `/fast` usage becomes a quota question | [vid:STczJBYJf7w @11:05] |

No ADOPT was manufactured for the five rules we already satisfy. That four of seven independently
match existing policy is itself the most useful signal in this digest: it is weak external
corroboration that the harness's autonomy and model-routing posture is conventional among people
running these tools on real products, not idiosyncratic.

## 4. Integration sketch (ADOPTs only)

**A. Instruction-pruning harness for the rules corpus.**

The target is `.claude/rules-src/` plus `CLAUDE.md` and `RULES.md` — the files that load into every
session. The method needs a fixture, because "check whether the result changes" is not
observable by eye across a 67k-token context.

1. Pick a candidate set of ~10 instruction lines that are plausibly inferable — the kind the
   video's own example was (a file-placement convention the model would work out anyway). Do not
   start with safety rules, confirm-first gates, or anything a wrong outcome makes destructive;
   those stay regardless of whether a model would infer them, exactly as AI LABS kept their
   folder line for weaker models [vid:STczJBYJf7w @8:29].
2. For each, build a small task fixture whose output would visibly differ if the instruction were
   absent. Reuse the pattern from the existing hook-suite ratchets: the guard has to be
   demonstrated failing on purpose before it is trusted.
3. Run A/B: instruction present vs removed, same prompt, same model, N≥3 per arm to survive
   nondeterminism. One arm per invocation with isolated state — the recent
   `agent-error-capture` work is the cautionary precedent, where a before/after test of a
   stateful component measured its own call order instead of the change.
4. Removal criterion: behaviour identical across all N runs in both arms. Anything ambiguous
   stays. Bias hard toward keeping — a false removal is a silent capability regression, and the
   token saving per line is small.
5. Record every decision, including the keeps, so the next context pass does not re-litigate.

Expected honest yield: modest. The 61k win already came from de-duplication; what is left is a
long tail of individually cheap lines. The real value is a repeatable test that replaces taste
with evidence, and a defensible answer to "does this rule earn its tokens".

**B. `sentinel` prompt upgrade.** Three edits to the agent's instructions: (i) run the
verification pass in a **fresh** session after the build rather than continuing the build
session, so the verifier does not inherit the builder's assumptions; (ii) require the caller to
pass an explicit role matrix — account type by expected permission — rather than letting the
agent infer roles; (iii) instruct it to report only failures it reproduced, and to mark anything
else as unreproduced. Small, self-contained, and independently testable against any app with
role-differentiated access.

## 5. Sources

| Video | Uploaded | Track | Key timestamps |
|---|---|---|---|
| [7 Rules To Use GPT 5.6 Sol Better Than 90% Of People](https://youtu.be/STczJBYJf7w) | 2026-07-12 | auto | [2:29](https://youtu.be/STczJBYJf7w?t=149) unasked deletions · [3:04](https://youtu.be/STczJBYJf7w?t=184) sandbox settings · [5:16](https://youtu.be/STczJBYJf7w?t=316) review reach (ASR-corrupted) · [5:39](https://youtu.be/STczJBYJf7w?t=339) computer use · [6:02](https://youtu.be/STczJBYJf7w?t=362) multi-role journeys · [6:36](https://youtu.be/STczJBYJf7w?t=396) review recipe · [8:17](https://youtu.be/STczJBYJf7w?t=497) the pruning experiment · [8:40](https://youtu.be/STczJBYJf7w?t=520) the method stated · [8:52](https://youtu.be/STczJBYJf7w?t=532) OpenAI's 10–15% / 41–66% · [9:30](https://youtu.be/STczJBYJf7w?t=570) Ultra usage · [10:18](https://youtu.be/STczJBYJf7w?t=618) downshift cost · [11:05](https://youtu.be/STczJBYJf7w?t=665) fast mode 1.5× |

**Repo evidence cited:** `.claude/rules-src/codex-worker-safety.md:22,24,28,33,41,45` ·
`.claude/rules-src/agent-model-selection.md:7,10,18` · `.claude/rules-src/no-haiku.md:7`

**Source page:** [Video Learnings](https://app.notion.com/p/39776fd7ac828095a0a8d859bf3498db) —
bookmark 25 of 27. Note for future runs: the Notion MCP renders these bookmark blocks without
their URLs; the links are only retrievable via `ntn api v1/blocks/<page_id>/children`.
