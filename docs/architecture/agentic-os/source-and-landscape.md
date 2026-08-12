# Source and Landscape Research

## Primary source

The source video is Chase AI's [The Agentic OS Setup That Will 10x Claude Code](https://www.youtube.com/watch?v=HRw-vP0j8OM), published 2026-06-25 (31:20). Findings use YouTube metadata and English automatic captions; concepts are high confidence, exact transcript wording is medium confidence.

### Four levels in the video

| Level | Video proposal | Production interpretation |
|---|---|---|
| 1. Skills and loops | Audit recurring work, validate it manually, codify it as skills, automate it, and use prior results to improve later runs. | Versioned capability registry, deterministic workflow definitions, scheduler, evaluation, and promotion gates. |
| 2. Memory and state | Organize raw material, structured knowledge, outputs, indexes, and run history so Claude can navigate a second brain. | Git navigation plus Notion knowledge, PostgreSQL run/event state, pgvector memory, artifact storage, provenance, and retention. |
| 3. Experience | Put a web or Obsidian command center over metrics, artifacts, calendar directives, and one-click skills. | Authenticated dashboard and optional voice client over a runner API, never direct shell execution. |
| 4. Distribution | Package the interface for teammates and clients so nontechnical users can press buttons or speak commands. | Tenancy, RBAC, scoped connector grants, deployment automation, audit, support, and rollback. |

Relevant chapter links: [Level 1](https://www.youtube.com/watch?v=HRw-vP0j8OM&t=266s), [Level 2](https://www.youtube.com/watch?v=HRw-vP0j8OM&t=809s), [Level 3](https://www.youtube.com/watch?v=HRw-vP0j8OM&t=1404s), and [Level 4](https://www.youtube.com/watch?v=HRw-vP0j8OM&t=1703s).

At the user's [23:16 timestamp](https://www.youtube.com/watch?v=HRw-vP0j8OM&t=1396s), persistent run records become the basis for a second brain and efficient insight extraction. That is the boundary between durable operational state and the visual layer.

### What the source gets right

- Most value comes from repeatable workflows and useful state, not visual polish.
- Workflow discovery should use manual inventory, prior-session mining, and structured interviews.
- Hierarchical indexes reduce navigation cost and ambiguity.
- Every automation should produce a durable result that future evaluation can inspect.
- Nontechnical users need safe, opinionated entry points rather than a terminal tutorial.

### What must be added for production

- Identity, tenant isolation, RBAC, tool grants, secret references, and approval gates
- Durable queues, leases, checkpointing, retries, timeouts, cancellation, and idempotency
- Prompt-injection and data-exfiltration defenses for inbox, calendar, browser, filesystem, and shell tools
- Immutable audit events and trace correlation from UI action through model/tool/memory/artifact
- Evaluation criteria, version promotion, rollback, and feedback-poisoning controls
- Backup, restore, migrations, capacity, support, and deployment lifecycle

Anthropic's current billing clarification says Agent SDK and `claude -p` still draw from subscription usage for now, after a planned change was paused. Treat that as a changeable local-development convenience, not the shared product's cost contract: [official clarification](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). Authentication mode also affects charging; an `ANTHROPIC_API_KEY` takes precedence over subscription login: [official authentication guidance](https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code).

## Comparable systems

| System | Useful pattern | Gap relative to this project | Adopt posture |
|---|---|---|---|
| [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview) | Claude-native tools, sessions, subagents, permissions, hooks, and MCP. | Not a portfolio/project-management system or full operator control plane. | Adopt as primary runner boundary. |
| [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) | Durable state graphs, interrupts, human-in-loop, streaming, long-running state. | Adds a second orchestration model beside Ralph/Maestro. | Borrow contracts; spike only if current workflows cannot meet recovery needs. |
| [Microsoft Agent Framework Durable Extension](https://learn.microsoft.com/en-us/agent-framework/integrations/durable-extension) | Checkpointed agents/workflows, typed routing, fan-out/in, external events, long waits, distributed workers. | Azure/Durable Task gravity and another runtime language surface. | Reference design for durability and recovery. |
| [Google ADK](https://adk.dev/) | Sessions/state/memory, graph/collaborative workflows, evaluation, UI tooling, container/cloud deployment. | Replaces rather than exposes much of the existing system. | Compare during Phase 0; do not migrate v1. |
| [CrewAI](https://docs.crewai.com/en/concepts/flows) | Role-based crews plus event-driven flows and persistent state. | Overlaps the existing 43-agent taxonomy and workflows. | Borrow typed flow concepts; no v1 dependency. |
| [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) | Small agent/handoff/guardrail surface with built-in tracing. | Different primary model/runtime and no Notion operating model. | Reference trace model and portability adapter. |
| [Mastra](https://mastra.ai/) | TypeScript agents, workflows, memory, evals, observability, MCP, server deployment. | Framework adoption could duplicate the current runtime. | Best framework spike if a TS orchestration layer is later required. |
| [Dify](https://docs.dify.ai/en/guides/application-orchestrate/creating-an-application) | Visual workflows, plugins, distribution, self-hosting. | Visual-first abstraction conflicts with code-first governance and existing skills. | UX inspiration; not the kernel. |
| [ANOLISA](https://agentic-os.sh/) | Sandbox isolation, kernel-level observability, token optimization, recoverable workspaces. | OS/runtime focus, not Notion-centered business operations. | Study sandbox and observability patterns. |

## Build-versus-adopt conclusion

Do not replace Continuous Claude with a general agent framework. Its distinctive value already exists in the skill/hook/workflow/memory ecosystem. Build the missing control-plane contracts and operator experience, using Claude Agent SDK as the execution adapter and existing Ralph/Maestro as the first workflow implementations. Add a framework only after a measured spike proves it removes more complexity than it introduces.

## Research claims that constrain design

- Notion's API averages three requests per second per connection and also has a workspace-wide limit, so it cannot be the high-frequency event log: [Notion request limits](https://developers.notion.com/reference/request-limits).
- Notion webhooks can drive near-real-time projections without polling: [Notion webhooks](https://developers.notion.com/reference/webhooks).
- Claude Code hooks provide deterministic lifecycle enforcement and support command, HTTP, MCP, prompt, and agent handlers: [Claude Code hooks](https://code.claude.com/docs/en/hooks-guide).
- OpenAI Agents SDK traces model generations, tools, handoffs, guardrails, and custom events; this is a useful minimum trace envelope even when Claude remains the primary runtime: [tracing reference](https://openai.github.io/openai-agents-python/tracing/).

