# Security and Observability

## Security objectives

1. A user or workflow can exercise only explicitly granted capabilities.
2. External content cannot silently expand tool authority.
3. Every side effect is attributable, reviewable, idempotent, and recoverable where possible.
4. Credentials never enter prompts, logs, events, artifacts, or Notion pages.
5. Tenant/workspace data cannot cross boundaries through retrieval, traces, caches, or artifacts.
6. Self-improvement cannot bypass tests, review, approval, or rollback.

## Threat model

| Threat | Required control |
|---|---|
| Prompt injection in email/web/Notion | Label untrusted content, separate data from instructions, tool policy outside the model, approval before sensitive writes. |
| Excessive tool authority | Capability broker, resource scopes, short-lived credentials, deny by default, environment-specific grants. |
| Shell/filesystem escape | Non-root sandbox, read-only base, explicit mounts, per-run worktree, network egress allowlist, resource limits. |
| Duplicate side effect after retry | Stable operation id, adapter receipt, transactional event/outbox, reconciliation. |
| Cross-workspace retrieval | Mandatory workspace predicate, row-level policy tests, namespaced vector search and artifact paths. |
| Secret leakage in trace/artifact | Secret references, pre-export redaction, sensitive-field schema annotations, retention controls. |
| Malicious definition change | Git review, signed/approved release, pinned hashes, independent evaluation, rollback pointer. |
| Feedback poisoning | Provenance, confidence, quarantine, minimum evidence, fixture evaluation, human promotion. |
| Supply-chain compromise | Lockfiles, provenance checks, pinned images/actions, SBOM, vulnerability scanning. |
| Forged Notion webhook | Signature verification, replay window, event id dedup, least-privilege integration. |

## Approval policy baseline

| Action | Default |
|---|---|
| Read approved project files/Notion pages | Allow within workspace scope |
| Web research | Allow with egress/logging controls |
| Create draft artifact | Allow |
| Write/update Notion project content | Require approval for v1, except explicitly approved idempotent projections |
| Send email/message or publish externally | Require approval |
| Deploy, merge, change infrastructure/schema | Require approval |
| Delete/move/bulk overwrite | Deny unless an Admin grants one-time approval |
| Read secrets or broaden permissions | Deny; adapters resolve secrets without exposing values |

## Audit model

- Append-only events include actor, pinned versions, policy rule, grant, request hash, result receipt, and event hash chain.
- Administrative reads and exports are logged.
- Human approval includes preview/diff, risk class, scope, expiry, and comment.
- Audit export can reconstruct a run without exposing raw secrets.
- Database administrators can repair projections but cannot rewrite audit history through the application API.

## Trace model

```text
run
  attempt
    workflow.step
      agent.turn
        model.call
        memory.query
        tool.operation
        artifact.write
      policy.decision
      approval.wait
    evaluation
  notion.projection
```

Every span carries `workspace_id`, `run_id`, `attempt_id`, `task_id`, `definition_version`, `trace_id`, and data-classification labels. Prompt/completion capture is off by default in shared environments; sanitized capture is an explicit policy.

## Metrics and SLOs

| Signal | Initial target |
|---|---|
| API availability | 99.5% monthly pilot |
| Run creation p95 | < 500 ms excluding identity provider |
| Queue-to-start p95 | < 30 s under configured pilot capacity |
| Event-to-dashboard p95 | < 2 s |
| Approval decision propagation p95 | < 5 s |
| Notion projection lag p95 | < 60 s when Notion is healthy |
| Duplicate external side effects | 0 |
| Unattributed side effects | 0 |
| Worker recovery point | Last committed checkpoint |

Track queue depth/age, lease expiry, retries, dead letters, success by workflow/version, approval wait, tool failure, model latency/tokens/cost, memory hit usefulness, artifact failures, Notion `429/529`, projection drift, evaluation regression, and redaction failures.

## Alerting

- P0: cross-tenant access, secret disclosure, policy bypass, audit-chain failure
- P1: repeated side effect, migration failure, restore failure, queue fully stalled
- P2: error-rate/SLO breach, projection backlog, telemetry outage, high cost anomaly
- P3: single workflow/version regression or stale catalog projection

## Required reviews before pilot

- Security agent threat-model and implementation review
- Principal reviewer for policy boundary, durability, and multi-tenant data model
- Database query/index review for all run/event/outbox hot paths
- Dependency and container scan
- Browser acceptance and accessibility review
- Backup restore and credential rotation rehearsal

