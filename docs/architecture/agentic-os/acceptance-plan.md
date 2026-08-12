# Acceptance Plan

## Evidence rule

No item is complete from inspection alone. Every criterion needs a fresh command, API response, test report, trace, screenshot, or recovery demonstration linked from the release record.

## P0 release blockers

### Identity and isolation

- [ ] Unauthenticated requests cannot list catalog actions, runs, approvals, or artifacts.
- [ ] Each role receives only its documented actions.
- [ ] Cross-workspace run, event, memory, artifact, and approval access tests fail closed.
- [ ] RLS and workspace-scoped uniqueness prevent cross-workspace reads, writes, and idempotency collisions even when an application query omits a workspace filter.
- [ ] Revoked users and expired grants stop new actions immediately.

### Durable execution

- [ ] Duplicate run requests with the same idempotency key return one run.
- [ ] Two workers cannot own the same active lease.
- [ ] Worker death after checkpoint resumes without repeating a completed tool operation.
- [ ] Resume on a different empty worker reconstructs the pinned session from durable `SessionStore` data rather than local disk.
- [ ] Cancellation prevents new side effects and records cleanup outcome.
- [ ] Timeout and retry limits reach deterministic terminal states.

### Policy and side effects

- [ ] Every external write has a grant, policy decision, operation id, request hash, and receipt.
- [ ] Denied or expired approvals cannot execute.
- [ ] Destructive, deploy, merge, publish, and message actions require the configured approval.
- [ ] Prompt-injected content cannot alter grants or policy.

### Secrets and audit

- [ ] Known canary secrets do not appear in events, traces, logs, artifacts, UI, or Notion.
- [ ] Audit hash-chain verification passes.
- [ ] Security-critical administrative actions are attributable.

### Recovery

- [ ] Database restore rehearsal meets RPO/RTO targets.
- [ ] Migration failure leaves the prior release operable or has a verified forward fix.
- [ ] Ambiguous external operations are quarantined rather than blindly retried.
- [ ] Each write adapter passes crash-window fault injection for its declared idempotent, reconciliable, compensatable, or irreversible effect class.
- [ ] A Notion export/snapshot restore into staging meets its RPO/RTO and produces a reviewed reconciliation report.

## P1 functional acceptance

### Reference workflows

- [ ] Research brief produces a cited artifact, evaluation, approval, and one Notion result.
- [ ] Repository change runs in an isolated worktree, tests/reviews, and returns a PR-ready artifact without auto-merge.
- [ ] Operational digest runs on schedule and idempotently creates Bridge/Tracker projections.

### Notion

- [ ] Project/task changes arrive through verified webhooks or reconciliation.
- [ ] Human-owned fields are never overwritten by projections.
- [ ] `429`/`529` responses honor `Retry-After` and do not fail the originating run.
- [ ] Outbox retry and drift reconciliation are visible to operators.
- [ ] Relation updates follow the existing separate-update rule.

### Operator interface

- [ ] A Contributor launches each approved action without terminal access.
- [ ] Runs screen communicates queued/running/blocked/approval/failed/succeeded states.
- [ ] Timeline is ordered, live, keyboard accessible, and useful without raw model text.
- [ ] Approval preview explains intended side effect, scope, risk, and expiry.
- [ ] Empty, loading, stale, offline, permission-denied, and error states are tested.

### Observability

- [ ] One trace correlates run, attempt, step, model, memory, tool, artifact, approval, evaluation, and Notion projection.
- [ ] Queue, lease, retry, dead-letter, cost, and projection metrics are present.
- [ ] P0/P1 synthetic alerts reach the configured operator route.

## Performance and soak

- [ ] API and event-stream SLOs pass at 2x expected pilot concurrency.
- [ ] 24-hour soak has no orphaned leases, unbounded memory growth, duplicate effects, or projection drift.
- [ ] Backpressure keeps API responsive when workers or Notion are unavailable.
- [ ] Large event histories paginate and stream without loading the whole run into memory.

## Definition/version safety

- [ ] Every run pins content hashes and model/policy configuration.
- [ ] Candidate definition cannot become default without test/evaluation evidence and approval.
- [ ] Rollback changes only the default for new runs.
- [ ] Active runs continue on pinned versions.

## Final sign-off packet

- Release SHA and image digests
- Migration version and backup/restore evidence
- Test reports and browser/accessibility report
- Threat model and security review closure
- Load/soak/chaos results
- Three reference workflow traces and Notion pages
- Rollback rehearsal record
- Known limitations, owners, and follow-up Notion tasks
