# Runtime Contracts

## Core state machines

### Run

```text
requested -> queued -> running -> awaiting_approval -> running
requested|queued|running|awaiting_approval -> cancelling -> cancelled
running -> succeeded|failed|timed_out
```

Terminal run states are immutable. `POST /v1/runs/:id/retry` appends a new `run_attempt` under the same run aggregate; it does not transition a terminal run back to `queued`. The run aggregate exposes both `latest_attempt_state` and a derived outcome so attempt history remains intact.

### Step/task

```text
pending -> ready -> leased -> running -> checkpointed -> succeeded
leased|running -> retry_wait -> ready
leased|running -> awaiting_approval -> ready
leased|running -> failed|cancelled|timed_out
```

## Required records

| Record | Required fields |
|---|---|
| `workspace` | id, slug, policy_version, created_at |
| `principal` | id, workspace_id, identity_provider_subject, status |
| `role_binding` | workspace_id, principal_id, role, scope |
| `definition_version` | id, workspace_id, kind, name, git_sha, path, content_hash, manifest, status |
| `run` | id, workspace_id, workflow_version_id, requested_by, input, state, idempotency_key, trace_id, timestamps |
| `run_attempt` | id, workspace_id, run_id, number, runner, model_config, state, resume_checkpoint_id, token/cost totals |
| `task` | id, workspace_id, run_attempt_id, step_key, state, dependency set, lease owner/expiry, retry policy |
| `event` | id, workspace_id, run_id, task_id, type, schema_version, actor, payload, created_at, hash |
| `approval` | id, workspace_id, run_id, task_id, action summary, risk, state, version, requested_by, decided_by, decision, expiry, revoked_at |
| `tool_grant` | workspace_id, principal/workflow, tool, actions, resource scope, environment, expiry |
| `tool_operation` | operation_id, workspace_id, run/task, adapter, effect_class, request_hash, state, receipt, reconciliation_state, timestamps |
| `artifact` | id, workspace_id, run/task, type, uri, checksum, media_type, size, provenance, retention |
| `evaluation` | id, workspace_id, run/artifact, evaluator_version, rubric, score, evidence, decision |
| `checkpoint` | id, workspace_id, run_attempt_id, task_id, runner_session_id, encrypted session payload or durable session-store reference, sequence, checksum, created_at |
| `outbox` | id, workspace_id, destination, aggregate, payload, idempotency_key, state, attempts, next_attempt_at |

Every tenant-sensitive table has a `workspace_id` foreign key. Uniqueness keys, including request and operation idempotency keys, are workspace-scoped. Phase 0 must choose and test an RLS strategy; application filters alone are not an isolation boundary.

## Event envelope

```json
{
  "event_id": "uuid",
  "schema_version": 1,
  "event_type": "tool.operation.completed",
  "workspace_id": "uuid",
  "run_id": "uuid",
  "task_id": "uuid",
  "trace_id": "string",
  "actor": {"type": "worker", "id": "uuid"},
  "occurred_at": "RFC3339",
  "payload": {},
  "previous_event_hash": "sha256|null",
  "event_hash": "sha256"
}
```

Event payloads are versioned. Sensitive values are references or redacted summaries, never raw secrets.

## Definition manifest

Every executable agent, skill, workflow, or connector exposes:

```yaml
apiVersion: agentic-os/v1
kind: Workflow
metadata:
  name: research-brief
  version: 1.0.0
spec:
  owner: research
  entrypoint: .claude/skills/research-brief/SKILL.md
  inputSchema: schemas/research-brief.input.json
  outputSchema: schemas/research-brief.output.json
  agents: [oracle, critic]
  tools: [web.search:read, notion.pages:write]
  sideEffects: [notion.pages:write]
  approvals:
    - before: notion.pages:write
  timeoutSeconds: 1800
  retry:
    maxAttempts: 2
    backoff: exponential
  evaluation: evaluations/research-brief.yaml
```

## Runner interface

```ts
interface RunnerAdapter {
  start(request: RunnerStartRequest): Promise<RunnerHandle>;
  resume(request: RunnerResumeRequest): Promise<RunnerHandle>;
  cancel(handle: RunnerHandle): Promise<CancelResult>;
  events(handle: RunnerHandle): AsyncIterable<RunnerEvent>;
}
```

`RunnerStartRequest` includes workspace/run/attempt/task ids, pinned definition and policy hashes, resolved grants, an input artifact reference, and checkpoint policy. `RunnerResumeRequest` includes those same pinned values plus the durable checkpoint reference, expected checkpoint sequence, runner session id, and last committed event/operation ids. The adapter persists session metadata through a `SessionStore` abstraction backed by durable encrypted storage; a Railway container filesystem is never the resume source of truth.

The adapter receives only resolved, approved capabilities. It cannot discover unrestricted credentials from the host environment. A resume must compare pinned hashes and checkpoint checksums before model or tool execution.

## Approval command contract

Operational approval state is a PostgreSQL state machine: `pending -> approved|denied|expired|revoked`; terminal decisions are immutable. Notion and dashboard clients submit `ApprovalDecisionCommand {approval_id, workspace_id, expected_version, decision, actor, source, idempotency_key, occurred_at}`. The API uses compare-and-swap on `expected_version`; duplicate commands return the stored decision, and conflicting, late, expired, or revoked commands return a conflict without executing the action. Notion receives the resulting projection.

## External side-effect adapter contract

Every write adapter declares one effect class and recovery behavior:

| Effect class | Required behavior |
|---|---|
| Native idempotent | Send the stable operation id to the provider and persist its receipt. |
| Reconciliable | Query provider state by operation fingerprint before retry; store matched evidence. |
| Compensatable | Record forward and compensation operations independently; compensation requires policy. |
| Irreversible/ambiguous | Never retry automatically after an uncertain crash window; quarantine for human decision. |

Fault-injection tests must cover a crash before request, after provider acceptance but before receipt commit, and after receipt commit for every production write adapter.

## Minimum API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/v1/catalog/actions` | List actions allowed for the current principal. |
| `POST` | `/v1/runs` | Create or return an idempotent run. |
| `GET` | `/v1/runs/:id` | Current state and pinned versions. |
| `GET` | `/v1/runs/:id/events` | Paginated events or SSE stream. |
| `POST` | `/v1/runs/:id/cancel` | Request cancellation. |
| `POST` | `/v1/runs/:id/retry` | Create an explicit retry attempt. |
| `GET` | `/v1/approvals` | Pending approvals visible to the principal. |
| `POST` | `/v1/approvals/:id/decision` | Approve or deny with comment. |
| `GET` | `/v1/artifacts/:id` | Metadata and authorized access URL. |
| `POST` | `/v1/notion/webhook` | Verify and enqueue Notion events. |
| `GET` | `/health/live` | Process liveness only. |
| `GET` | `/health/ready` | Database, migration, and queue readiness. |

## Policy decisions

Policy input includes principal, role bindings, workflow version, requested tool action, resource, environment, data classification, run risk, and prior approvals. Output is `allow`, `deny`, or `require_approval`, with rule id and human-readable reason. The most restrictive applicable decision wins.

## Self-improvement contract

1. A run or scheduled evaluator identifies evidence for change.
2. The system creates a candidate definition version in Git or a patch artifact.
3. Candidate runs against fixed fixtures and shadow traffic where safe.
4. Deterministic gates and an independent evaluator produce evidence.
5. A Builder/Admin approves promotion.
6. New runs may select the promoted version; active runs remain pinned.
7. Rollback changes the default pointer and does not rewrite history.
