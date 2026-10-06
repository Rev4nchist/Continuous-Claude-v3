# Agent & Skill Map — CCv3
Generated: 2026-04-27 | Branch: feature/system-coherence | Phase 5c step 10 refresh

## Counts

| Entity | Count |
|--------|-------|
| Agents (active in `.claude/agents/`) | 35 (+ 1 deprecated stub: session-analyst.md — canonical archived to `_archived/2026-04-26-duplicates/`) |
| Agents (archived) | 1 (session-analyst, plus README) |
| Skills (active, substantive SKILL.md) | ~102 |
| Workflow orchestrator skills | 14 |
| Hooks (src) | 100+ |

---

## Agents

Active agents are `.claude/agents/*.md` excluding `_archived/`. The `session-analyst.md` file remains at the repo root as a deprecated stub — its canonical copy lives at `_archived/2026-04-26-duplicates/session-analyst.md`. `braintrust-analyst` is RETIRED 2026-09-30 (moved to `.claude/agents-archive/`; see `archive/braintrust-2026-10/`).

| Name | Model | Purpose | Key Tools | Companion Skill | Surfaced By |
|------|-------|---------|-----------|-----------------|-------------|
| aegis | opus | Security vulnerability audit | Read, Bash, Grep, Glob | — | release, security |
| agent-factory | opus | Scaffold new agent .md files (validate frontmatter, draft, hand off for review) | Read, Write, Glob, Grep, Bash | sub-agents / agent-development (optional) | — |
| agentica-agent | sonnet | Build Python agents with Agentica SDK | Bash, Read, Write, Edit, Glob, Grep | `agentica-sdk/SKILL.md` | — |
| arbiter | (inherit) | Test execution and validation | Bash, Read, Glob, Grep | — | fix, build, refactor, release, tdd |
| architect | (inherit) | System design and planning | Read, Glob, Grep, Write, Bash | — | build, refactor, migrate, maestro |
| atlas | (inherit) | Full E2E and test-suite runner | Bash, Read, Glob, Grep | — | release |
| braintrust-analyst | opus | RETIRED 2026-09-30 (see `archive/braintrust-2026-10/`). Braintrust session log retro-analysis | Bash, Read | `braintrust-analyze/SKILL.md` | — |
| critic | (inherit) | Feature/implementation code review | Read, Glob, Grep | — | review |
| debug-agent | (inherit) | General root-cause analysis for unclear or single-file bugs (R1) | Bash, Read, Glob, Grep | `systematic-debugging/SKILL.md` | fix, maestro |
| deployer | sonnet | Vercel/Railway/Sentry/Linear/Neon deployments | Bash, Read, Glob, Grep, WebFetch | `vercel-cli`, `railway-cli`, `sentry-cli`, `neonctl` (R8 conditional) | release, build |
| herald | (inherit) | Changelog and version bump writer | Write, Read, Edit, Bash, Grep, Glob | — | release |
| judge | sonnet | Refactoring quality review — behavior preservation verdict | Read, Grep, Glob | — | refactor (optional companion, R2) |
| kraken | (inherit) | Complex implementation via TDD | Bash, Read, Edit, Write, Glob, Grep | — | fix, build, refactor, tdd, maestro |
| liaison | sonnet | Integration / external API review | Read, Grep, Glob | — | release (optional companion, R2) |
| maestro | (inherit) | Multi-step orchestration conductor | Read, Bash, Grep, Glob, Task, Skill, AskUserQuestion | `maestro/SKILL.md` | maestro |
| memory-extractor | sonnet | Extract perception changes from session transcripts | Bash, Read | — | — |
| onboard | (inherit) | Brownfield onboarding — initial continuity ledger | Read, Glob, Grep, Bash | `onboard/SKILL.md` | build (brownfield), explore |
| oracle | (inherit) | External research — web, docs, APIs (7-tool stack) | WebSearch, Bash, Read | `exa`, `opencli`, `github-search` | fix, build, migrate, maestro |
| pathfinder | opus | External repository research and analysis | Read, Bash, Grep, Glob | — | — |
| phoenix | opus | Refactoring planning AND migration planning | Read, Bash, Grep, Glob | — | refactor, migrate |
| plan-agent | (inherit) | Implementation planning agent | Read, Glob, Grep, Write | `plan-agent/SKILL.md` | refactor, migrate, release, build |
| plan-reviewer | (inherit) | Plan quality gate before code changes | Read, Grep, Glob | — | refactor, review |
| principal-reviewer | opus | Senior/staff review — architecture, security, blast radius | Read, Glob, Grep, Bash (NO Edit/Write — review-only) | — | — (no hook routing yet) |
| profiler | (inherit) | Performance profiling, race conditions, memory issues | Read, Bash, Grep, Glob | — | build, maestro |
| react-perf-reviewer | (inherit) | React/Next.js performance code review | Read, Grep, Glob | `react-perf/SKILL.md` | (PostToolUse-injected via react-perf-context hook) |
| review-agent | (inherit) | Synthesis code reviewer — final release approval | All tools | — | review, release |
| scout | (inherit) | Codebase exploration and pattern finding | Read, Grep, Glob, Bash | — | build, fix, explore, migrate, maestro |
| scribe | (inherit) | Documentation, handoffs, session summaries | Read, Write, Glob, Grep | `create_handoff/SKILL.md`, `continuity_ledger/SKILL.md` | release, maestro |
| sentinel | sonnet | Browser QA — multi-role E2E and UAT | Bash, Read, Write, Glob, Grep | `browser-dev-cycle/SKILL.md` (bidirectional, R4) | browser-dev-cycle |
| session-analyst | opus | DEPRECATED. Its replacement braintrust-analyst is RETIRED 2026-09-30 | Bash, Read | `braintrust-analyze/SKILL.md` (duplicate) | — |
| sleuth | opus | Deep bug forensics — multi-file, evidence-grade reproduction (R1) | Read, Bash, Grep, Glob | `systematic-debugging/SKILL.md` | fix |
| spark | (inherit) | Lightweight fixes and quick tweaks | Read, Edit, Write, Bash, Grep, Glob | — | fix, build |
| surveyor | (inherit) | Migration and upgrade review | Read, Grep, Glob | — | migrate |
| ui-compliance-reviewer | (inherit) | UI compliance and accessibility code review | Read, Grep, Glob | `ui-audit/SKILL.md` | — |
| validate-agent | (inherit) | Validates plan tech choices against current best practices | All tools | — | — |
| wizard | opus | CCv3 setup on fresh machines — drives wizard.py and verify-setup.sh | Bash, Read, Write, Glob, Grep | — (reads BOOTSTRAP.md and wizard.py directly) | — |

---

## Skills

### Workflow Orchestrators (14)

| Skill | Trigger | Companion Agents | Notes |
|-------|---------|------------------|-------|
| build | build, implement, feature | scout, oracle, architect, kraken, spark, profiler, arbiter, deployer | 4 modes: greenfield, brownfield, tdd, refactor |
| fix | fix, bug, broken, debug | sleuth (deep forensics), debug-agent (general), kraken, oracle, arbiter | "Investigator selection" subsection codifies sleuth/debug-agent split (R1) |
| explore | explore, understand, map | scout, onboard | quick / deep / architecture |
| ralph | /ralph, autonomous | ralph workflow | GSD lifecycle |
| maestro | /maestro, orchestrate | maestro, architect, kraken, spark, oracle, scout, debug-agent, profiler, scribe | 5 patterns; phase-gated |
| refactor | refactor, restructure | phoenix, plan-agent, kraken, plan-reviewer, arbiter, judge (optional, R2) | judge optional companion for high-stakes architecture refactors |
| migrate | migrate, upgrade, port | oracle, phoenix, plan-agent, kraken, surveyor | Research → analyze → plan → implement → review |
| release | release, ship, deploy, launch | aegis, atlas, review-agent, herald, scribe, deployer, liaison (optional, R2) | liaison optional for cross-service / external-API releases |
| review | /review, code review, PR | critic, plan-reviewer, review-agent | (principal-reviewer reachable but not hook-routed) |
| security | security audit, vulnerability | aegis | Wraps aegis with structured reporting |
| tdd | TDD, test-driven, red-green | kraken, arbiter | Red → Green → Refactor |
| test | test suite, test run | arbiter, atlas | Routes to runner |
| premortem | premortem, risk | — | Structured risk checklist; no agent spawn |
| plan-mode | plan, /plan | plan-agent | Plan mode entry |

### Memory System (5)

R9 closed: these are 4 distinct slash-command skills, not thin pointers. `memory` is the master router; the four sub-skills implement separate operations.

| Skill | Trigger | Notes |
|-------|---------|-------|
| memory | memory, recall, remember, store learning | Master router |
| recall | /recall, find memory | PostgreSQL+pgvector hybrid RRF |
| remember | /remember, store this | Store learning to memory |
| recall-reasoning | recall reasoning, why did we | Distinct backend (artifact_query.py + reasoning files), NOT pgvector |
| memory-curate | curate memory | Quality management, deduplication |

### Session Continuity (3)

| Skill | Companion Agent |
|-------|-----------------|
| create_handoff | scribe |
| resume_handoff | — |
| continuity_ledger | scribe |

### Debugging Guardrails (3 — block 1x/session before relevant work)

| Skill | Trigger | Companion Agents |
|-------|---------|------------------|
| systematic-debugging | bug, error, fix, debug | sleuth, debug-agent (R1 split documented) |
| databases | SQL, postgres, query, migration | — |
| code-review | PR, review, merge, complete | critic, review-agent |

### Infrastructure / Ops (8)

| Skill | Companion Agent |
|-------|-----------------|
| vercel-cli | deployer |
| railway-cli | deployer |
| neonctl | deployer (R8 conditional — wired in deployer.md) |
| sentry-cli | deployer |
| docker | — |
| git | — |
| linearis | — |
| gh | — |

### Codebase Analysis (3 active families post-cleanup)

| Skill | Trigger | Notes |
|-------|---------|-------|
| tldr-code | debug, refactor, complexity, call graph, data flow, analyze | Canonical TLDR entry. 9 hooks auto-inject context. |
| tldr-stats | tldr stats, token usage, session cost | Wired into skill-rules.json (Phase 5a deep-dive C2). Python `python3` → `python` fix. |
| ast-grep-find | ast-grep, AST search | — |

Archived in `_archived/2026-04-26-tldr-cleanup/`: `tldr-router`, `tldr-overview`, `tldr-deep` (no activation path).

### Research (5)

| Skill | Companion Agent |
|-------|-----------------|
| mcp-guidance | — |
| opencli | oracle |
| github-search | oracle |
| exa | oracle |
| braintrust-tracing (RETIRED 2026-09-30) | braintrust-analyst (RETIRED 2026-09-30) |

### Frontend / UI (6)

| Skill | Companion Agent |
|-------|-----------------|
| frontend-design | — |
| react-perf | react-perf-reviewer |
| browser-dev-cycle | sentinel (bidirectional, R4) |
| ui-audit | ui-compliance-reviewer |
| shadcnspace | — |

### Skill / Agent Development (8)

| Skill | Companion Agent |
|-------|-----------------|
| hook-scaffold | — |
| hook-audit | — |
| sync-drift | — |
| find-skills | — |
| project-registry | — |
| knowledge-tree | — |
| onboard | onboard |
| agent-development | agent-factory (Phase 5c new) |

### Project Management (3)

| Skill | Companion Agent |
|-------|-----------------|
| notion-bridge | — |
| roadmap | — |
| prd | — |

### Quality / Testing (3)

| Skill | Companion Agent |
|-------|-----------------|
| personas | — |
| qlty | — |
| health-check | — |

### Agentica (2)

| Skill | Companion Agent |
|-------|-----------------|
| agentica | — |
| agentica-sdk | agentica-agent |

### Meta / Reference (3)

| Skill | Companion Agent | Notes |
|-------|-----------------|-------|
| claude-code-guide | — | — |
| create-plan | plan-agent | Path bug fixed in Phase 5a deep-dive A1 |
| ralph | ralph workflow | Lifecycle playbook |

---

## Cross-Reference Index

### Agent → Companion Skill (load on invocation)

| Agent | Skill |
|-------|-------|
| agentica-agent | `agentica-sdk/SKILL.md` |
| braintrust-analyst (RETIRED 2026-09-30) | `braintrust-analyze/SKILL.md` (RETIRED) |
| debug-agent | `systematic-debugging/SKILL.md` |
| deployer | `vercel-cli`, `railway-cli`, `sentry-cli`, `neonctl` (conditional, R8) |
| maestro | `maestro/SKILL.md` |
| onboard | `onboard/SKILL.md` |
| plan-agent | `plan-agent/SKILL.md` (Phase 5a deep-dive A1 fixed broken `create_plan` path) |
| react-perf-reviewer | `react-perf/SKILL.md` |
| scribe | `create_handoff/SKILL.md`, `continuity_ledger/SKILL.md` |
| sentinel | `browser-dev-cycle/SKILL.md` (R4 bidirectional callout) |
| sleuth | `systematic-debugging/SKILL.md` |
| ui-compliance-reviewer | `ui-audit/SKILL.md` |

### Skill → Companion Agent (documented in skill body)

| Skill | Agent | Reason |
|-------|-------|--------|
| browser-dev-cycle | sentinel | R4 — bidirectional callout for full UAT |
| code-review | critic, review-agent | Guardrail loaded before invoking |
| neonctl | deployer | R8 — Neon ops conditional in deployer |
| react-perf | react-perf-reviewer | Hook auto-injects on `.tsx` read |
| refactor | judge (optional) | R2 — high-stakes architecture refactors |
| release | liaison (optional) | R2 — cross-service / external API releases |
| systematic-debugging | sleuth, debug-agent | R1 — sleuth for forensics, debug-agent as general fallback |
| ui-audit | ui-compliance-reviewer | Skill loaded by agent |

### Workflow → Agent Sequence (with checkpoints)

| Workflow | Sequence |
|----------|----------|
| build (greenfield) | discovery-interview → plan-agent → validate-agent → kraken/implement_plan → commit → describe_pr |
| build (brownfield) | onboard → oracle → plan-agent → validate-agent → kraken |
| build (tdd) | plan-agent → kraken (TDD) → arbiter |
| fix (bug) | sleuth (multi-file) OR debug-agent (general) → [user confirm] → kraken → arbiter → commit |
| fix (hook) | reproduce → sleuth → [user confirm] → kraken → re-run repro |
| fix (deps / pr-comments) | oracle / scout → plan-agent → [user confirm] → kraken → commit |
| refactor | phoenix → plan-agent → kraken → plan-reviewer → arbiter (+judge optional) |
| migrate | oracle → phoenix → plan-agent → kraken → surveyor |
| release | aegis → atlas → review-agent → herald → scribe → deployer (+liaison optional) |
| explore (deep) | onboard → scout |
| explore (architecture) | tldr-code (arch subcommand) |
| review | critic → plan-reviewer → review-agent (+principal-reviewer optional, high-stakes) |

---

## Hooks That Route Between Agents and Skills

| Hook | Event | Action |
|------|-------|--------|
| explore-to-scout | PreToolUse(Task) | HARD BLOCK on subagent_type=Explore — forces scout |
| task-router | UserPromptSubmit | RECOMMEND agent based on keyword detection |
| guardrail-enforcer | UserPromptSubmit | SOFT BLOCK 1x/session — requires systematic-debugging / databases / code-review skills |
| skill-activation-prompt | UserPromptSubmit | RECOMMEND skill via skill-rules.json + LLM validation |
| maestro-detector | UserPromptSubmit | SUGGEST /maestro for multi-step prompts (R7 — re-entrancy guard added 2026-04-26) |
| react-perf-context | PostToolUse(Read) | INJECT — auto-loads react-perf skill on .tsx read |
| agent-model-guard | PreToolUse(Task) | HARD BLOCK on unknown `subagent_type` (agent file existence check; renamed from `agent-validate.ts` in R5, 2026-04-26 — name is historical, behavior is existence validation, not model gating) |
| no-haiku-enforcer | PreToolUse(Task) | HARD BLOCK on `model: haiku` (this is the actual haiku gate) |
| agent-verification | PostToolUse(Task) | VERIFY agent output quality |
| plan-exit-tracker | PostToolUse(ExitPlanMode) | WRITE state file on plan approval |
| plan-to-ralph-enforcer | PreToolUse(Edit/Write) | HARD BLOCK code edits when plan approved + Ralph not active |

### Routing Coverage Gaps

Agents reachable only by explicit name (no UserPromptSubmit hook routing):
- principal-reviewer (Phase 5c new — suggested addition: review workflow high-stakes path)
- wizard (Phase 5c new — entry is documentation-driven via BOOTSTRAP.md)
- agent-factory (Phase 5c new — invoked by user when scaffolding)
- validate-agent
- braintrust-analyst (RETIRED 2026-09-30, see archive/braintrust-2026-10/)
- memory-extractor
- pathfinder
- liaison (optional companion in release skill body only)
- judge (optional companion in refactor skill body only)

---

## Phase 5c Changes Reflected

This map was regenerated as Step 10 of Phase 5c. Changes since the Phase 5a map:

1. **Agents +3, deprecated 1**:
   - Added: `wizard.md`, `agent-factory.md`, `principal-reviewer.md` (R6, Option B — created rather than deleted)
   - Deprecated: `session-analyst.md` (canonical archived to `_archived/2026-04-26-duplicates/`; stub remains at root pending follow-up)
2. **Hook rename (R5)**: `agent-validate.ts` → `agent-model-guard.ts` (8 cross-refs updated, dist rebuilt, settings.json updated)
3. **R1 codified**: `sleuth` and `debug-agent` descriptions now point at each other for the inverse case; `fix/SKILL.md` has Investigator selection subsection
4. **R2 (judge/liaison discoverability)**: optional-companion callouts added to `refactor/SKILL.md` and `release/SKILL.md`
5. **R4 (sentinel ↔ browser-dev-cycle)**: bidirectional companion callouts confirmed
6. **R7 (maestro re-entrancy)**: `isMaestroActive()` guard added with 30-min mtime check; fail-open on read errors
7. **R8 (deployer ↔ neonctl)**: deployer.md has conditional Neon section + neonctl-safety reference
8. **R9 closed**: 4 memory sub-skills are distinct slash commands (recall-reasoning uses different backend)
9. **TLDR cleanup (Phase 5a addendum)**: `tldr-router`, `tldr-overview`, `tldr-deep` archived; `tldr-code` canonical; `tldr-stats` wired with `python3` → `python` fix

---

## Open Items

1. **session-analyst stub** still at `.claude/agents/session-analyst.md` despite canonical move to archive — delete or convert to one-line redirect.
2. **principal-reviewer hook routing**: not surfaced by any UserPromptSubmit hook; consider adding as conditional review-workflow step for high-stakes changes.
3. **Phase 4.2** (skill embed-router fallback) deferred — scheduled remote agent fires 2026-05-10 to revisit BGE-vs-TF-IDF decision.
4. **perplexity-search / firecrawl-scrape** — removed from oracle and primary pathways, but skill directories still exist; archive candidate.
5. **plan-agent path bug** — fixed at A1 to point at `plan-agent/SKILL.md` (was broken `create_plan/SKILL.md`).
6. **Documentation drift watch**: `help/SKILL.md` and `wiring/SKILL.md` still reference deleted hooks per Phase 1 gap log; out of scope for Phase 5c but tracked.

---

*Source: regenerated from `.claude/agents/` and `.claude/skills/` enumeration plus Phase 5b composition-design and Phase 5c execution commits. Last refresh: 2026-04-27 (Phase 5c step 10).*
