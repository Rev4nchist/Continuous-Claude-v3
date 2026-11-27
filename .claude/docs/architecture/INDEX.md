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

## System at a Glance

| Subsystem | Purpose | Entry Point |
|-----------|---------|-------------|
| Memory | Persistent learnings across sessions | `recall_learnings.py` |
| Hooks | Intercept & modify Claude behavior | `.claude/hooks/` |
| Agents | Specialized task delegation | Task tool |
| PageIndex | Document navigation & search | `pageindex_cli.py` |
| Workflows | Multi-step orchestration | Workflow tool |
| Braintrust | RETIRED 2026-09-30 (see `archive/braintrust-2026-10/`). Tracing is off. | none |
| RLM | Analyze inputs that overflow the context window — the large-context escape hatch (dormant; Docker-gated) | `/rlm-analyze`, `rlm_client.py` |
| Lane board | Which session holds which card; claims, notes, dependencies, the phone page | `scripts/coordination/lane.mjs`, `docs/coordination/standard.md` |
| Seat | The coordinator session: rules on builders, runs decision points with Dave, rechecks each land | `.claude/rules-ondemand/seat-role.md` |
| pre-pr | The proof run before a PR opens: gates, the CodeRabbit CLI review, a stamp | `scripts/github/pre-pr.mjs` |
| Review engine | The program that replaces paid PR review with an eval-gated engine | `docs/review-engine/README.md` |
| Agentic OS app | The Fleet Browser: sessions, lanes and PRs on one screen | `apps/agentic-os`, `docs/architecture/agentic-os/README.md` |

The idea-to-product path, stage by stage with the tool and owner of each stage: [Idea to product path](../../../docs/architecture/agentic-os/notion-operating-model.md#idea-to-product-path).

## Six Pillars (Braintrust pillar RETIRED 2026-09-30)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CLAUDE SESSION                                     │
│     User Prompt → Hooks → Tools/Agents → Output → Hooks                      │
└─────────────────────────────────────────────────────────────────────────────┘
        │           │           │           │           │           │
        ▼           ▼           ▼           ▼           ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│  MEMORY  │ │  HOOKS   │ │  AGENTS  │ │ PAGEINDEX│ │ WORKFLOWS│ │ RETIRED  │
│PostgreSQL│ │TS source │ │ Task tool│ │Doc search│ │Workflow  │ │ archive/ │
│+pgvector │ │ → dist   │ │ delegate │ │LLM reason│ │          │ │braintrust│
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
- [Workflows](subsystems/workflows.md) - Workflow tool, compound workflows
- [Braintrust Observability](subsystems/braintrust.md) - RETIRED 2026-09-30. History only. Code is in `archive/braintrust-2026-10/`.

**Phase 5 design docs (../):**
- [Agent x Skill Map](../agent-skill-map.md) - Cross-reference of agents and skills with routing coverage gaps
- [Composition Design](../composition-design.md) - "Skills own behavior, agents own isolation" + decision tree (§2) + R1-R10 status
- [Tool-Tier Policy](../tool-tier-policy.md) - Hooks vs MCPs vs skills decision rules
- [Hook Audit (2026-04)](../hook-audit-2026-04.md) - Phase 2/3/5c audit decisions and open follow-ups

**Comprehensive Documentation (continuous-claude/docs/):**
- [ARCHITECTURE.md](file:///~/continuous-claude/docs/ARCHITECTURE.md) - Full system architecture with TLDR analysis
- [memory-architecture.md](file:///~/continuous-claude/docs/memory-architecture.md) - Complete memory system with Mermaid diagrams
- [hooks/README.md](file:///~/continuous-claude/docs/hooks/README.md) - Full hook reference (718 lines)
- [agents/README.md](file:///~/continuous-claude/docs/agents/README.md) - Agent selection guide (750 lines)

**User Guides (in this dir):**
- [user-guide.md](user-guide.md) - User guide with essential commands and auto-started capabilities
- [cheatsheet.md](cheatsheet.md) - Windows cheat sheet (PowerShell command reference)
