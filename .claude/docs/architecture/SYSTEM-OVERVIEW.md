# System Overview

## Data Flow

```
User Prompt
    │
    ▼
┌─────────────────────────────────────┐
│      UserPromptSubmit Hooks         │
│  heartbeat │ memory-awareness │ ... │
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
│                      hook-health-monitor [BT: hook_health]   │
│                                                              │
│  UserPromptSubmit ─→ heartbeat                               │
│                      memory-awareness [BT: memory_recall]    │
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
│                          [BT: tool_call_success,             │
│                               skill_trigger_accuracy]        │
│                      plan-exit-premortem-prompt:ExitPlanMode │
│                                                              │
└──────────────────────────────────────────────────────────────┘

[BT: …] marks a Braintrust deterministic emit site. See the
Braintrust Observability section below.
```

## Braintrust Observability

```
┌──────────────────────────────────────────────────────────────┐
│                  BRAINTRUST (two layers)                     │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  LAYER 1 — DETERMINISTIC (live, in hook path)                │
│    3 TS hooks → await emitBraintrustScore()                  │
│    helper: hooks/src/shared/braintrust-score.ts             │
│                                                              │
│    memory-awareness ───→ memory_recall_relevance / _hit      │
│    store_learning.py ──→ memory_store_quality  (Python)      │
│    telemetry-tracker ──→ tool_call_success                   │
│                          skill_trigger_accuracy              │
│    hook-health-monitor → hook_health_ratio                   │
│                                                              │
│    GUARD: scripts/audit-braintrust-emits.sh                  │
│           run after ANY TS hook edit; await-only grep        │
│                                                              │
│  LAYER 2 — LLM JUDGES (offline, sampled, scheduled)          │
│    opc/scripts/core/judge_session.py                        │
│      factuality + closedqa → claude -p --model sonnet        │
│      plan_rubric           → codex exec --sandbox read-only  │
│    NO API keys — subscription OAuth · 35% sampler · --force  │
│    cross-project recall via ~/.claude/project-registry.json  │
│    scheduled: Task Scheduler "CCv3-Judge-Batch" (06:15 local)│
│                                                              │
└──────────────────────────────────────────────────────────────┘
            │                                  │
            ▼                                  ▼
   /v1/project_logs/{project_id}/feedback   Braintrust UI
```

Full detail: [Braintrust Subsystem](subsystems/braintrust.md). Ops runbook:
`docs/braintrust-online-scoring-recipe.md`.

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
                                 └─────────┘│ codex- │
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
  Review → critic / principal-reviewer / codex-adversary (cross-model)
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
