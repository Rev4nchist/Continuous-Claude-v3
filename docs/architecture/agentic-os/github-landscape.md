# GitHub Landscape

**Research cutoff:** 2026-07-18 CT. Stars and last-push dates were checked through each repository's GitHub API endpoint; architecture and licensing came from the linked primary repository documentation. Counts are a point-in-time discovery signal, not a quality score or adoption decision. Phase 0 must pin the evaluated commit/release, license text, and relevant issue links in the spike scorecard before any framework is selected.

| Repository | Stars / recent activity | Relevant architecture | License / deployment | Fit and risk |
|---|---:|---|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | 383.4k / pushed Jul 19 | TypeScript gateway, isolated workspaces/sessions, skills, cron, messaging, Markdown memory | MIT; daemon, clients, Docker/VPS | Strong personal OS gateway/channel pattern; broad plugin capability surface requires a dedicated trust review. |
| [n8n-io/n8n](https://github.com/n8n-io/n8n) | 197.0k / Jul 18 | Visual workflows, triggers, waits, subflows, AI/MCP nodes, queue workers | Sustainable Use License; cloud/self-host | Good [Notion integration](https://docs.n8n.io/integrations/builtin/app-nodes/n8n-nodes-base.notion/) edge. Licensing and agent-state model make it a poor kernel. |
| [langgenius/dify](https://github.com/langgenius/dify) | 149.3k / Jul 18 | Visual workflows/chatflows, agents, RAG, plugins, APIs, monitoring | Modified Apache 2.0; cloud/Compose | Useful publishing and knowledge UX. Large footprint and multi-tenancy/branding restrictions. |
| [mem0ai/mem0](https://github.com/mem0ai/mem0) | 61.1k / Jul 18 | Memory extraction/retrieval over vector and graph stores | Apache-2.0; libraries or server | Clean memory-service boundary. It does not solve orchestration, provenance, retention, or promotion policy. |
| [microsoft/autogen](https://github.com/microsoft/autogen) | 59.8k / Apr 15 | Actor-style runtime, typed messages, pub/sub, distributed host/workers | MIT code; CC-BY docs | Good identity/message/subscription model; compatibility and migration cost require a pinned-version spike. |
| [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI) | 55.7k / Jul 18 | Role crews plus Flows, state, branches, persistence, checkpoints, MCP | MIT; library or commercial AMP | Accessible team/critic patterns; durability and distribution must pass the common recovery fixtures. |
| [agno-agi/agno](https://github.com/agno-agi/agno) | 41.3k / Jul 19 | Agent SDK, FastAPI AgentOS, browser control plane, sessions, RBAC, memory, traces | Apache-2.0; own cloud/container | Closest integrated Agent OS prototype; the authorization boundary requires independent verification. |
| [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | 37.6k / Jul 19 | Stateful graphs, step checkpoints, thread state, store, interrupts, replay/time travel | MIT; library or Agent Server | Strongest code-first checkpoint model; [persistence](https://docs.langchain.com/oss/python/langgraph/persistence) separates thread checkpoints from cross-thread memory. Ecosystem coupling risk. |
| [conductor-oss/conductor](https://github.com/conductor-oss/conductor) | 32.0k / Jul 19 | Durable state machine, task queues, polling workers, immutable workflow versions, retry/HITL | Apache-2.0; JVM/Docker/Kubernetes | Strongest durability substrate. Operationally heavier and at-least-once delivery still requires idempotent workers. |
| [mastra-ai/mastra](https://github.com/mastra-ai/mastra) | 26.3k / Jul 19 | TypeScript agents, workflows, memory, evals, observability, resumable snapshots | Apache-2.0 core; Node/server/cloud | Strong TS MVP spike candidate; suspend/resume behavior must pass the common recovery fixtures. |
| [letta-ai/letta](https://github.com/letta-ai/letta) | 23.9k / Jul 3 | Persistent agent server, editable memory blocks, messages/reasoning/tools, archival memory | Apache-2.0; Docker/Postgres/cloud | Strong memory semantics. It is memory-first rather than a durable business-workflow engine. |
| [elizaOS/eliza](https://github.com/elizaOS/eliza) | 18.8k / Jul 19 | TypeScript plugins: agents, actions, providers, evaluators, services, database adapters | MIT; Bun/Node/Docker | Useful capability/plugin contract. Social-agent focus and broad plugin trust surface. |
| [CoWork-OS/CoWork-OS](https://github.com/CoWork-OS/CoWork-OS) | 389 / Jul 18 | Local desktop workbench, task runtime, approvals, multi-agent modes, SQLite/FTS memory, Notion | MIT; Electron/local Docker | Excellent UX reference for timelines, approvals, evidence, and artifacts. New and lightly proven. |
| [iii-experimental/agentos](https://github.com/iii-experimental/agentos) | 158 / May 7 | Engine bus using Worker/Function/Trigger, realms, missions, budgets, reflection memory | Apache-2.0; local and distributed | Interesting function bus and budget ledger. Very new with limited independent validation. |
| [OpenCognit/Opencognit](https://github.com/OpenCognit/Opencognit) | 31 / Jun 29 | CEO/task DAG/critic, per-agent memory, budget enforcement, Kanban UI | AGPL-3.0 community v0.9 | Pattern reference only; license and maintenance posture require explicit verification before reuse. |

The video's companion framing also emphasizes domains → skills → automations, persistent memory, and an accessible dashboard rather than one monolithic framework: [Chase AI framework article](https://www.chaseai.io/blog/claude-code-agentic-os-framework).

## Shortlist

1. **Thin custom control plane over current Continuous Claude:** preferred baseline because it preserves differentiated assets and minimizes framework duplication.
2. **Mastra spike:** preferred alternative for a TypeScript-first MVP if its suspend/resume, storage, policy, and versioning behavior pass a measured fixture suite.
3. **Conductor spike:** preferred durability substrate when long-running distributed workflows, compensation, replay, and durable approvals exceed the thin queue/state-machine implementation.
4. **Agno spike:** fastest integrated prototype if Python/FastAPI is acceptable and its RBAC boundary passes independent security tests.
5. **Mem0/Letta patterns:** evaluate only after memory retrieval tests demonstrate a gap in existing PostgreSQL/pgvector services.
6. **n8n:** optional Notion/event integration edge; never authoritative runtime state.

## Required spike scorecard

Any framework proposal must run the same fixtures and report:

- Recovery after worker death at every side-effect boundary
- Duplicate-delivery and idempotency behavior
- Human approval that survives a multi-day pause
- Definition/version pinning and rollback
- Workspace isolation and least-privilege tools
- PostgreSQL and Notion ownership compatibility
- Trace/redaction/export support
- Local Windows developer experience and Railway/container deployment
- Dependency, license, operational, and migration cost

## Recommendation

Adopt execution, memory, and connector primitives only where measured value is clear; build the domain control plane. The project-specific layer must own `Goal → Project → Task → Run → Step → Evidence/Artifact → Approval`, Notion projection/idempotency, Claude worker policy/sandboxing, budgets, audit, evaluation, and definition promotion.
