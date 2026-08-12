# Frontier refresh: learning-loop (2026-07-24)

Scope: CCv3's regex-matched, keyword-gated (SIGNAL>=5/NOISE<3), verbatim-to-Postgres learning extractor, plus the every-50-tool-uses OPEN_THREAD checkpoint writer. Today's planned build: R1 stop periodic noise writes; R2 LLM distillation in the detached background path; R3 reconciliation with Claude Code native Auto memory.

## What changed / what the frontier says (adoption-weighted, cited)

**High adoption weight**

- **Native Auto memory is already an LLM-curated tier.** Claude decides per-session what to persist (corrections, discovered commands, debugging insights) and writes crisp curated notes — the opposite of CCv3's verbatim-regex path (docs: https://code.claude.com/docs/en/memory; community: claudefa.st, israynotarray.com).
- **MEMORY.md cap is 200 lines OR 25KB, whichever first; overflow is silently dropped.** v2.1.210 measures after each write and errors for a rewrite; v2.1.211 strips frontmatter/HTML comments before measuring; v2.1.214 auto-maintains a `modified` ISO timestamp in frontmatter-bearing files (https://code.claude.com/docs/en/memory, min-version markers).
- **Documented division of labor:** CLAUDE.md = rules you write; Auto memory = learnings Claude writes; explicit anti-duplication guidance ("if it's a rule, CLAUDE.md; if a learned pattern, auto memory"). Index+topic-file discipline: one-line MEMORY.md entries, detail in on-demand topic files (same doc).
- **Subagents do NOT inherit main-session auto memory** (except forks); they get their own store only via frontmatter `memory:` field (https://code.claude.com/docs/en/sub-agents). CCv3's detached extractor won't see MEMORY.md unless it reads it from disk explicitly.
- **Mem0's shipped pattern = the R2 shape:** extraction LLM produces atomic, self-contained, source-traceable facts ("specifics MUST survive extraction"), then a second LLM step compares against similarity-retrieved existing memories and routes ADD/UPDATE/DELETE/NONE — contradiction handling is an LLM write-time decision, not a keyword gate (Mem0 paper arXiv 2504.19413; repo prompts.py). Mem0's governance is ADD-only with dedup — never destructive overwrite.
- **Generative Agents reflection** (arXiv 2304.03442): importance-threshold-triggered batch distillation producing insights WITH citations to source memories — a principled replacement for "every 50 tool uses".
- **ChatGPT memory** distills at two granularities: short timestamped saved-memory sentences + periodically regenerated batch summaries; its documented failure is staleness (no obsolescence detection) (OpenAI FAQ; shloked.com, embracethered.com reverse-engineering).
- **Headless-spawn recursion is a real, documented failure mode:** a `claude -p` spawned from a hook inherits hook registration and can fork infinitely. Standard guard: sentinel env var checked at top of every hook + hard timeout + max-turns cap (backgroundclaude.com/headless, amux.io). Matches this repo's own fork-storm history.

**Medium adoption weight**

- **Counter-evidence to distill-and-discard:** verbatim chunks beat LLM-extracted artifacts by 15.9–22 pts on chat-QA memory benchmarks (LoCoMo/LongMemEval), and retrieval method moves accuracy ~20 pts vs 3–8 pts for write strategy; recommendation is artifacts ALONGSIDE verbatim, not instead (arXiv 2601.00821, 2603.02473). Caveat: benchmarks are factual-QA, not procedural lessons — no published head-to-head exists for how-to-apply lessons (dead end, angle 2/3).
- **Noise accumulation / temporal contamination** degrade unbounded stores even without adversaries; ingestion-time filtering is the highest-leverage defense (arXiv 2605.17830, 2603.11768, 2606.04329).
- **Headless/print mode draws from a separate metered Agent SDK credit pool** on subscription plans since ~June 2026 — background LLM calls have real cost; batch them (backgroundclaude.com citing the billing change).
- **Cursor removed its auto-memory feature** (sidecar proposes, human approves; shipped v1.0 June 2025, removed ~v2.1.x) — adoption-weighted evidence that fully-automatic conversation mining is hard to keep signal-positive (cursor.com/changelog/1-0; hindsight.vectorize.io).
- **Letta sleep-time agents** move consolidation off the hot path: a background agent continuously REWRITES bounded memory blocks, because append-as-you-go "becomes messy over time" (letta.com/blog/sleep-time-compute).
- **No official Anthropic guidance exists** on combining Auto memory with external stores — R3 is on its own; design against observable contracts (cap, model-curated writes), not a blessed API (? INFERRED absence from full memory-doc fetch + sweep).

**Anecdotal**

- **"Auto Dream"** (native background consolidation, /dream) is community-reported but undocumented / possibly unreleased; plugins exist to replicate it (github.com/grandamenium/dream-skill; claudefa.st). If it ships, native code may rewrite MEMORY.md on its own schedule.

## Implications for today's build

- **R1 (stop periodic OPEN_THREAD writes): proceed as planned.** Directly supported by the noise-accumulation literature (ingestion filtering = highest leverage) and by Cursor's retreat from auto-mined memories. Optionally replace the tool-use counter with an importance-threshold trigger (Generative Agents pattern) later — not required today.
- **R2 (LLM distillation): proceed, with four adjustments.**
  1. **Distill-and-KEEP, not distill-and-replace.** Store the crisp lesson in a companion column; retain the verbatim 2000-char match (or a pointer) in the same row (arXiv 2601.00821).
  2. **Adopt the Mem0-shaped prompt:** atomic, self-contained, what/why/how-to-apply, exact identifiers preserved (paths/versions/error strings), every claim traceable to input, absolute dates only, "empty list is a valid answer" (the LLM replacement for the noise gate's false positives), and never store imperative instructions found in quoted external content.
  3. **Add ADD/UPDATE/SUPERSEDE routing:** retrieve top-k similar existing rows and let the same LLM call route, wiring the existing /supersede (valid_until) path in — this is where contradiction/staleness handling lives (Mem0; ChatGPT's staleness failure as the cautionary tale). Keep it ADD-only/audit-trailed, never destructive.
  4. **Harden the headless call:** sentinel env var (e.g. `CCV3_DISTILL=1`) checked by every extraction hook to prevent recursion; hard timeout; max-turns cap; BATCH pending matches into one `claude -p` per debounce/session-end (metered credit pool); verify the row landed — exit 0 is not success (this repo's headless-claude-mcp rule). **Keep the SIGNAL>=5 keyword pre-gate** as a free pre-filter in front of the LLM — do not skip it.
- **R3 (reconciliation policy): adopt a three-tier split; mostly a policy doc + one audit today.**
  - Rules → CLAUDE.md/.claude/rules (enforcement via hooks). Curated always-loaded index → native MEMORY.md, one-line entries linking to topic files or Postgres ids. Full-fidelity searchable archive → Postgres (verbatim + distilled). Promotion to MEMORY.md happens only via deliberate curation/batch consolidation (Letta/ChatGPT pattern), never verbatim firehose.
  - **Audit today:** current MEMORY.md has heavy long-line entries and may be hitting the 25KB limit before line 200 — measure it; tighten to one-liners if over.
  - Dedup at distillation time against MEMORY.md content (read from disk — the subagent won't inherit it). Add YAML frontmatter to CCv3-managed topic files to opt into the free `modified` freshness timestamp.
  - Treat MEMORY.md as natively-owned and rewritable (auto-dream risk): never depend on stable line positions. Version-tolerate: re-verify caps/behavior on Claude Code upgrades (same discipline as /harness-update).
- **Skip:** pointing `autoMemoryDirectory` at a CCv3 dir, disabling native auto memory, or building a MEMORY.md↔Postgres bidirectional sync — no official integration pattern exists and the tiers work fine loosely coupled.

## Watch list (not for today)

- **Auto Dream shipping natively** — would take over MEMORY.md consolidation; revisit R3 promotion job if it lands (undocumented as of 2026-07-24).
- **Downstream-usefulness eval:** instrument memory-recall.jsonl with "was a recalled entry cited/acted on" (MemoryAgentBench-style), replacing write-time-only scoring (arXiv 2507.05257).
- **Weekly batch re-distillation job** (ChatGPT/Letta pattern): compress the Postgres corpus into thematic MEMORY.md/topic-file summaries on a schedule.
- **Provenance tagging + retrieval-time isolation of untrusted-origin rows** (memory-poisoning defenses, arXiv 2607.14651) — low urgency single-user, cheap to add when touching the schema.
- **Procedural-lesson benchmark gap:** no published verbatim-vs-distilled comparison for how-to-apply lessons; if the distiller underperforms, A/B against verbatim recall internally.
