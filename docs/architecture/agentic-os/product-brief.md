# Product Brief

## Product statement

Agentic OS is the governed workspace through which a person or team discovers repeatable work, turns it into versioned capabilities, runs those capabilities safely, observes progress and cost, approves sensitive actions, captures artifacts and learnings, and improves future runs.

## Primary users

| Persona | Need | v1 experience |
|---|---|---|
| Operator/owner | Create and supervise valuable automated work without losing control. | Dashboard, run launch, approvals, run timeline, artifacts, cost, failure recovery. |
| Builder | Add agents, skills, tools, and workflows with reviewable contracts. | Git-first definitions, local runner, test fixtures, evaluation gates, deployment pipeline. |
| Contributor | Use approved workflows without learning Claude Code. | Curated action cards, forms, scoped data access, result pages, notifications. |
| Auditor/admin | Explain what ran, why, with which access, and what changed. | Immutable event history, policy decisions, connector grants, version lineage, export. |

## Core jobs to be done

1. Discover repeated work from sessions, interviews, and Notion tasks.
2. Turn a validated manual process into a versioned skill/workflow.
3. Schedule or trigger it with typed inputs and a known permission envelope.
4. Execute in an isolated workspace with checkpointing and explicit side-effect gates.
5. Observe live state, tool use, cost, latency, artifacts, and approvals.
6. Synchronize human-relevant state to Notion without making Notion a runtime queue.
7. Evaluate outcomes against a fixture or rubric and propose a new version.
8. Promote or roll back versions with a human-readable change record.

## v1 capability set

- Workspace and user identity with Admin, Builder, Operator, and Viewer roles
- Registry for agents, skills, workflows, tools/connectors, and versions
- Run launch from UI and API with idempotency and typed inputs
- Durable task queue, leases, heartbeats, retries, cancellation, and recovery
- Claude Agent SDK runner plus local `claude -p` development adapter
- Per-run worktree/sandbox and least-privilege tool grants
- Human approvals for external writes, deploys, destructive operations, and privilege elevation
- Live run timeline, logs, artifacts, costs, and evaluation results
- Notion Projects/Tasks/Bridge projections and inbound triggers
- Braintrust plus OpenTelemetry-compatible tracing
- Version proposal, evaluation, approval, promotion, and rollback workflow

## Three reference workflows for the vertical slice

1. **Research brief:** Notion task → research workflow → cited artifact → approval → Notion result/update.
2. **Repository change:** approved task → isolated worktree → Ralph implementation → tests/review → artifact/PR-ready result. No automatic merge in v1.
3. **Operational digest:** scheduled trigger → read approved sources → summarize/evaluate → publish a Notion child page and tracker entry idempotently.

## Success measures

- At least 80% of reference runs finish without manual terminal intervention.
- Duplicate launch requests produce one run and one set of side effects.
- A worker restart resumes from the last committed checkpoint without repeating completed side effects.
- Every external write is attributable to user, workflow version, run, policy decision, and tool grant.
- An operator can answer “what is running, blocked, failed, costly, or awaiting me?” from one screen.
- A failed Notion sync does not fail the run; it is visible and retryable from an outbox.
- No skill version is promoted solely on self-evaluation.

## Product boundaries

Notion is the human system of record, Git is the executable system of record, and PostgreSQL is the runtime system of record. The dashboard is a projection and command client. Braintrust is the evaluation/trace destination, not the durable run authority.

