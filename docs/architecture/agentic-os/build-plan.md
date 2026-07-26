# Build Plan

## Delivery strategy

Use a vertical-slice sequence. Each phase must leave a working, testable system and a rollback point. Claude Code should use TDD for runtime behavior, migrations, policies, and adapters. Documentation-only changes do not require a delegated implementation workflow; production code follows the repository's Ralph enforcement.

## Phase 0: validate and inventory

**Goal:** choose the first three workflows and freeze v1 architecture.

- Run the workflow audit using prior sessions, Notion tasks, and an operator interview.
- Select the research brief, repository change, and operational digest fixtures or document replacements.
- Confirm service billing/authentication for local and shared Claude execution.
- Inventory tools with read/write risk, auth mode, tenant scope, rate limits, and approval requirements.
- Resolve canonical source-tree and schema-bootstrap drift before adding new generated projections.
- Produce ADRs for runtime adapter and durable `SessionStore`, artifact storage, identity provider/RLS, queue approach, production sandbox substrate, approval command state machine, side-effect adapter classes, and deployment target.

**Gate:** approved v1 scope, threat model, data-classification matrix, test fixtures, sandbox deployment proof, Notion recovery objective, and the complete ADR set above.

## Phase 1: contracts and persistence

**Goal:** durable records without model execution.

- Create shared TypeScript schemas for manifests, runs, tasks, events, approvals, grants, artifacts, evaluations, and outbox.
- Add canonical versioned migrations.
- Put `workspace_id` on every tenant-sensitive record; add foreign keys, workspace-scoped uniqueness, and RLS isolation tests.
- Implement repository registry discovery and content hashing.
- Implement run/task state machines and invalid-transition tests.
- Implement idempotent `POST /v1/runs`, event append, outbox transaction, and read APIs.
- Add local identity stub plus production identity interface.

**Gate:** contract tests, migration up/down in an isolated database, concurrency tests, and API schema snapshot pass.

## Phase 2: runner and worker

**Goal:** one workflow survives restarts and cancellation.

- Implement worker claim, lease, heartbeat, checkpoint, retry, timeout, cancellation, and dead-letter behavior.
- Implement Claude Agent SDK runner adapter, durable encrypted session/checkpoint storage, and a local `claude -p` adapter.
- Implement the selected per-run sandbox substrate; worktrees provide source isolation but are not the process, filesystem, resource, or network security boundary.
- Implement tool broker, grant resolution, operation idempotency, receipts, reconciliation, compensation, and ambiguous-operation quarantine by adapter effect class.
- Stream normalized runner events to the event log.
- Run a no-side-effect fixture through failure/restart/recovery tests.

**Gate:** kill worker mid-step, restart, and prove no completed side effect repeats.

## Phase 3: Notion and reference workflows

**Goal:** operational usefulness without the dashboard.

- Implement verified Notion webhook intake.
- Implement Projects/Tasks read model, outbox projection, retry, and drift reconciliation.
- Implement approval request/decision synchronization.
- Wrap the three reference workflows with manifests, typed inputs, artifacts, and evaluations.
- Preserve Bridge child-page + HQ one-liner + Tracker dedup rules.
- Add notification adapter for run completion, failure, and approval requests.

**Gate:** end-to-end API-launched workflows update Notion exactly once and recover from a simulated Notion outage.

## Phase 4: operator experience

**Goal:** nontechnical operation from one interface.

- Action catalog and typed launch forms
- Runs list with state, owner, age, workflow/version, cost, and blocked reason
- Live event timeline via SSE
- Approval inbox with risk, intended side effect, scope, diff/preview, and expiry
- Artifact viewer/download and Notion links
- Admin views for registry versions, tool grants, sync failures, queue depth, and evaluations
- Accessibility, responsive layout, keyboard control, and empty/error/loading states

**Gate:** a contributor completes the three reference workflows without terminal access.

## Phase 5: hardening and deployment

**Goal:** shared production pilot.

- Independent security review and threat-model closure
- Load, soak, chaos, backup/restore, and disaster-recovery tests
- Cost limits, per-workspace concurrency, quotas, retention, and redaction
- Production identity/RBAC and secret rotation
- Railway/Vercel deployment, migrations, smoke checks, alerts, and rollback rehearsal
- Operator runbook and support ownership

**Gate:** all [acceptance-plan.md](acceptance-plan.md) P0/P1 checks pass with fresh evidence.

## Suggested work breakdown ownership

| Workstream | Primary agent role | Independent gate |
|---|---|---|
| Architecture/ADRs | architect | plan-reviewer + principal-reviewer |
| Contracts/migrations | kraken | arbiter + database optimization check |
| Runner/sandbox/policy | kraken + aegis | arbiter + principal-reviewer |
| Notion adapter | kraken | liaison + idempotency/limit tests |
| Web experience | kraken or frontend specialist | sentinel + UI compliance reviewer |
| Observability/performance | profiler | atlas |
| Deployment | deployer | atlas smoke/rollback validation |

## First Claude Code prompt

```text
Read every file in docs/architecture/agentic-os, .claude/rules/, and .claude/docs/architecture/INDEX.md. Treat this as a brownfield Agentic OS control-plane build. Start Phase 0 only: verify current code and Notion schemas; inventory reusable modules and drift; propose 1-3 ADR options for runner/session storage, identity/RLS, artifacts, queue, sandbox substrate, approval commands, side-effect adapter classes, Notion recovery, and deployment; then build a dependency-aware task graph. Do not write production code until the plan-review and principal-review gates pass. Preserve scripts/project-cards/state.json and all unrelated user changes.
```

## Stop and re-plan conditions

- The first vertical slice requires rewriting Ralph/Maestro rather than adapting them.
- Notion ownership conflicts with an existing automation.
- Runner authentication or billing is unsuitable for shared automation.
- Sandbox cannot enforce the declared tool/network/filesystem scope.
- Event/idempotency contract cannot represent a reference workflow side effect.
- A new framework is proposed without a measured comparison against the thin-adapter design.
