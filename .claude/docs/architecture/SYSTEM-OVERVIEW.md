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
                                 └─────────┘│ grok-    │
                          ┌────────┐        │adversary│
                          │  TEST  │        └────────┘
                          │arbiter │
                          │ atlas  │
                          └────────┘

Agent Selection Rule:
  Research → scout (internal) / oracle (external)
  Design   → architect / phoenix (refactor strategy)
  Implement → kraken (TDD) / spark (quick fix)
  Debug → debug-agent / sleuth
  Test  → arbiter / atlas (test execution)
  Review → critic / principal-reviewer / grok-adversary (cross-model)
  Deploy → deployer (Vercel / Railway / Sentry / Linear)
```

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
