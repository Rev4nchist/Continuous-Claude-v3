# Continuous Claude Architecture

## Quick Start

| Task Type | Go To |
|-----------|-------|
| Understand codebase | [Decision Trees → Research](DECISION-TREES.md#research) |
| Implement feature | [Decision Trees → Implementation](DECISION-TREES.md#implementation) |
| Debug/Fix issue | [Decision Trees → Debugging](DECISION-TREES.md#debugging) |
| Store/recall memory | [Memory Subsystem](subsystems/memory.md) |
| Manage goals | [ROADMAP Subsystem](subsystems/roadmap.md) |
| Use agents | [Agent Picker](quick-ref/agent-picker.md) |
| Find a hook | [Hook Catalog](quick-ref/hook-catalog.md) |
| Score/observe the system | [Braintrust Subsystem](subsystems/braintrust.md) |

## System at a Glance

| Subsystem | Purpose | Entry Point |
|-----------|---------|-------------|
| Memory | Persistent learnings across sessions | `recall_learnings.py` |
| Hooks | Intercept & modify Claude behavior | `.claude/hooks/` |
| Agents | Specialized task delegation | Task tool |
| PageIndex | Document navigation & search | `pageindex_cli.py` |
| Workflows | Multi-step orchestration | `/maestro` |
| Braintrust | Observability — score system performance | `emitBraintrustScore()`, `judge_session.py` |
| RLM | Analyze inputs that overflow the context window — the large-context escape hatch (dormant; Docker-gated) | `/rlm-analyze`, `rlm_client.py` |

## Six Pillars

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLAUDE SESSION                                     │
│     User Prompt → Hooks → Tools/Agents → Output → Hooks                      │
└─────────────────────────────────────────────────────────────────────────────┘
        │           │           │           │           │           │
        ▼           ▼           ▼           ▼           ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│  MEMORY  │ │  HOOKS   │ │  AGENTS  │ │ PAGEINDEX│ │ WORKFLOWS│ │BRAINTRUST│
│PostgreSQL│ │TS source │ │ Task tool│ │Doc search│ │Maestro   │ │7 scores +│
│+pgvector │ │ → dist   │ │ delegate │ │LLM reason│ │          │ │3 judges  │
└──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
```

For current inventory: see [agent-skill-map.md](../agent-skill-map.md), [hook-catalog.md](quick-ref/hook-catalog.md), [hook-audit-2026-04.md](../hook-audit-2026-04.md).

## Cross-References

- **All hooks:** [Hook Catalog](quick-ref/hook-catalog.md)
- **All agents:** [Agent Picker](quick-ref/agent-picker.md)
- **All commands:** [Command Reference](quick-ref/command-ref.md)
- **System diagrams:** [System Overview](SYSTEM-OVERVIEW.md)

## Deep Dives

**Quick Reference (local):**
- [Memory System](subsystems/memory.md) - PostgreSQL, pgvector, embeddings
- [PageIndex System](subsystems/pageindex.md) - Tree-based doc search, LLM reasoning
- [ROADMAP System](subsystems/roadmap.md) - Goal tracking, 4 hooks, /roadmap skill
- [Hook System](subsystems/hooks.md) - Lifecycle, blocking, patterns
- [Agent Orchestration](subsystems/agents.md) - When to use which agent
- [Workflows](subsystems/workflows.md) - Maestro, compound workflows
- [Braintrust Observability](subsystems/braintrust.md) - 7 deterministic scores + 3 LLM judges, audit invariant, judge runner

**Phase 5 design docs (../):**
- [Agent x Skill Map](../agent-skill-map.md) - Cross-reference of agents and skills with routing coverage gaps
- [Composition Design](../composition-design.md) - "Skills own behavior, agents own isolation" + decision tree (§2) + R1-R10 status
- [Tool-Tier Policy](../tool-tier-policy.md) - Hooks vs MCPs vs skills decision rules
- [Hook Audit (2026-04)](../hook-audit-2026-04.md) - Phase 2/3/5c audit decisions and open follow-ups

**Comprehensive Documentation (continuous-claude/docs/):**
- [ARCHITECTURE.md](file:///C:/Users/david.hayes/continuous-claude/docs/ARCHITECTURE.md) - Full system architecture with TLDR analysis
- [memory-architecture.md](file:///C:/Users/david.hayes/continuous-claude/docs/memory-architecture.md) - Complete memory system with Mermaid diagrams
- [hooks/README.md](file:///C:/Users/david.hayes/continuous-claude/docs/hooks/README.md) - Full hook reference (718 lines)
- [agents/README.md](file:///C:/Users/david.hayes/continuous-claude/docs/agents/README.md) - Agent selection guide (750 lines)

**User Guides (in this dir):**
- [user-guide.md](user-guide.md) - User guide with essential commands and auto-started capabilities
- [cheatsheet.md](cheatsheet.md) - Windows cheat sheet (PowerShell command reference)
