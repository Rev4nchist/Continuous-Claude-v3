---
date: 2026-07-29
component: code-intel
component_name: Code Intelligence
verdict: skip
headline: The 2026-07-24 cut was right and should NOT be reversed — but it was left half-finished: a 4.7-month-stale FAISS embedding index is still live-wired into `smart-search-router` and DENIES greps to serve obsolete results (the exact active-harm failure arXiv:2605.14478 measures), the BACKLOG still gates work on the deleted facade, and the cut deleted the very telemetry that justified it.
sources: 12
---

# Code Intelligence — Next-Evolution Proposal (2026-07-29)

> **The component pointers I was handed are stale.** `scripts/code-intel.mjs`, `.claude/rules/code-intel-boundaries.md`, and `.codegraph/` **do not exist** — they were deleted on 2026-07-24. This proposal is written against the repo as it actually is today, not against the brief.

## 1. Where CCv3 is today

**The stack this component describes was retired five days ago.** Commit `cb64d45` ("refactor(code-intel): cut Serena MCP + retire codegraph//code-intel facade (runtime)") removed 2,386 lines across 11 files: `scripts/code-intel.mjs` (1,130 lines), `.claude/rules/code-intel-boundaries.md`, the `code-intel` and `serena` skills, the `code-intel-enforcer` hook (src + dist + both `settings.json`), and the codegraph platform-contract test.

The stated reason, quoted from the commit body, is **adoption, not design**:

- Serena made real tool calls in only **37 of 882 lifetime MCP sessions (4.2%)**, zero in the last 5 days, and **zero uses ever** of its symbolic-edit differentiator tools.
- The `/code-intel` facade routed **zero specialist calls since 2026-06-07**.
- The codegraph index was **stale since build**.

The commit is explicit that this **overrides** two prior self-improvement proposals: `2026-07-04-code-intel.md` (verdict **adopt** — "validates CCv3's code-intel architecture outright") and `2026-07-16-code-intel.md` (verdict **watch** — "our design is exactly the convergent 2026 pattern"). Both evaluated *design alignment against the frontier*; **neither measured whether the agent actually called the thing.** That is the single most important lesson in this component's history and I return to it in §4.

### What actually survives (verified today)

| Layer | Status | Evidence |
|---|---|---|
| TLDR CLI (AST: cfg/dfg/slice/dead/diagnostics) | live | `.claude/rules/tldr-cli.md`, `tldr-code` skill registered in `skill-rules.json` |
| ast-grep (structural search/rewrite, MCP) | live | `ast-grep-find` in `skill-rules.json` |
| `smart-search-router` (PreToolUse:Grep) | live, **registered** | `.claude/settings.json:112-117` |
| Context bus L2 (`shared/context-bus.ts`) | live | writes/reads flowing; see below |
| grep / glob / Read | live | the de-facto default |
| Serena binary + `.serena/project.yml` | **on disk, unregistered** | `uv tool list` → `serena-agent v0.1.4` (`serena-mcp-server` entry point present) |
| codegraph, `/code-intel` facade | **deleted** | `cb64d45` |

Re-adopting Serena really is "one config line", as the commit claims — I verified the binary and project config are intact.

### Four findings the brief did not contain (all verified)

**1. A 4.7-month-stale embedding index is still live-wired, and it BLOCKS grep.** `smart-search-router.ts` classifies each Grep as literal / structural / semantic (`classifyQuery`, line 382). On a *semantic* classification it calls `tldrSemantic` (line 165), which reads `.tldr/cache/semantic/index.faiss`, and then emits `permissionDecision: 'deny'` (line 648) — the grep is **blocked** and replaced with either stale hits or a "set up the daemon" message.

That index exists and is dated **2026-03-08** (6.8 MB `index.faiss` + 1.5 MB `metadata.json`) — roughly **4.7 months stale** against a repo averaging ~4 files changed per commit. The path is present in the compiled bundle (`.claude/hooks/dist/smart-search-router.mjs`), so this is deployed behaviour, not dead source. Severity depends on daemon state: if the TLDR daemon is up, obsolete file/function pointers are injected as authoritative "🧠 Semantic Search Results" with a "Read the most relevant file" instruction; if it is down, the grep is still denied. Blast radius is bounded — a literal-first guard (line 388, added `cdbae08`) routes regex, identifiers, paths and short patterns away from this arm, so only natural-language-shaped patterns (question words, trailing `?`, "find all the…") reach it. **How often that fires is unmeasured** (see finding 3).

**This is precisely the failure mode the cut was executed to eliminate — it survived because nobody looked at it.** The disciplined layers (codegraph, Serena) were removed; the undisciplined one was not.

**2. The cut deleted the instrument along with the instrumented.** Post-cut, `.claude/logs/intel-bus.jsonl` (3,477 rows) contains **zero tool-usage rows**. Every row since 2026-07-24 is `bus_write` (263), `memory_awareness_bus_read` (112), `agent_recall_bus_read` (54), `bus_read_latency` (28), `bus_write_dropped` (13). The specialist rows that justified the cut — `find-symbol` (53), `who-calls` (25), `rename-preview` (22), `code-context` (3) — are **all pre-cut**. There is now **no telemetry on which code-intelligence tool the agent uses.** The next adoption decision (about TLDR, say) cannot be made the way the last one was.

**3. BACKLOG.md still gates live work on the deleted component.** `ST-04` ("codegraph facade latency 35–88s → budget", `BACKLOG.md:64`) and the entire **"C.5 deny-flip gate (the substrate end-state milestone)"** section (`BACKLOG.md:109-116`, whose criterion is "In-facade routing ≥80% measured in `intel-bus.jsonl`") carry no retirement annotation five days after the facade was deleted. `ST-04` is also still listed in the dependency summary (line 70). By contrast `CURRENT-STATE.md` self-declares as a dated 2026-06-27 snapshot, so its stale code-intel rows (47–48) are honestly labelled — the *execution plan* is the drift problem, not the snapshot.

**4. The symbol layer is still write-dead — but the file layer quietly replaced it.** `addFocusSymbol` (`context-bus.ts:868`) has **zero callers**, so `ST-01`'s premise holds. Yet `focus_terms` *are* being delivered (`focus_count: 8` in yesterday's rows) — `bus-focus.ts` derives them from `files_in_play.load_bearing` basenames instead. **File-granularity focus is shipping the value symbol-granularity was supposed to.** That materially weakens the case for ST-01 as specified.

## 2. Frontier scan

Research delegated to the `oracle` agent; I then **independently re-verified every load-bearing citation by fetching it myself**. Verification level is marked per source. Two of oracle's claims changed under re-verification (noted below), and one prior-proposal attribution was found to be wrong.

**Anthropic's own design rationale is primary-source and unambiguous** (✓ fetched verbatim): *"Claude Code is an agent that employs this hybrid model: CLAUDE.md files are naively dropped into context up front, while primitives like glob and grep allow it to navigate its environment and retrieve files just-in-time, effectively bypassing the issues of stale indexing and complex syntax trees."* The same post states the honest tradeoff: *"Of course, there's a trade-off: runtime exploration is slower than retrieving pre-computed data."* ([Anthropic, Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)). Note the two named costs being avoided are **stale indexing** and **syntax-tree complexity** — not "indexes don't improve accuracy."

**But the strongest controlled evidence points the other way, conditionally.** "Code Isn't Memory: A Structural Codebase Index Inside a Coding Agent" (✓ verified, full abstract fetched, [arXiv:2606.22417](https://arxiv.org/abs/2606.22417), 21 Jun 2026) ran three arms — harness+index, harness−index, agentic-grep comparator — on SWE-PolyBench Verified and SWE-bench Pro with **Claude Opus 4.7 held fixed, three seeds, leak-audited sandbox**. Verbatim: *"The within-harness ablation produces a large localization gain and a statistically separated resolve gain, with no cost penalty per cell and lower cost per solve"* and the index *"does not regress against an agentic-grep baseline on resolve or localization."* Its own stated deployment criterion: *"the deployment question for a structural codebase index is thus not whether it is too expensive to run… but **whether the workload includes multi-file changes where structural ranking pays off**."*

**Staleness is an active harm, not a tolerable lag.** "When Retrieval Hurts Code Completion: A Diagnostic Study of Stale Repository Context" (✓ verified verbatim, [arXiv:2605.14478](https://arxiv.org/abs/2605.14478)) found stale-only retrieval induced stale helper references on **15/17** (Qwen2.5-Coder-7B-Instruct) and **13/17** (gpt-4.1-mini) samples, concluding: *"stale context can actively bias models toward obsolete repository state rather than merely removing useful evidence."* This is the direct evidence base for finding 1 above.

**Graph retrieval remains research-positive.** LocAgent (✓ verified verbatim, [arXiv:2503.09089](https://arxiv.org/abs/2503.09089), ACL 2025) parses repos into *"directed heterogeneous graphs"*, reaching *"up to 92.7% accuracy on file-level localization"* and *"improving downstream GitHub issue resolution success rates by 12% for multiple attempts (Pass@10)"* at ~86% lower cost. Oracle found no 2026 paper arguing against persistent code graphs on principle — the "grep wins" position is a **production-engineering** finding (cost/latency/simplicity/staleness), not a research consensus that graphs don't help accuracy.

**Agentic keyword search competes with RAG — in general QA, not code.** Amazon Science / AAAI 2026, "Keyword search is all you need" (✓ I fetched the publication page: *"tool-based keyword search implementations within an agentic framework can attain over 90% of the performance metrics compared to traditional RAG systems"*; oracle additionally extracted 94.52% average faithfulness attainment from the primary PDF's Table 1). **Caveat I am flagging explicitly because it is widely mis-cited:** this study is document QA across five text datasets, **not code repositories.** It supports "agentic keyword search is competitive in general," not a code-specific conclusion.

**Embeddings-for-code are in retreat at the product layer.** Continue.dev's `@Codebase` provider is deprecated (✓ verified): *"The `@Codebase` context provider has been deprecated in favor of a more integrated approach to codebase awareness."* ([Continue docs](https://docs.continue.dev/reference/deprecated-codebase)).

**Why a good tool goes unused — this literature is the real explanation for our facade's death.** RAG-MCP ([arXiv:2505.03275](https://arxiv.org/abs/2505.03275), oracle-verified) measured tool-selection accuracy at **13.62%** with a large tool catalog, rising to **43.13%** when the exposed tool set is retrieval-filtered. Semantic Tool Discovery for MCP ([arXiv:2603.20313](https://arxiv.org/abs/2603.20313), oracle-verified) reports the same degradation across 121 tools and fixes it architecturally by exposing only top-3–5. "A Single Rewrite Suffices" ([arXiv:2606.30775](https://arxiv.org/abs/2606.30775), oracle-verified) shows description rewriting matches hand-tuning at 32× less effort **but cannot fix genuinely overlapping scopes** — which is exactly a `/code-intel` facade competing with `grep`. Our own `2026-07-20-skills.md` already established this internally: a 150+-skill catalog sits in the range where routing measurably degrades, with a 39.5% collision rate.

**The category is not dead — our packaging of it was.** The upstream tool we retired, `colbymchenry/codegraph`, is at **63,282 stars / 3,977 forks, last pushed 2026-07-24** (✓ I verified this directly against the GitHub API because the figure looked implausible; it is real). Serena is likewise still actively maintained (`serena-agent` PyPI release 2026-07-21, oracle-verified).

**Lightweight structure without a database.** Aider's repo map builds *"a graph where each source file is a node and edges connect files which have dependencies"* and ranks it with *"a graph ranking algorithm"* under a `--map-tokens` budget defaulting to 1k (✓ fetched). **Correction to the prior proposal:** `2026-07-16-code-intel.md` attributed "personalized PageRank" and tree-sitter to this page; the page as fetched names **neither**. I am citing only what it states.

## 3. Gap analysis

| Dimension | CCv3 vs frontier | Evidence |
|---|---|---|
| **Grep-first default** | **Even / aligned** — matches Anthropic's own stated Claude Code design | ✓ Anthropic engineering post |
| **Not carrying a bespoke index** | **Aligned**, and cheaper — 2,386 lines of maintenance removed | `cb64d45` |
| **Workload actually suits an index** | **We are on the wrong side of our own decision** — see below | measured, §5 |
| **Live stale-embedding path** | **Behind, and actively harmful** — the one thing every source agrees is the worst option | 2605.14478 ✓; Anthropic "stale indexing" ✓ |
| **Tool-usage telemetry** | **Regressed** — the instrument that enabled the cut is gone | intel-bus post-cut: 0 tool rows |
| **Tool-selection architecture** | **Behind** — 150+ skills, no retrieval-filtered exposure | RAG-MCP; our own 07-20 proposal |
| **Backlog hygiene** | **Behind** — ST-04 + C.5 gate a deleted component | `BACKLOG.md:64,109-116` |
| **Symbol-level bus (ST-01)** | **Value now questionable** — file-level focus already ships | `addFocusSymbol` 0 callers; `focus_count: 8` |

**The uncomfortable finding.** arXiv:2606.22417 names the deciding variable as *whether the workload includes multi-file changes*. I measured ours over 411 commits since 2026-05-01:

| Slice | Multi-file rate |
|---|---|
| All commits | 72.3% multi-file; mean 5.25 files/commit |
| Excluding `hooks/dist/` + lockfiles (removes the src→dist pairing confound) | 66.9% multi-file; mean 3.99 |
| **Code-touching commits only (`.ts`/`.py`/`.js`, excl. `dist/`)** | **76.1% touch multiple code files** (108 of 142) |

By the frontier's own stated criterion, **our workload is the kind where a structural index pays off.** So the honest reading is not "indexes are useless for us." It is: *the index was never losing on capability — it was losing on routing and latency.* The agent didn't reject it; the agent never selected it, in a 150+-skill catalog, against an always-available generic competitor, at 62s median latency.

That does **not** make the cut wrong. It makes the cut *correct for the reason given* (an unused, stale, slow layer is pure cost) while leaving the underlying capability question genuinely open — and it tells us exactly what would have to be fixed *first* if it is ever reopened.

## 4. Recommendations

**ADOPT — Remove or freshness-gate the semantic arm of `smart-search-router`.** This is the highest-severity item in this proposal and the cheapest. A 2026-03-08 FAISS index is live-wired into a hook that **denies** greps (`smart-search-router.ts:648`). Every source agrees stale retrieval is the worst configuration: it is the specific cost Anthropic names for avoiding indexes ✓, and arXiv:2605.14478 measured it actively biasing models toward obsolete state in 15/17 and 13/17 samples ✓. Two acceptable fixes, in preference order: (a) **delete the semantic arm** — reclassify semantic patterns as `literal` and let grep run, which is the frontier-default behaviour anyway; or (b) **gate on index age** — refuse to serve, and never `deny` the grep, when `index.faiss` mtime exceeds a small threshold. Do **not** simply rebuild the index: that re-creates a layer with no adoption evidence and a standing staleness obligation.

**ADOPT — Close ST-04 and the C.5 deny-flip gate in `BACKLOG.md` as moot.** They gate a component deleted on 2026-07-24. Leaving live-looking gates on dead work is how a plan silently stops describing reality — the same class of drift this proposal had to correct in its own brief. ~15 minutes, no risk.

**ADOPT — Restore a minimal code-intelligence usage counter.** The cut removed the measurement surface along with the measured (finding 2). One row per code-search tool invocation (tool name, query class, latency) written to `intel-bus.jsonl` re-arms the loop. Without it, "is TLDR earning its place?" is unanswerable, and the next cut/keep call will be made on vibes rather than the 4.2%-style evidence that made the last one defensible. This ties directly to **SG-04** (telemetry joinability + intel-bus consumer), which survives the cut intact and is the natural home for it.

**ADOPT (process) — Make adoption a standing gate in this self-improvement loop.** Two consecutive code-intel proposals (07-04 **adopt**, 07-16 **watch**) both scored *design against the frontier* and both were overridden by *one usage query*. Every future proposal touching a component with a runtime surface should state, in §1, how much that surface was actually used, measured — not just whether its architecture is fashionable. This is the cheapest possible fix to a demonstrated failure of the loop itself.

**WATCH — Re-adopting an index, gated on tool-selection being fixed first.** The case is stronger than the cut implies: our workload is 76.1% multi-file (the frontier's own criterion), the controlled ablation shows no regression vs agentic grep at *lower* $/solve ✓, and upstream codegraph is at 63k stars and actively maintained ✓. But re-adopting before fixing routing would reproduce the exact death: RAG-MCP measured 13.62% selection accuracy in large catalogs ✓, and description rewriting provably **cannot** resolve a scope that genuinely overlaps `grep`. **Re-open only when** (a) the usage counter exists, (b) the skills-routing work from `2026-07-20-skills.md` has landed, and (c) a concrete multi-file pain case is on record. Prefer adopting the maintained upstream MCP over rebuilding a bespoke facade.

**WATCH — Aider-style repo map as the lightweight middle option.** If structure is wanted back without an index service or a daemon, a token-budgeted dependency-graph map ✓ is the cheapest shape and has no staleness obligation between runs. Not now — it would be another tool in an over-full catalog.

**SKIP — Rebuilding the `/code-intel` facade.** Verified dead: zero specialist routes since 2026-06-07, 62s median latency, and a routing role that duplicates `grep`'s scope in a catalog where routing already degrades. The facade was the *packaging* that failed; rebuilding it repeats the experiment.

**SKIP — Re-registering Serena now.** 4.2% lifetime session adoption, zero uses ever of its symbolic-edit differentiator, zero in its final 5 days. It costs nothing to leave dormant (binary + `.serena/project.yml` verified intact; re-adoption is one config line) and there is no evidence of demand. Revisit only via the WATCH gate above.

**SKIP — ST-01 as currently specified.** Its premise (`addFocusSymbol` has zero callers) still holds, but the value it was meant to deliver is already shipping from `files_in_play` basenames (`focus_count: 8` observed). Re-scope or drop it rather than building a symbol writer for a consumer that is already fed — and note its original producer (codegraph's `proposed_bus_updates`) no longer exists.

## 5. Integration approach

| Item | Files | Effort | Risk |
|---|---|---|---|
| Semantic-arm removal / freshness gate | `.claude/hooks/src/smart-search-router.ts` (+ rebuild `dist/`, sync); test in `__tests__/smart-search-router.test.ts` | **S** (~20 lines) | **Low**, but touches a `deny`-capable PreToolUse hook — the failure mode of a mistake is blocking greps, so unit-test the classifier and verify `classifyQuery` still returns `literal` for regex/identifier/path cases (the `cdbae08` regression class) |
| BACKLOG hygiene (ST-04, C.5, dependency summary line 70) | `docs/system-update/BACKLOG.md` | **XS** | None |
| Usage counter | `shared/intel-bus.ts` emit + call sites; consumer under **SG-04** | **S–M** | Low; keep it one append-only row, fail-open — do not repeat the write-amplification profile flagged in ST-09 |
| Adoption gate in the loop | `docs/self-improvement/README.md` (or the refresh template) | **XS** | None |

**Sequencing:** the semantic-arm fix is independent and should go first — it is the only item that is actively wrong today. BACKLOG hygiene can ride the same change. The usage counter should land under **SG-04** rather than as a new arc. Nothing here depends on **ST-02**.

**What could go wrong.** (1) Deleting the semantic arm changes hook behaviour on a live `deny` path — if `classifyQuery` is edited carelessly, legitimate greps get blocked; mitigate by only *reclassifying* the semantic branch's outcome and leaving the literal-first guard untouched. (2) The repo `dist/` is currently stale (session start warned 28 source files newer than dist), so any hook edit needs a rebuild + sync or it will not take effect — and per `hook-dev-lifecycle.md`, re-run `scripts/audit-braintrust-emits.sh` after the TS edit. (3) I could not read the **active** copy at `~/.claude/hooks/dist/` (outside the session's allowed directory), so the deployed-artifact claim rests on the repo `dist/` bundle plus the `settings.json` registration — worth one direct confirmation before editing.

## 6. Benefits

- **Removes an active-harm path.** Today, a natural-language grep can be silently blocked and answered from a 4.7-month-old index — the failure mode arXiv:2605.14478 shows produces obsolete code references in ~80% of tested samples. Fixing this is a correctness win, not a performance one.
- **Restores grep on queries where it currently gets denied.** The frontier default (and Anthropic's own design) becomes the actual behaviour instead of being intercepted.
- **Re-arms the decision loop.** With a usage counter, the next keep/cut call is evidence-based. Without it, the 4.2%-style query that made the last cut defensible is no longer runnable.
- **Stops the plan from lying.** ST-04 and the C.5 milestone currently describe work on a component that does not exist; closing them keeps the execution plan trustworthy.
- **Avoids a third round of the same mistake.** The loop has now twice recommended investing in this component on design grounds and been overridden by usage data. Making adoption a standing gate is cheap and prevents the recurrence.
- **Keeps the door open honestly.** Our workload is 76.1% multi-file — the exact condition the frontier names for an index paying off — so this proposal deliberately does not slam that door; it states the two preconditions (telemetry, routing) that must exist first.

## 7. Open questions

1. **Is the TLDR daemon actually running in normal sessions?** It determines whether the stale-index path serves obsolete results (worse) or just blocks greps (bad). I could not measure it — `trackHookActivitySync` reports to the daemon, and no `smart-search-router` log exists.
2. **How often does the semantic branch fire?** Unmeasured, and unmeasurable until the usage counter exists. If it is effectively never, this drops from "fix now" to "delete during cleanup" — but the deny path makes the cost of being wrong asymmetric, so I recommend fixing regardless.
3. **Is TLDR itself being used?** No post-cut telemetry exists. It is the main survivor and, on current evidence, could be heading toward the same 4.2% fate unnoticed.
4. **Was the 62s facade latency intrinsic or fixable?** Prior analysis attributed it to Node+WASM cold start (one process per dirty file), which a warm daemon addresses. That matters only if the WATCH gate is ever reopened.
5. **Does the multi-file measurement generalise?** 76.1% of *code-touching commits* span multiple code files, but many are mechanical repetitions of one change across sibling hooks rather than dependency traversal. I did not distinguish these, and it is the one number in this proposal I would want a second look at before acting on the WATCH item.
6. **Would Anthropic's own harness direction change this?** Oracle found no evidence of first-party LSP or index integration in Claude Code — an absence-of-evidence finding, not a confirmed absence.
