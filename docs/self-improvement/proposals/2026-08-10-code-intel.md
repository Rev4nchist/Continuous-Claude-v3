---
date: 2026-08-10
component: code-intel
component_name: Code Intelligence
verdict: adopt
headline: The capability CCv3 cut in July (Serena's LSP symbol layer) has since shipped inside Claude Code itself as a first-party LSP tool with no index, no staleness, and no MCP routing tax — enabling two official plugins is a ~30-minute change that recovers it, while last iteration's P0 (a now-5.1-month-stale FAISS index that still DENIES greps) went unactioned for 12 days and is still live.
sources: 13
---

# Code Intelligence — Next-Evolution Proposal (2026-08-10)

> **The component pointers in the brief are stale, again.** `scripts/code-intel.mjs`, `.claude/rules/code-intel-boundaries.md` and `.codegraph/` do not exist — deleted 2026-07-24 in `cb64d45`. The `2026-07-29-code-intel.md` proposal already flagged this; the brief was not updated. Only `.claude/hooks/src/shared/context-bus.ts` and `.serena/` still exist. This proposal is written against the repo as it is today.

## 1. Where CCv3 is today

**The headline state change is external, not internal: nothing in this component moved in 12 days.**

```
git log --since=2026-07-29 -- .claude/hooks/src/smart-search-router.ts docs/system-update/BACKLOG.md
→ (empty)
```

Every finding from `2026-07-29-code-intel.md` is still true, verified fresh today:

| Prior finding | Status today | Evidence |
|---|---|---|
| Stale FAISS index live-wired into a `deny`-capable hook | **Still live. Now 5.1 months stale.** | `.tldr/cache/semantic/index.faiss`, 6.8 MB, mtime **2026-03-08**; `smart-search-router.ts:161` reads it; `:648` emits `permissionDecision: 'deny'`; registered at `.claude/settings.json:117` |
| No code-intelligence usage telemetry | **Still zero.** | `.claude/logs/intel-bus.jsonl` (836 KB, last write 2026-08-09) — tail rows are all `memory_awareness_bus_read`; no tool-usage rows since the cut |
| BACKLOG gates live work on the deleted facade | **Unchanged.** | `BACKLOG.md:64` (**ST-04**, "codegraph facade latency 35–88s"), `:70` (dependency summary "ST-04 before C.5"), `:109-116` (C.5 deny-flip gate, criterion "In-facade routing ≥80% measured in `intel-bus.jsonl`") |
| `CURRENT-STATE.md` describes the deleted stack | Unchanged, but **honestly labelled** as a dated 2026-06-27 snapshot | `CURRENT-STATE.md:47-48` still describe the `/code-intel` facade and codegraph L3 as live |

What survives and runs: TLDR CLI (AST), ast-grep, `smart-search-router` (PreToolUse:Grep), the L2 context bus, and grep/glob/Read as the de-facto default. Serena's binary and `.serena/project.yml` remain on disk, unregistered.

**Two findings the prior proposal did not have.**

**A. This machine's Claude Code has a first-party LSP tool available, and CCv3 does not use it.** Installed version is **2.1.225**. There is **no LSP plugin installed** (`~/.claude/plugins/` holds `claude-hud`, `docx`, `frontend-design`, `pdf`, `workspace-tools`, `xlsx`) and **no `lspServers` key anywhere** in `~/.claude/settings.json`, `~/.claude.json`, or the repo config. The repo is 384 tracked TypeScript files and 503 Python files — both covered by official marketplace LSP plugins. Neither `typescript-language-server` nor `pyright` is on PATH.

**B. A code-intelligence hook has drifted between repo and active config.** `post-edit-diagnostics` (full-project `tsc --noEmit` after every TS edit, per the always-in-context CLAUDE.md) is registered in the **active** `~/.claude/settings.json:793` but appears **zero times** in the repo `.claude/settings.json`. Per `sync-known-gaps.md`, `settings.json` is intentionally not synced — so this is expected drift rather than a defect, but it means the repo does not describe the diagnostics behaviour the agent actually gets.

## 2. Frontier scan

Deep research delegated to `oracle`; **I then independently re-fetched every load-bearing citation below.** Verification provenance is marked per source. One of oracle's claims changed under re-verification.

### The finding that reframes this component

**Claude Code shipped a first-party LSP tool.** Verified verbatim by fetching the changelog **at the `v2.0.74` tag** (the changelog on `main` has been truncated to 2.1.191+, so oracle's "verified from main" claim did **not** reproduce — I re-sourced it):

> "Added LSP (Language Server Protocol) tool for code intelligence features like go-to-definition, find references, and hover documentation"
> — [anthropics/claude-code CHANGELOG @ v2.0.74](https://raw.githubusercontent.com/anthropics/claude-code/v2.0.74/CHANGELOG.md) ✓ fetched

It is maintained, not a one-off. The current `main` changelog (highest entry 2.1.226) contains ongoing LSP hardening — v2.1.205 *"Fixed a plugin LSP server that fails to initialize preventing a valid LSP server from another plugin handling the same file extension"*; v2.1.203 *"Fixed LSP-only plugins being incorrectly flagged for disuse when their language servers deliver diagnostics or answer navigation requests"* ([CHANGELOG @ main](https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) ✓ fetched).

The delivery mechanism is **plugins**, documented in the official plugins reference ([code.claude.com/docs/en/plugins-reference](https://code.claude.com/docs/en/plugins-reference) ✓ fetched). Verbatim, LSP integration provides:

> "**Instant diagnostics**: Claude sees errors and warnings immediately after each edit · **Code navigation**: go to definition, find references, and hover information · **Language awareness**: type information and documentation for code symbols"

Official marketplace plugins listed on that page: **`pyright-lsp`** (`pip install pyright` or `npm install -g pyright`), **`typescript-lsp`** (`npm install -g typescript-language-server typescript`), **`rust-analyzer-lsp`**. Three operational constraints stated there, all of which apply to us: *"You must install the language server binary separately"*; *"when more than one enabled LSP server declares the same file extension … the first server registered handles files with that extension and the others never start"*; and *"LSP servers start only after you trust the workspace."* One version trap is documented and we are clear of it — `restartOnCrash`/`shutdownTimeout` *"require Claude Code v2.1.205 or later. Before v2.1.205, the config schema accepted both options but setting either one caused Claude Code to skip that LSP server entirely at startup, with the reason visible only in `claude --debug` output."* We run 2.1.225.

### Structural indexes: research-positive, workload-gated

"Code Isn't Memory: A Structural Codebase Index Inside a Coding Agent" ([arXiv:2606.22417](https://arxiv.org/abs/2606.22417), Bhola/Krishnan/Kurmala/NS ✓ abstract re-fetched today) ran three arms — harness+index, harness−index, agentic-grep comparator — on SWE-PolyBench Verified and SWE-bench Pro, *"with Claude Opus 4.7 held fixed throughout, across three seeds, inside a leak-audited per-task sandbox."* Its own deployment criterion, verbatim: *"The deployment question for a structural codebase index is thus not whether it is too expensive to run… but whether the workload includes multi-file changes where structural ranking pays off."*

**Agentic exploration beats classical retrieval, at the retrieval task itself.** SWE-Explore ([arXiv:2606.07297](https://arxiv.org/abs/2606.07297), 5 Jun 2026 ✓ abstract fetched verbatim) isolates repository exploration across *"848 issues across 10 programming languages and 203 open-source repositories"* with line-level ground truth distilled from successful agent trajectories, and concludes: *"we find that agentic explorers form a clear tier above classical retrieval."* This is direct evidence against re-introducing an embedding-retrieval layer, and is the sharpest new data point since the last iteration.

**Scaffolding sophistication is not the lever.** ContextBench ([arXiv:2602.05892](https://arxiv.org/abs/2602.05892), 5 Feb 2026 ✓ abstract fetched) finds *"sophisticated agent scaffolding yields only marginal gains in context retrieval,"* that *"LLMs consistently favor recall over precision,"* and that *"substantial gaps exist between explored and utilized context."* This argues for a **native, cheap** capability over another orchestration layer — which is exactly what a first-party LSP tool is and what the `/code-intel` facade was not.

### Staleness is active harm — and denying the grep makes it worse

"When Retrieval Hurts Code Completion" ([arXiv:2605.14478](https://arxiv.org/abs/2605.14478), Weng et al., 14 May 2026 ✓ abstract re-fetched today). Verbatim: *"stale-only retrieval induces stale helper references on 15/17 Qwen2.5-Coder-7B-Instruct samples and 13/17 gpt-4.1-mini samples, corresponding to 88.2 and 76.5 percentage-point increases over current-only retrieval"*; conclusion: *"stale context can actively bias models toward obsolete repository state rather than merely removing useful evidence."*

**A detail the prior proposal missed, and it sharpens the case:** the same abstract reports that *"mixed conditions show that adding valid current evidence largely rescues stale-only failures."* Our hook does not produce a mixed condition — it emits `deny`, removing the fresh grep result that would have done the rescuing. We are running the paper's **worst** arm, not its middle one.

### Supporting context (verified by oracle; I did not independently re-fetch these four)

- **SCIP moved to independent governance**, Core Steering Committee with Meta, Uber and Sourcegraph representatives; *"Sourcegraph remains a deeply committed and active member of the community"* ([sourcegraph.com/blog/the-future-of-scip](https://sourcegraph.com/blog/the-future-of-scip), 2026-03-25 ✓ I fetched this one). `sourcegraph/scip` now redirects to `scip-code/scip`, pushed 2026-08-06, not archived (oracle live API check). The format is healthier than it was, which matters only if we ever want a portable index — we do not, yet.
- **Serena is alive and growing** — 27,807 stars, pushed 2026-08-09 ([github.com/oraios/serena](https://github.com/oraios/serena), oracle live API). Its unpopularity here was local, not upstream.
- **Fast agentic retrieval is being treated as a trainable capability**, not a fallback: Cognition's SWE-grep RL-trained retrieval models, shipped in Windsurf's Fast Context subagent ([cognition.ai/blog/swe-grep](https://cognition.ai/blog/swe-grep), 2025-10-16, oracle-verified).
- **Aider's repo map** remains the lightweight middle option: tree-sitter symbol extraction → reference graph → PageRank ranking → binary search against a token budget ([aider.chat/2023/10/22/repomap.html](https://aider.chat/2023/10/22/repomap.html), oracle-verified; note the prior proposal's correction that the *page itself* did not name PageRank — oracle sources the mechanism to the page plus DeepWiki's structural writeup, so treat the PageRank attribution as **[Speculation]** pending a direct read of Aider's source).

## 3. Gap analysis

| Dimension | CCv3 vs frontier | Verdict |
|---|---|---|
| Grep-first default | Matches Anthropic's stated Claude Code design; SWE-Explore now adds independent support that agentic exploration beats classical retrieval | **Even / aligned** |
| **Symbol-precise navigation (def/refs/hover)** | Frontier: native, first-party, index-free, shipped since v2.0.74 and hardened through 2.1.x. Us: **absent** — cut with Serena, never replaced, harness support unused | **Behind, and the gap is now cheap to close** |
| Stale-retrieval hygiene | Frontier: staleness is measured active harm. Us: a 5.1-month-stale index that **denies** the fresh alternative — the paper's worst arm | **Behind, actively harmful** |
| Structural/graph index | Frontier: positive but workload-gated on multi-file changes. Us: none | **Behind on paper; correctly deferred** |
| Adoption measurement | Frontier: n/a. Us: **zero** code-intel tool telemetry since the cut | **Behind — and it is the loop's own blind spot** |
| Tool-catalog discipline | ContextBench: scaffolding yields marginal gains. Us: cut the facade — the right call, reinforced by new evidence | **Ahead** |
| Incremental diagnostics | Frontier: LSP gives per-edit incremental diagnostics. Us: full-project `tsc --noEmit` per TS edit | **Behind** |

**The synthesis.** July's cut was correct on the evidence available (4.2% Serena session adoption, zero symbolic-edit uses, a 62s facade). But the reason it was correct was **packaging**: an MCP server and a bespoke facade competing with `grep` inside a 150+-skill catalog, carrying a staleness obligation. The frontier's answer to that exact problem arrived in the harness: the same capability, delivered as a **native tool** rather than a routable one. Re-adopting it does not repeat the failed experiment — it removes the variable that caused the failure.

## 4. Recommendations

**ADOPT (P0) — Fix the stale semantic arm. Carried forward unactioned from 2026-07-29.**
This was last iteration's highest-severity item. Twelve days later, zero commits touched it and the index is 5.1 months stale. The new evidence makes the case stronger, not weaker: we run the *stale-only* arm that biased models on 15/17 and 13/17 samples ✓, while suppressing the *current* evidence that the same study shows *"largely rescues"* those failures ✓. Preferred fix unchanged: **reclassify the semantic branch to `literal` and let grep run**. Second choice: gate on `index.faiss` mtime and **never `deny`** on the stale path. Do not rebuild the index — that recreates a staleness obligation for a layer with no adoption evidence. *That this sat for 12 days is itself the finding: this loop currently produces proposals, not changes.*

**ADOPT (P1) — Install the official `typescript-lsp` and `pyright-lsp` plugins.**
This is the headline. It recovers the symbol layer we cut, at near-zero cost and with the three properties that killed the last attempt all inverted:

| Failure mode that killed Serena/codegraph | First-party LSP |
|---|---|
| Tool-selection collision in a 150+ catalog (RAG-MCP-class degradation) | Native tool, not a routable skill/MCP entry |
| Index staleness obligation | No index — the language server reads the live file |
| 62s facade latency / cold index | Long-lived server process, warm after startup |
| Bespoke code to maintain (2,386 lines deleted) | Two marketplace plugins + two binaries |

Coverage matches the repo exactly: 384 TS files, 503 Python files. It also gives **incremental diagnostics**, directly relevant to the existing per-edit full-project `tsc --noEmit`.

**ADOPT (P2) — Restore a minimal code-intelligence usage counter, and gate the LSP adoption on it.**
Carried forward from 2026-07-29, still zero rows. This time attach it to a specific decision: **measure LSP tool invocations for 2 weeks, then keep or uninstall.** July's cut was defensible precisely because it had a usage number; if we adopt LSP without one, the next reviewer is back to vibes. Natural home is **SG-04** (telemetry joinability + intel-bus consumer), which survived the cut.

**ADOPT (P3) — BACKLOG hygiene: retire ST-04 and the C.5 deny-flip gate.**
Both gate a component deleted on 2026-07-24 (`BACKLOG.md:64`, `:70`, `:109-116`). ~15 minutes, no risk. Second time of asking.

**WATCH — A structural index (SCIP-family or upstream codegraph).**
The controlled ablation is genuinely favourable ✓ and SCIP's governance is healthier ✓. But its own stated criterion is multi-file workload payoff, and LSP now covers the navigation use case that motivated most of our facade traffic. **Re-open only after** the LSP adoption has 2 weeks of usage data — if LSP invocations are high and users still hit multi-file localization pain, that is the signal. Not before.

**WATCH — Aider-style repo map.** Unchanged from last iteration. Cheapest structure-without-a-service option, no staleness obligation between runs. Superseded in priority by LSP.

**SKIP — Re-registering Serena.** Its LSP capability is now available natively without an MCP server or a catalog entry. Upstream health (27.8k stars ✓) does not change our 4.2%-adoption local result. Leave dormant.

**SKIP — Rebuilding the `/code-intel` facade.** Verified dead last iteration; ContextBench's *"sophisticated agent scaffolding yields only marginal gains"* ✓ is new independent evidence against it.

**SKIP — ST-01 as specified.** Premise still holds (`addFocusSymbol`, `context-bus.ts:868`, zero callers), but its value already ships from `files_in_play` basenames, and its original producer (codegraph's `proposed_bus_updates`) no longer exists. Re-scope or drop.

## 5. Integration approach

| Item | Files / actions | Effort | Risk |
|---|---|---|---|
| **P0** semantic-arm fix | `.claude/hooks/src/smart-search-router.ts` (~20 lines) → `npm run build` → `scripts/sync-to-active.sh`; extend `__tests__/smart-search-router.test.ts` | **S** | **Low-medium** — it is a `deny`-capable PreToolUse hook. Only change the semantic branch's *outcome*; leave the literal-first guard (`:388`, added `cdbae08`) untouched. Assert `classifyQuery` still returns `literal` for regex / identifier / path / short patterns |
| **P1** LSP plugins | `npm install -g typescript-language-server typescript`; `pip install pyright`; install `typescript-lsp` + `pyright-lsp` from the `/plugin` Discover tab | **S** (~30 min, mostly installs) | **Low** — additive. Watch three documented traps: binaries must be installed separately; first-registered server wins per extension; servers start only after workspace trust |
| **P2** usage counter | `shared/intel-bus.ts` emit + call sites; consumer under **SG-04** | **S–M** | Low — one append-only row, fail-open. Do not repeat the write-amplification profile flagged in **ST-09** |
| **P3** BACKLOG hygiene | `docs/system-update/BACKLOG.md:64,70,109-116` | **XS** | None |

**Sequencing:** P0 is independent and goes first — it is the only item that is actively wrong today. P3 rides the same commit. P1 next, with P2 landing alongside so the two-week adoption measurement starts on day one.

**BACKLOG ties:** P2 → **SG-04**. P3 retires **ST-04** and the **C.5** gate. P1 is a new item with no existing arc — it partially supersedes the intent behind **ST-01** (symbol-level intelligence) by different means. Nothing here depends on **ST-02**.

**What could go wrong.**
1. *LSP repeats the adoption failure.* Plausible — a tool being native does not force use. This is exactly why P2 gates it. Mitigation: a hard 2-week keep/uninstall decision with a number attached.
2. *Windows spawn cost.* This machine has measured spawn-latency pathology (`spawn-latency.ps1`, p50 814ms–2,167ms against a 30–80ms reference). Long-lived LSP servers should *amortize* better than per-edit `tsc` spawns, but startup may be slow and `startupTimeout` may need raising. **[Speculation]** — unmeasured here; measure before claiming a win.
3. *Duplication with `post-edit-diagnostics`.* LSP provides diagnostics natively. Do not delete the existing hook on assumption — compare outputs first, then decide.
4. *Hook-edit mechanics.* Repo `dist/` runs stale; per `hook-dev-lifecycle.md` any TS edit needs rebuild + sync, and `scripts/audit-braintrust-emits.sh` must be re-run afterwards. A hook fix does not take effect until the next commit syncs the `~/.claude` mirror.
5. *The 12-day precedent.* The largest risk is that this proposal, like the last, produces no commit.

## 6. Benefits

- **Correctness (P0).** Stops a hook from injecting 5.1-month-old file pointers as authoritative results while blocking the fresh grep. Measured harm class: 76.5–88.2 percentage-point increases in stale-reference generation ✓.
- **Capability (P1).** Recovers go-to-definition, find-references and hover across 887 tracked source files — the layer cut in July — without an index, a daemon, an MCP server, or a catalog entry.
- **Speed (P1).** Incremental per-edit diagnostics instead of a full-project `tsc --noEmit`, on a machine with known spawn-latency pathology. Magnitude unmeasured — see risk 2.
- **Fewer wrong edits.** `find-references` before a rename is precise where grep is approximate; this repo has already lost work to a spark agent dropping sibling content during multi-file TS edits (`proactive-delegation.md`).
- **Decision quality (P2).** Restores the ability to answer "is this earning its place?" with a number. Without it, the next cut/keep call is made on vibes — the failure this loop already demonstrated twice.
- **Honest plan (P3).** BACKLOG stops gating live work on a component deleted 17 days ago.

## 7. Open questions

1. **Will LSP actually get used?** The single unresolved question. Native availability ≠ invocation, and this component has a two-for-two record of adopting well-designed things the agent then ignored. P2 exists to answer it; the answer should be allowed to be "no, uninstall."
2. **Does LSP subsume `post-edit-diagnostics`, TLDR's `diagnostics`, or both?** Unknown until compared side by side. Resist deleting either on assumption — that is how the FAISS arm survived a cut aimed at exactly it.
3. **Is a first-party LSP tool exposed to subagents?** 77% of hook firings on this machine occur in subagents (`tldr-token-savings-measured.md`). If LSP is main-thread-only, its practical reach is much smaller than the file counts suggest. Unverified.
4. **Why did the P0 fix not happen?** Worth one honest look before adding four more recommendations to the same queue. If the loop reliably produces proposals that no session executes, the highest-leverage change is to the loop, not to code intelligence.
5. **Does the repo/active `settings.json` split hide other code-intel drift?** `post-edit-diagnostics` is registered only in the active copy. Intentional per `sync-known-gaps.md`, but it means the repo does not describe the agent's real diagnostics behaviour.
6. **Aider's PageRank attribution** remains unconfirmed against primary source — marked **[Speculation]** above. Only matters if the repo-map WATCH is ever promoted.
