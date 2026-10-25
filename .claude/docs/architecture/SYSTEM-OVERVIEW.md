# System Overview

## Data Flow

```
User Prompt
    │
    ▼
┌─────────────────────────────────────┐
│      UserPromptSubmit Hooks         │
│  heartbeat │ memory-awareness │ ...                          │
└─────────────────────────────────────┘
    │
    ▼
Claude Reasoning
    │
    ├──────────────────────────────────┐
    ▼                                  ▼
┌──────────────┐              ┌──────────────┐
│ PreToolUse   │              │ Direct       │
│ Hooks        │              │ Response     │
│ file-claims  │              └──────────────┘
│ task-router  │
└──────────────┘
    │
    ▼
Tool Execution (Read/Edit/Task/Bash)
    │
    ▼
┌──────────────┐
│ PostToolUse  │
│ Hooks        │
│ epistemic    │
└──────────────┘
    │
    ▼
Memory Storage (if learning detected)
```

## Memory Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     MEMORY LAYER                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  recall_learnings.py ──┬──→ PostgreSQL + pgvector           │
│  store_learning.py ────┘      └─ archival_memory table      │
│                               └─ BGE-large embeddings       │
│                                  (1024 dimensions)          │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Search Modes:
  • Hybrid RRF (default) - Best accuracy, combines text + vector
  • Hybrid + PageIndex   - Best for docs (--hybrid flag)
  • PageIndex-only       - Large structured docs (--pageindex flag)
  • Vector-only          - Pure semantic similarity
  • Text-only            - Fast keyword matching

PageIndex Layer:
  • pageindex_cli.py ───→ Tree-based doc search
  • tree_search.py ─────→ LLM reasoning over outlines
  • 98.7% accuracy vs ~50% vector similarity
```

## Hook Lifecycle

```
┌──────────────────────────────────────────────────────────────┐
│                    HOOK TRIGGERS                             │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  SessionStart ─────→ session-start-docker                    │
│                      session-start-parallel                  │
│                      hook-health-monitor                     │
│                                                              │
│  UserPromptSubmit ─→ heartbeat                               │
│                      memory-awareness                        │
│                      skill-activation-prompt                 │
│                                                              │
│  PreToolUse ───────→ file-claims (can BLOCK)                 │
│                      git-memory-check (can BLOCK)            │
│                      package-install-guard:Bash (can BLOCK)  │
│                      task-router                             │
│                      explore-to-scout                        │
│                                                              │
│  PostToolUse ──────→ epistemic-reminder                      │
│                      roadmap-completion                      │
│                      pageindex-watch                         │
│                      smarter-everyday                        │
│                      git-commit-roadmap                      │
│                      telemetry-tracker:Skill|Task            │
│                      plan-exit-premortem-prompt:ExitPlanMode │
│                      pr-opened-review-loop:Bash|PowerShell   │
│                                                              │
└──────────────────────────────────────────────────────────────┘

The Braintrust emit sites are RETIRED 2026-09-30 (see
`archive/braintrust-2026-10/`).
```

## Braintrust Observability (RETIRED 2026-09-30)

RETIRED 2026-09-30 (see `archive/braintrust-2026-10/`). Tracing is off. The
hooks are deregistered, the code is archived, and the API key is revoked.
History only: [Braintrust Subsystem](subsystems/braintrust.md).

## Agent Orchestration

```
┌─────────────────────────────────────────────────────────────┐
│                    TASK TOOL                                │
│         subagent_type: "<agent-name>"                       │
└─────────────────────────────────────────────────────────────┘
                          │
   ┌──────────┬───────────┼───────────┬──────────┬──────────┐
   ▼          ▼           ▼           ▼          ▼          ▼
┌────────┐┌────────┐ ┌─────────┐ ┌─────────┐┌────────┐┌────────┐
│RESEARCH││ DESIGN │ │IMPLEMENT│ │  DEBUG  ││ REVIEW ││ DEPLOY │
│ scout  ││architect│ │ kraken  │ │debug-   ││ critic ││deployer│
│ oracle ││ phoenix │ │ spark   │ │ agent   ││principal│└────────┘
└────────┘└────────┘ └─────────┘ │ sleuth  ││-reviewer│
                                 └─────────┘│ review- │
                          ┌────────┐        │ agent   │
                          │  TEST  │        └─────────┘
                          │arbiter │
                          │ atlas  │
                          └────────┘

Agent Selection Rule:
  Research → scout (internal) / oracle (external)
  Design   → architect / phoenix (refactor strategy)
  Implement → kraken (TDD) / spark (quick fix)
  Debug → debug-agent / sleuth
  Test  → arbiter / atlas (test execution)
  Review → critic / principal-reviewer / review-agent (in-session, Claude family;
           opt-in self-check via /review, never grants READY)
  Deploy → deployer (Vercel / Railway / Sentry / Linear)
```

`grok-adversary` is not a reviewer in this map. It is the optional cross-model
(Grok CLI) pass inside `/premortem`, for plan risk. `/review` no longer spawns a
cross-model reviewer.

## Code Review (as of `main`; target per Wiring Plan 2026-10-25)

| Layer | Live today | Approved target (not built) |
|-------|------------|-----------------------------|
| In-session | `/review` (critic, plan-reviewer, review-agent): opt-in self-check, never counts toward READY | Same (D4) |
| Independent review | Cross-family xreview Cursor CA, launched by hand **outside CCv3** | Auto-trigger on draft PR (PR6) |
| PR bot | Greptile, on open + every push; `pr-opened-review-loop` hook → `pr_watch` → `review-status.mjs` | Label-routed at ready: CodeRabbit (normal), Greptile (high), both for `review:deep`, plus one final-head review (DW-91, DW-80) |
| Merge | Dave only (`/land`) | Same |

Phase 0 baseline (2026-10-25) observed gaps the live column does not close, and that target READY is meant to close once it is built: merge-before-bot (#147, #150, #151; CodeRabbit often ended "Review failed - The pull request is closed."); reviewed but unanswered (#152, head `37ed7905`, 7 threads with no replies); a green Greptile check with no review object (#149). Not gated live.

Sentry is runtime monitoring only (D1). CCv3 registers no Sentry hook and no Sentry MCP server; the two built Sentry hooks stay unregistered.
Details: `.claude/rules-ondemand/pr-review-loop.md`.

## Workflow Composition

```
/maestro Workflow:
  Analyze task → Spawn specialists → Coordinate → Synthesize
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
     scout         kraken        arbiter
   (research)   (implement)     (test)
```

## ROADMAP Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         ROADMAP.md                              │
│  ┌─────────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────────┐  │
│  │Current Focus│ │ Planned  │ │Completed │ │Recent Planning  │  │
│  └──────┬──────┘ └────┬─────┘ └────┬─────┘ └────────┬────────┘  │
└─────────┼─────────────┼────────────┼────────────────┼───────────┘
          │             │            │                │
          ▼             ▼            ▼                ▼
   post-plan-    prd-roadmap-  git-commit-    post-plan-
   roadmap       sync          roadmap        roadmap
```

**4 ROADMAP Hooks:**
| Hook | Trigger | Section |
|------|---------|---------|
| `post-plan-roadmap` | ExitPlanMode | Current Focus |
| `prd-roadmap-sync` | Write PRD files | Planned |
| `git-commit-roadmap` | git commit | Completed |
| `roadmap-completion` | TaskUpdate | Current → Completed |

**Manual Override:** `/roadmap show|add|focus|complete`

## File Locations

| Component | Location |
|-----------|----------|
| Hooks (source) | `~/.claude/hooks/src/` |
| Hooks (built) | `~/.claude/hooks/dist/` |
| Skills | `~/.claude/skills/` |
| Agents | `~/.claude/agents/` |
| Rules | `~/.claude/rules/` |
| Memory scripts | `~/continuous-claude/opc/scripts/core/` |
| Database | PostgreSQL `continuous_claude` |
