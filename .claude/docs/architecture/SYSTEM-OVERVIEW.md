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
│  store_learning.py ────┤      └─ archival_memory table      │
│                        │      └─ BGE-large embeddings       │
│  memory_daemon.py ─────┘         (1024 dimensions)          │
│                                                             │
└─────────────────────────────────────────────────────────────┘

Search Modes:
  • Hybrid RRF (default) - Best accuracy, combines text + vector
  • Vector-only          - Pure semantic similarity
  • Text-only            - Fast keyword matching
```

## Hook Lifecycle

```
┌──────────────────────────────────────────────────────────────┐
│                    HOOK TRIGGERS                             │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  SessionStart ─────→ session-start-docker                    │
│                      session-start-parallel                  │
│                                                              │
│  UserPromptSubmit ─→ heartbeat                               │
│                      memory-awareness                        │
│                      skill-activation                        │
│                                                              │
│  PreToolUse ───────→ file-claims (can BLOCK)                 │
│                      task-router                             │
│                      explore-to-scout                        │
│                                                              │
│  PostToolUse ──────→ epistemic-reminder                      │
│                      roadmap-completion                      │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## Agent Orchestration

```
┌─────────────────────────────────────────────────────────────┐
│                    TASK TOOL                                │
│         subagent_type: "<agent-name>"                       │
└─────────────────────────────────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   ┌─────────┐       ┌─────────┐       ┌─────────┐
   │RESEARCH │       │IMPLEMENT│       │ REVIEW  │
   │ scout   │       │ kraken  │       │ critic  │
   │ oracle  │       │ spark   │       │ judge   │
   └─────────┘       └─────────┘       └─────────┘

Agent Selection Rule:
  Research → scout (internal) / oracle (external)
  Implement → kraken (TDD) / spark (quick fix)
  Debug → debug-agent / sleuth
  Review → critic / judge / liaison
```

## Workflow Composition

```
/ralph Workflow:
  brainstorm → validate → refine → prd → design → architecture
       │          │         │       │       │          │
       ▼          ▼         ▼       ▼       ▼          ▼
    MCP:       MCP:       Loop   Generate Create    Build
    idearalph  idearalph  until  PRD doc  design   plan
    brainstorm validate   9.5+           spec

/maestro Workflow:
  Analyze task → Spawn specialists → Coordinate → Synthesize
                      │
        ┌─────────────┼─────────────┐
        ▼             ▼             ▼
     scout         kraken        arbiter
   (research)   (implement)     (test)
```

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
