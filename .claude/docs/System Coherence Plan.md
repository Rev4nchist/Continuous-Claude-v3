# CCv3 System Coherence — Comprehensive Plan

## Context

Continuous Claude (CCv3) is a context-management orchestration system. Its purpose is to ensure the *right* skills, agents, hooks, and context fire at the *right* moment so tasks execute reliably with the correct expertise. Today the system has substantial infrastructure (extensive hook ecosystem, agent roster, skill catalog, PostgreSQL + pgvector memory, TLDR daemon, Notion bridge, MCP servers — see [agent-skill-map.md](agent-skill-map.md) and [hook-audit-2026-04.md](hook-audit-2026-04.md) for current inventory) but several reliability gaps surfaced from the recent Friday health check + hook audit:

- **Observability gap**: We can verify a hook is *registered* but not whether it *fired*, *errored silently*, or *injected the wrong context*. At this scale, drift goes undetected for weeks.
- **Hook source confusion**: 5 shared library modules masquerade as orphan hooks; 60 zombie `.mjs` exist without sources; 3 registered hooks have no source (sentry/linear placeholders for future work).
- **Memory recall noise**: proactive injection scorer is too permissive; recall returns marginally relevant matches and erodes trust in the system's most important capability.
- **Routing brittleness**: skill activation is keyword-only — semantically equivalent prompts miss the right skill.
- **Capability overlap**: hooks vs MCPs vs skills sometimes step on each other (e.g., package-install-guard hook); no written policy exists.
- **Critical-path blindness**: knowledge tree freshness, Notion bridge integrity, agent/skill composition — none have health signals.
- **Documentation drift**: `help/SKILL.md` and `wiring/SKILL.md` reference hooks that no longer exist; `create-better-skills` is superseded by `skill-forge`.

The user's stated north star: *"context management, activating the correct skills, agent, hooks etc. when needed — so we reliably assign tasks that get executed properly with the correct context and expertise."* Reliability > latency. Paranoid review > speed.

---

## Decisions Captured (from 5-round interview)

| # | Question | Decision |
|---|----------|----------|
| 1 | Hook style | **Stay specialized.** One hook per concern. Latency irrelevant; reliability is paramount. |
| 2 | TLDR daemon | **Commit — make canonical.** Standardize all code-context lookups through it; add health check. |
| 3 | session-start-parallel | **Rewrite first.** Split 251-line hook into 2 (context-loaders + memory-loaders) before registering. Critical path. |
| 4 | Shared modules | **Move to `lib/` subdir.** Clean audit surface; orphans become real signal. |
| 5 | Hook telemetry | **Build it — full coverage.** JSONL trace per fire; weekly digest. Reliability-first observability. |
| 6 | Cleanup scope | **Audit first, decide per-hook.** Read each of the 60 zombies before deleting. Keep sentry/linear placeholders (planned). |
| 7 | Memory mode | **Both — raise threshold AND preview-then-inject.** Highest fidelity + control. |
| 8 | Rollback pace | **4 commits, panic-revert ready.** Health check between phases. |
| 9 | Skill routing | **Embed-and-match.** Reuse BGE; no per-prompt LLM call. |
| 10 | Tool-tier policy | **Adopt + audit.** Write policy doc; audit existing overlaps. |
| 11 | Hook scope | **Codify gate vs orchestrator.** Frontmatter `kind` field; reclassify all hooks. |
| 12 | create-better-skills refs | **Deprecated.** `skill-forge` is canonical going forward; refs are dead, not bugs. |
| 13 | Agent vs skill composition | **Dedicated Phase 5 + design doc.** Needs scout map + architect design before any refactor. Gated by user approval. |
| 14 | Knowledge tree health | **Add freshness + completeness checks.** WARN if >7d old or line-count drops >20%. |
| 15 | Bridge health | **Add bridge health checks.** Active Context parses, queue staleness, page IDs resolve. |
| 16 | ROADMAP scope | **Two ROADMAPs.** `ROADMAP.md` (product) + `SYSTEM-ROADMAP.md` (internal). |
| 17 | Canary timeout | **Adaptive — P95-based.** Self-tuning to historical durations × 2. |
| 18 | Memory dedup | **Backfill, keep newest.** ~5 deletions for the 0.996 similarity pairs. |
| 19 | Done criteria | **All four signals green.** Health green + 7-day clean telemetry + memory noise drop + ROADMAP shows next. |

---

## Architecture Overview

The plan reorganizes the system around three pillars:

1. **Visible reliability** — every hook firing is observable; silent failures become loud.
2. **Honest structure** — file layout matches conceptual roles (gates, orchestrators, injectors, telemetry, lib).
3. **Verified composition** — agents and skills explicitly map to each other with documented overlap.

```
.claude/
  hooks/
    src/
      lib/                     # NEW: shared modules (daemon-client, skill-router, etc.)
      gate/                    # frontmatter: kind=gate
      injector/                # frontmatter: kind=injector
      orchestrator/            # frontmatter: kind=orchestrator
      telemetry/               # frontmatter: kind=telemetry
      __tests__/
    dist/                      # built .mjs (only real hooks emitted; lib/ excluded)
  cache/
    hook-trace.jsonl           # NEW: append-only telemetry
    health-checks/             # existing
  docs/
    tool-tier-policy.md        # NEW: hook vs MCP vs skill rules
    composition-design.md      # NEW: Phase 5 deliverable
SYSTEM-ROADMAP.md              # NEW: internal infra work
ROADMAP.md                     # existing: product/feature work
```

---

## Phased Roadmap

### Phase 1 — Telemetry + Hygiene Foundation (~1 day)

Goal: Land observability and clean obvious cleanup before any structural change. This phase carries no risk to existing behavior and provides the signal we need to verify Phases 2-5.

- [ ] **Hook-trace tracer** — new hook `telemetry/hook-trace.ts` that appends `{name, event, durationMs, exitCode, sessionId, timestamp}` to `.claude/cache/hook-trace.jsonl`. Wired as a wrapper or via process.on('exit').
- [ ] **Weekly digest** — extend `health_check.py` with category `hook-runtime`: parses last 7 days of hook-trace.jsonl, surfaces:
  - registered-but-never-fired hooks
  - hooks with >5% non-zero exit rate
  - P50/P95 timing per hook
  - hooks that registered AND fired AND injected (where applicable)
- [ ] **Adaptive canary timeout** — modify `health_check.py` `memory-canary-roundtrip` to read last 10 runs from `history.jsonl`, set timeout to `P95 × 2`, floor at 90s, ceiling at 300s.
- [ ] **Memory dedup backfill** — one-time script `scripts/dedup_archival_memory.py`: for pairs ≥0.95 similarity, keep newest (tie-break on confidence), delete the rest. Log deletions.
- [ ] **Documentation drift fixes** — update `help/SKILL.md`, `wiring/SKILL.md`, `docs/ARCHITECTURE.md` to remove references to deleted hooks. Mark `create-better-skills` superseded by `skill-forge`.
- [ ] **Add to SYSTEM-ROADMAP.md** — create file; populate with Phases 2-5 as tracked goals.

**Verification:** Health check returns 0 (or only known WARNs). New `hook-runtime` category present. SYSTEM-ROADMAP.md exists with phase status. Memory dedup-scan reports 0 high-similarity pairs.

**Critical files:**
- `opc/scripts/health_check.py:252-263` (compute_exit_code; verify still correct)
- `opc/scripts/health_check.py:1759-1773` (git-remote-sync; uses fork)
- `.claude/hooks/src/telemetry/hook-trace.ts` (NEW)
- `.claude/cache/hook-trace.jsonl` (NEW, gitignored)
- `scripts/dedup_archival_memory.py` (NEW)
- `SYSTEM-ROADMAP.md` (NEW)

---

### Phase 2 — Per-Hook Cleanup Audit (~1-2 days, paranoid mode)

Goal: For each of the 60 zombie `.mjs` and 31 source-only files, make a per-file decision. No bulk delete.

- [ ] **Audit script** — `scripts/audit_hook_state.mjs`: for each `.mjs` in `dist/`, classify as
  - `LIVE` (registered + has source)
  - `LIB` (imported by other hooks; should move to `src/lib/`)
  - `ZOMBIE` (no source, not imported, safe to delete)
  - `STUB-NEEDED-LATER` (registered, no source, planned future use → keep registration, document gap)
  - `SOURCE-ONLY` (has source, never registered, never imported → archive or wire)
  - `UNCERTAIN` (review needed)
- [ ] **Per-hook decisions** — append to `.claude/docs/hook-audit-2026-04.md` with a row per file: classification + decision + rationale.
- [ ] **Apply decisions** in commits grouped by classification:
  - delete confirmed ZOMBIEs (after final manual eyeball of each)
  - move LIB files to `src/lib/` (Phase 3 prep)
  - archive source-only files to `src/_archived/` (or wire if "ready to wire" per audit)
  - leave STUB-NEEDED-LATER alone but document the gap in the relevant area's README
- [ ] **Preserve sentry/linear placeholders** — `sentry-error-context`, `sentry-deploy-release`, `linear-branch-context` registrations stay; add TODO comment in `settings.json` next to each pointing at SYSTEM-ROADMAP.md item.

**Verification:** `hook-orphans` health check WARN count drops to 0 (or only ZERO-IMPL-PLANNED). Audit doc reviewed by user before any deletions.

**Critical files:**
- `.claude/hooks/dist/*.mjs` (read every one)
- `.claude/hooks/src/*.ts` (read every orphan source)
- `.claude/docs/hook-audit-2026-04.md` (NEW)
- `~/.claude/settings.json` (add TODO comments only; no functional changes)

---

### Phase 3 — Structural Reorganization (~1 day)

Goal: Make file layout reflect roles. Done after Phase 2 so audit reveals true categorization.

- [ ] **Create `src/lib/`** — move 5+ shared modules (`daemon-client`, `skill-router`, `skill-validation-prompt`, `transcript-parser`, `diagnostics`, plus any LIB-classified from Phase 2).
- [ ] **Update esbuild config** — exclude `src/lib/**` from entry points (it gets bundled into hooks that import it, not emitted as standalone `.mjs`).
- [ ] **Update tsconfig paths** — add `@/lib/*` alias if helpful for clarity.
- [ ] **Update imports** — modify importing hooks to use new paths.
- [ ] **Frontmatter `kind` field** — for each remaining hook, add a top-of-file comment:
  - `// @hook-kind gate` (allow/deny + maybe inject)
  - `// @hook-kind injector` (always allow, adds context)
  - `// @hook-kind orchestrator` (manages state, multi-step)
  - `// @hook-kind telemetry` (logs/observes only)
- [ ] **Reorganize src/** into `gate/`, `injector/`, `orchestrator/`, `telemetry/` subdirs (optional — frontmatter is the source of truth; subdirs are convenience). User decides at PR-review time whether physical reorg is worth the diff.
- [ ] **Audit script update** — `audit_hook_state.mjs` reads frontmatter, validates `kind` matches actual behavior (heuristic: gates have `permissionDecision`, injectors have `additionalContext`, orchestrators read state files).

**Verification:** `npm run build` produces only registered-or-imported `.mjs` (no LIB emissions). Frontmatter validator passes. Health check still green.

**Critical files:**
- `.claude/hooks/src/lib/*.ts` (NEW location)
- `.claude/hooks/build.config.ts` or equivalent esbuild script (exclude lib/)
- `.claude/hooks/tsconfig.json` (path alias)
- `scripts/audit_hook_state.mjs` (extended)

---

### Phase 4 — Memory + Routing Reliability (~1-2 days)

Goal: Tighten the system's most load-bearing capability — getting the right context to the right place.

- [ ] **Split `session-start-parallel.ts`** into two hooks:
  - `session-start-context-loaders.ts` — knowledge tree, project registry, ROADMAP load, branch state
  - `session-start-memory-loaders.ts` — memory-awareness probe, archival recall warmup, BGE health
  - Each ≤120 lines. Both register fresh; old `session-start-parallel.ts` archives if it was wired (it isn't currently).
- [ ] **Memory recall threshold** — bump proactive-injection floor from current default to 0.85 RRF in the memory-awareness hook. Document in `.claude/skills/memory/SKILL.md`.
- [ ] **Preview-then-inject** — modify memory-awareness hook to inject a structured preview block:
  ```
  MEMORY MATCHES (3 above threshold):
    [confidence] type: short summary (id: X)
  Run /recall <id> for full content.
  ```
  Instead of dumping full content. The session decides whether to recall in full.
- [ ] **Embed-and-match skill router** — extend `skill-router.ts`:
  - Compute prompt embedding (BGE)
  - Match against pre-computed skill description embeddings (one-time index in `skills/_eval/skill-embeddings.json`)
  - If best match cosine ≥0.7 AND no keyword skill triggered → suggest the embed-matched skill via `additionalContext`
  - Cache embeddings per skill (rebuild on `bash scripts/sync-to-active.sh`)
- [ ] **Tree freshness + completeness checks** — extend `health_check.py` `knowledge-tree` category:
  - `tree-freshness`: WARN if `mtime > 7d`
  - `tree-completeness`: WARN if line count drops >20% from previous run (compare to last `history.jsonl` entry)
- [ ] **Bridge health checks** — extend `health_check.py` with `bridge` category (Notion MCP):
  - `bridge-active-context`: section parses successfully
  - `bridge-queue-fresh`: most recent Code↔Eve queue entry within 7d (or queue is empty marker present)
  - `bridge-pages-resolve`: HQ + Archive page IDs return 200
- [ ] **TLDR daemon canonical** — add `tldr-daemon-running` infrastructure check to health_check.py. Document the canonical-use policy in `.claude/docs/tool-tier-policy.md` (Phase 5 prep).

**Verification:**
- New session loads with no observable regression; `MEMORY MATCH` block is preview-shaped.
- Skill routing telemetry shows ≥1 embed-match activation in test prompts that miss keywords.
- Health check shows new `bridge` and `tree-freshness` categories all PASS.
- 7-day soak: hook-trace.jsonl shows session-start hooks firing successfully ≥95% of session starts.

**Critical files:**
- `.claude/hooks/src/session-start-context-loaders.ts` (NEW)
- `.claude/hooks/src/session-start-memory-loaders.ts` (NEW)
- `.claude/hooks/src/memory-awareness.ts` (modified — threshold + preview)
- `.claude/hooks/src/lib/skill-router.ts` (modified — embed-match)
- `.claude/skills/_eval/skill-embeddings.json` (NEW)
- `opc/scripts/health_check.py` (modified — new categories)
- `~/.claude/settings.json` (register 2 new session-start hooks)

---

### Phase 5 — Agent/Skill Composition (Discovery + Design Doc, ~3-5 days)

Goal: Map the full agent×skill cross-product, identify true overlaps, produce a written composition design. **No refactoring in this phase** — design only, gated by user approval before any further work.

- [ ] **Scout map** — spawn scout to enumerate:
  - Every agent (`.claude/agents/*.md`) and its declared role/tools
  - Every skill (`.claude/skills/**/SKILL.md`) and its triggers
  - Every cross-reference: skills that mention agents, agents that mention skills, hooks that route between them
  - Output: `.claude/docs/agent-skill-map.md` (table form)
- [ ] **Architect design** — spawn architect to draft `.claude/docs/composition-design.md`:
  - "Skills own behavior; agents own isolation" (or counter-proposal with reasoning)
  - Decision tree: when does work flow `skill-only` vs `skill→agent` vs `agent-only`?
  - For each agent, identify its companion skill (if any) and document the pairing
  - For each skill, identify whether it should/shouldn't spawn agents and why
  - Migration recommendations (which agents should be paired with skills, which left standalone)
- [ ] **Tool-tier policy doc** — `.claude/docs/tool-tier-policy.md`:
  - Hooks own enforcement + always-on context injection
  - MCPs own external service access (Notion, Sentry, Linear, Paper, GitHub)
  - Skills own multi-step workflows + behavior contracts
  - Audit table: existing overlaps and their resolution
- [ ] **User review checkpoint** — pause for explicit approval of `composition-design.md` and `tool-tier-policy.md` before any execution.
- [ ] **(Deferred) Execution sub-phases** — pairings, refactoring, agent prompt updates land in a separate plan file once design approved.

**Verification:** Two design docs exist, are coherent, and are approved by user. No code changed in this phase.

**Critical files:**
- `.claude/docs/agent-skill-map.md` (NEW)
- `.claude/docs/composition-design.md` (NEW)
- `.claude/docs/tool-tier-policy.md` (NEW)
- All 33 `.claude/agents/*.md` (read)
- All 138 `.claude/skills/**/SKILL.md` (read)

---

## Verification Plan (End-to-End)

After each phase commit:

1. **Health check** — `cd $CLAUDE_OPC_DIR && PYTHONPATH=. uv run python scripts/health_check.py` must exit 0 or 1 (PASS or WARN-only). No FAILs.
2. **Hook telemetry digest** — at least 2 sessions worth of `hook-trace.jsonl` lines, no >5% error rate per hook.
3. **Memory canary** — round-trip succeeds, adaptive timeout adjusts (visible in `history.jsonl`).
4. **Bridge integrity** — Notion HQ page fetches; Active Context section parses.
5. **Manual smoke test** — start a fresh session, confirm `MEMORY MATCH` preview format, knowledge tree loads, no startup errors.

After Phase 5 design approval (before any further execution):

6. **Soak window** — 7 days of clean telemetry from Phases 1-4.
7. **Memory recall noise** — measurable drop in `MEMORY MATCH` injections per session vs. pre-Phase-4 baseline.
8. **ROADMAP shows next** — `SYSTEM-ROADMAP.md` has the Phase-5-execution plan as the active item.

---

## Done Criteria

The whole work is complete when **all four signals are green**:

- [ ] Health check returns 0 end-to-end (no WARNs that aren't intentional like "stub planned for later").
- [ ] Hook telemetry shows zero silent failures over a 7-day window post-Phase-4.
- [ ] Memory recall noise is measurably reduced (proactive matches injected per session is lower; subjective relevance is up).
- [ ] `SYSTEM-ROADMAP.md` shows the next item (Phase 5 execution or whatever's next).

---

## Rollback Posture

- **Per-phase commit** — each phase is one commit (or a small chain) on `feature/system-coherence`.
- **Health check between** — never start phase N+1 with a non-green check from phase N.
- **Panic revert ready** — if something breaks, `git revert <phase-commit>` followed by `bash scripts/sync-to-active.sh` returns to the prior phase's state. No phase touches a system invariant that revert can't restore.
- **No simultaneous merges** — feature branch only; squash-merge to main per phase or as a single 5-commit batch after final approval.

---

## Risk Register

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Telemetry hook itself crashes/swallows events | Medium | Medium | Wrap in try/catch; never throw; fall through to fire-and-forget on error |
| Adaptive canary timeout self-tunes too tight after one fast run | Low | Low | Floor at 90s; need 5+ runs before adaptive kicks in |
| Memory dedup deletes wrong entry | Low | Medium | Dry-run first, log deletions, manual review of script output |
| Embed-match suggests wrong skill confidently | Medium | Low | Conservative threshold (≥0.7 cosine), only triggers when keywords miss, suggestion not enforcement |
| Phase 3 lib/ move breaks imports | Medium | Medium | Run health check + vitest after move; revert if any test fails |
| Session-start split misses a hook responsibility | Low | High | Phase 1 telemetry shows what each session-start hook actually does; split decisions informed by real data not docs |
| Phase 5 design doc disagreement | High | Low | Design phase only; nothing executes until approved; iterate freely |
| Notion bridge health checks consume MCP budget | Low | Low | Cap at 30s per weekly run; cache page-ID resolution between checks |

---

## Open Items (Tracked in SYSTEM-ROADMAP.md, Not Blocking)

1. **RLM Production Adoption** — separate plan, MVP-ready (Docker prebake done, wrapper designed). Not in scope for this work; track as next ROADMAP item after Phase 5 design approval. Prior plan content for reference: `rlms` library wrapper at `opc/scripts/core/rlm_client.py`, Docker sandbox `continuous-claude/rlm-sandbox:3.11`, max_depth=1, `min_context_chars=300_000`.
2. **Agent/skill execution phase** — emerges from Phase 5 design doc. Estimated 2-3 days once approved.
3. **`tools:` field missing on several agents** (braintrust-analyst, debug-agent, onboard, etc.) — minor health WARN; fix in Phase 2 cleanup or as standalone hygiene PR.
4. **`qlty` CLI exit=1** — investigate config; LOW priority WARN.
5. **142 uncommitted changes** — most are this work-in-progress (skills archive, hook fixes); will resolve naturally as Phases land.

---

## Critical Files Index

| File | Phase | Action |
|------|-------|--------|
| `opc/scripts/health_check.py` | 1, 4 | Add hook-runtime, bridge, tree-freshness categories; adaptive canary timeout |
| `.claude/hooks/src/telemetry/hook-trace.ts` | 1 | NEW — observability foundation |
| `.claude/cache/hook-trace.jsonl` | 1 | NEW — gitignored; weekly digest source |
| `scripts/dedup_archival_memory.py` | 1 | NEW — one-time backfill |
| `SYSTEM-ROADMAP.md` | 1 | NEW — internal infra tracking |
| `scripts/audit_hook_state.mjs` | 2 | NEW — per-hook classification |
| `.claude/docs/hook-audit-2026-04.md` | 2 | NEW — audit decisions log |
| `.claude/hooks/src/lib/*.ts` | 3 | NEW location for 5+ shared modules |
| `.claude/hooks/build.config.ts` | 3 | Modify — exclude lib/ from entry points |
| `.claude/hooks/src/session-start-context-loaders.ts` | 4 | NEW — split from session-start-parallel |
| `.claude/hooks/src/session-start-memory-loaders.ts` | 4 | NEW — split from session-start-parallel |
| `.claude/hooks/src/memory-awareness.ts` | 4 | Modify — threshold raise + preview format |
| `.claude/hooks/src/lib/skill-router.ts` | 4 | Modify — embed-and-match fallback |
| `.claude/skills/_eval/skill-embeddings.json` | 4 | NEW — pre-computed BGE per skill description |
| `.claude/docs/agent-skill-map.md` | 5 | NEW — scout deliverable |
| `.claude/docs/composition-design.md` | 5 | NEW — architect deliverable |
| `.claude/docs/tool-tier-policy.md` | 5 | NEW — hook/MCP/skill rules |
| `~/.claude/settings.json` | 2, 4 | Modify — TODO comments on placeholders; register 2 new session-start hooks |

---

## Execution Note

This plan ships through `/ralph` per Plan-to-Ralph enforcement. After ExitPlanMode, the next session uses Ralph to execute Phase 1, gate on health check, then Phase 2, etc. Each phase produces an updated `SYSTEM-ROADMAP.md` entry showing status.

Phase 5 explicitly pauses Ralph at the design-doc checkpoint for user review. No automatic execution past that gate.

---
---

# Addendum (2026-04-26) — Phase 5a Deep-Dive Findings + Cleanup Plan

## Context

After the Phase 5a scout pass produced `.claude/docs/agent-skill-map.md`, three findings looked load-bearing and the user asked for a deep verification before proceeding to Phase 5b (architect → composition design):

1. `plan-agent` allegedly references a non-existent `skills/create_plan/SKILL.md` path — possibly explaining a real symptom: when running with bypass-permissions, plan mode skips the user-approval step.
2. `braintrust-analyst` and `session-analyst` allegedly are functional duplicates — but the user has a working Braintrust observability stack (claude-code project, ~21 spans/hour) and was uncertain whether the agents are essential.
3. Five TLDR sub-skills allegedly have no activation path — but TLDR is critical infrastructure and the user expected the skill layer to be load-bearing.

Three parallel scouts verified each claim with file-level evidence. This addendum captures the verdicts and a small, safe restructure plan. **Phase 5b (architect composition design) stays paused until this addendum is approved + executed**, because two of the three findings (broken plan-agent path, duplicate Braintrust agents) directly affect the workflow taxonomy the architect would otherwise codify.

---

## Verified findings

### 1. plan-agent path bug — REAL

- `.claude/skills/create_plan/` does **not exist** (neither hyphenated nor underscored)
- `plan-agent.md:16` runs `cat $CLAUDE_PROJECT_DIR/.claude/skills/create_plan/SKILL.md` — silently fails
- The planning methodology actually lives at `.claude/skills/plan-agent/SKILL.md`
- Callers chained through plan-agent: `build/`, `refactor/`, `migrate/` skills (5 reference points). `maestro/` uses its own state-manager and is unaffected. `release/` does not call plan-agent.

**On the bypass-permissions symptom:** the hooks are not at fault. `plan-exit-tracker` writes the approval state file when `ExitPlanMode` fires; `plan-to-ralph-enforcer` correctly blocks code edits afterward. The user-approval step that bypass mode skips is the **interactive permission dialog Claude Code shows before `ExitPlanMode` executes** — that dialog *is* the approval gate, and bypass-permissions removes it. The CHECKPOINT prose instructions in `build/`, `refactor/`, `migrate/` also lose enforcement under bypass since they require a user message.

**Two distinct fixes** required:
- **Fix A1 (one-line):** Correct `plan-agent.md:16` to point at `skills/plan-agent/SKILL.md`.
- **Fix A2 (doc):** Update `.claude/rules/plan-to-ralph-enforcement.md` to flag that bypass-permissions removes the dialog gate. Optionally add a UserPromptSubmit hook that detects bypass and warns — left as a Phase 5b decision.

### 2. braintrust-analyst vs session-analyst — DUPLICATES

Side-by-side verification:

| Field | braintrust-analyst | session-analyst |
|---|---|---|
| description | "Analyze Claude Code sessions using Braintrust logs" | "Analyze Claude Code sessions using Braintrust logs" |
| model | opus | opus |
| skill loaded | `braintrust-analyze/SKILL.md` | `braintrust-analyze/SKILL.md` |
| primary command | `braintrust_analyze.py --last-session` | `braintrust_analyze.py --last-session` |
| Distinguishing logic | Verbose enforcement prompt + lists every flag | Lean 3-step prompt |

**Both agents are independent of the active tracing path.** The actual tracing pipeline — what produces the spans the user sees in Idea Lab → claude-code — is `~/.claude/hooks/braintrust_hooks.py`, registered for 5 hook events (SessionStart, UserPromptSubmit, PostToolUse, Stop, SessionEnd). That hook plus `BRAINTRUST_API_KEY` + `TRACE_TO_BRAINTRUST=true` does the work. Hundreds of session state files in `~/.claude/state/braintrust_sessions/` confirm it is running.

The agents are **retrospective analysis utilities** that read Braintrust logs after the fact. They do not affect what hits Braintrust. Keeping both creates name confusion with no benefit.

**Fix B1:** Archive `session-analyst` (move to `.claude/agents/_archived/2026-04-26-session-analyst.md` with revival note); keep `braintrust-analyst` as the canonical retrospective analysis agent. Update `docs/agents/README.md` and any references.

### 3. TLDR skill layer — MOSTLY INERT (but tldr-code IS wired)

Inventory correction: the previous pass had wrong skill names. The actual TLDR-prefixed skills are:

| Skill | Wired? | Notes |
|---|---|---|
| `tldr-code` | **YES** — registered in `skill-rules.json`, priority: critical, has keywords + intentPatterns | Single working entry point |
| `tldr-router` | NO — not in skill-rules.json, no keywords | Reference doc; routes to CLI commands not sub-skills |
| `tldr-overview` | NO | Body says "type `/overview`"; manual only |
| `tldr-deep` | NO | Body says "type `/tldr-deep <function>`"; manual only |
| `tldr-stats` | NO + **broken on Windows** (uses `python3` which triggers MS Store alias) | |

**The actual TLDR system is the hook layer**, not the skills:

| Hook | Behavior |
|---|---|
| `tldr-context-inject.ts` | Injects call graph / CFG / DFG before agent calls |
| `tldr-read-enforcer.ts` | Intercepts code Reads → returns AST summary |
| `session-start-tldr-cache.ts` | Warms daemon at session start |
| `smart-search-router.ts` | Routes Grep → tldr context |
| `impact-refactor.ts` | Injects `tldr impact` before refactor |
| `arch-context-inject.ts` | Injects `tldr arch` |
| `edit-context-inject.ts` | Injects TLDR context before edits |
| `post-edit-diagnostics.ts` | Runs `tldr diagnostics` after edits |
| `signature-helper.ts` | Pulls function signatures via tldr |

All 9 talk to the daemon/CLI directly. **The skill layer is not the load-bearing path**; the hooks are. `tldr-code` acts as a "user-prompted teaching layer" that suggests CLI commands. There is no design intent visible in the codebase that the un-wired sub-skills should be load-bearing.

**Fix C1:** Archive `tldr-router`, `tldr-overview`, `tldr-deep` (redundant with `tldr-code` + the TLDR hook layer).

**Fix C2:** Fix `tldr-stats` (`python3` → `python` for Windows) and wire it into `skill-rules.json` with keywords like `["tldr stats", "token usage", "session cost"]`. Session token usage is a real telemetry signal with no other interface.

**Fix C3:** Add a one-paragraph note to `tldr-code/SKILL.md` clarifying that it is the canonical entry point and the TLDR hook layer covers automatic injection — so future sessions don't try to add new sub-skills.

---

## Restructure plan — ranked by blast radius

| # | Fix | Files touched | Reversibility | Risk |
|---|---|---|---|---|
| 1 | **A1** plan-agent path correction | `.claude/agents/plan-agent.md` (one line) | Trivial revert | None |
| 2 | **C3** tldr-code clarifying note | `.claude/skills/tldr-code/SKILL.md` (one paragraph) | Trivial revert | None |
| 3 | **B1** Archive session-analyst | `git mv` + update `docs/agents/README.md` | `git revert` | None — agent is unused except by explicit name |
| 4 | **C1** Archive tldr-router/overview/deep | `git mv` 3 dirs + revival note | `git revert` | None — no activation path |
| 5 | **C2** Fix + wire tldr-stats | edit `python3`→`python`; add to `skill-rules.json` | `git revert` | Low — currently does not run, so forward-only |
| 6 | **A2** Document bypass-permissions × plan-mode interaction | `.claude/rules/plan-to-ralph-enforcement.md` (append section) | Trivial revert | None |

All six are mergeable as **one commit** on `feature/system-coherence` because they are independent in code and unified in theme ("Phase 5a deep-dive cleanup"). Verification gate after the commit:

1. `cd $CLAUDE_OPC_DIR && PYTHONPATH=. python scripts/health_check.py` — exit 0 or WARN-only
2. `tldr-stats` activation: type "show tldr stats" — confirm skill-activation-prompt suggests it
3. Plan-agent: spawn it via Task tool with a small request — confirm it reads `skills/plan-agent/SKILL.md`
4. Bridge / Braintrust: no change expected — sanity check `~/.claude/state/braintrust_sessions/` still has new files after a session

## Out of scope (deferred)

- Hook that detects bypass-permissions and warns about plan-mode (optional half of A2) — Phase 5b can decide
- Auditing the 9 TLDR hooks for internal redundancy — separate scope, not blocking
- Renaming `braintrust-analyst` to e.g. `braintrust-replay` — defer to Phase 5b composition naming

## After this addendum lands

Phase 5b (architect → `composition-design.md` + `tool-tier-policy.md`) resumes with a **cleaner input**: the agent×skill map gets re-run after archives, the architect sees a smaller honest taxonomy, and bypass-permissions × plan-mode is a known constraint to design around.
