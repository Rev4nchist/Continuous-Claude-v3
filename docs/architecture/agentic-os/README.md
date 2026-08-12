# Agentic OS Handoff Package

**Status:** Phase-0-ready design and decision package  
**Branch:** `agentic-os`  
**Prepared:** 2026-07-18  
**Primary build environment:** Claude Code in this repository

## Outcome

Build a governed control plane over the capabilities that Continuous Claude already has: agents, skills, hooks, Ralph/Maestro workflows, PostgreSQL memory, Notion project management, and Braintrust evaluation. The first release is not a new operating-system kernel and is not a dashboard that shells directly into `claude -p`. It is a durable, authenticated run service with a useful operator interface.

## Read this package in order

1. [Source and landscape research](source-and-landscape.md)
2. [Detailed GitHub landscape](github-landscape.md)
3. [Product brief](product-brief.md)
4. [Target architecture](target-architecture.md)
5. [Runtime contracts](contracts.md)
6. [Notion operating model](notion-operating-model.md)
7. [Build plan](build-plan.md)
8. [Security and observability](security-observability.md)
9. [Deployment runbook](deployment-runbook.md)
10. [Acceptance plan](acceptance-plan.md)
11. [Interactive HTML overview](overview.html)

## Decisions already made

- Brownfield extension, not a rewrite. Existing skills, agents, hooks, memory, workflows, project cards, and evaluators are reused behind typed adapters.
- Git owns executable definitions. Notion owns projects, tasks, curated decisions/knowledge, and the human-facing approval inbox. PostgreSQL owns operational approval state, transactional run state, immutable events, leases, evaluation records, and semantic memory. Notion and the dashboard submit idempotent approval commands and receive projections; no operational entity has two authoritative writers.
- Claude Agent SDK is the preferred production runner interface. `claude -p` remains a local adapter and must never be invoked directly by a browser request.
- Every run is a durable state machine with an idempotency key, immutable event history, versioned inputs, explicit approval states, cancellation, retry policy, and artifact lineage.
- UI and voice are clients of the same authenticated API. They do not contain orchestration logic.
- Self-improvement proposes a new version; it never silently changes an active skill or policy. Promotion requires evaluation and approval.
- Local development uses Docker Compose. The first shared deployment targets Railway for API/workers/PostgreSQL, with static web delivery on Vercel or Railway. The topology remains portable.

## Explicit non-goals for v1

- General-purpose autonomous company management
- Replacing Notion, Git, PostgreSQL, Braintrust, or Claude Code
- Arbitrary user-authored code execution
- A visual workflow builder
- Multi-region active-active execution
- Fully autonomous promotion of prompts, skills, agents, or policies
- Obsidian as a second system of record

## Assumptions to validate in Phase 0

- Initial users are Dave plus a small trusted team.
- The first three workflows can be drawn from existing Ralph, Maestro, and reporting/Notion jobs.
- Railway, the existing PostgreSQL/pgvector service, Notion MCP/API, and Braintrust remain approved services.
- Shared automation will use an explicit service billing mode; local subscription authentication is not assumed to be stable production infrastructure.
- Existing user-owned change `scripts/project-cards/state.json` is unrelated and must remain untouched.

## Definition of ready for implementation

Claude Code may start Phase 1 only after it has read all files in this directory, confirmed the current Notion schemas, run the repository preflight, created a task graph matching [build-plan.md](build-plan.md), and closed the Phase 0 gates. Those gates include explicit ADRs for durable runner/session storage, sandbox substrate, approval command semantics, side-effect adapter classes, identity/RLS, artifact storage, queueing, and deployment. Any architectural deviation must be recorded as an ADR before code changes.
