# Deployment Runbook

## Environments

| Environment | Purpose | Data |
|---|---|---|
| Local | TDD and adapter development | Docker PostgreSQL, fake identity, Notion sandbox or recorded fixtures |
| Preview | Per-PR UI/API review | Ephemeral services/database schema; no production connectors |
| Staging | Full integration and migration rehearsal | Dedicated Notion test pages/integration, nonproduction secrets |
| Production pilot | Dave + approved users | Production Notion resources and isolated service credentials |

Never point local or preview builds at production Notion write scopes.

## Production topology

- `agentic-os-web`: Vercel static/edge delivery or Railway web service
- `agentic-os-api`: Railway service, minimum two instances only after lease/idempotency tests
- `agentic-os-worker`: Railway coordinator with bounded concurrency; it dispatches execution into the separately selected sandbox substrate
- Sandboxed execution substrate: Phase 0 ADR must select an isolation-capable provider/runtime with non-root processes, ephemeral writable layer, explicit mounts, CPU/memory/time limits, egress policy, and per-run teardown. A Railway service container or Git worktree alone does not satisfy this boundary.
- `agentic-os-sync`: Railway worker/webhook service
- Durable encrypted runner session/checkpoint store: PostgreSQL and/or private object storage behind the `SessionStore` contract; never worker-local disk
- PostgreSQL 16 + pgvector: managed Railway/approved provider with PITR/backups
- Artifact storage: private object store with short-lived signed access URLs
- Braintrust/OTel exporter: async from durable telemetry/outbox
- Identity provider: OIDC; no application-managed passwords in v1

## Configuration classes

| Class | Examples | Storage |
|---|---|---|
| Public | base URL, build SHA, environment | deployment variables |
| Sensitive | database URL, OIDC client secret, Notion token, model/API credential | platform secret store |
| Policy | grants, retention, concurrency, approval rules | versioned config + database activation record |
| Definition | agents, skills, workflows, schemas, evals | Git + registry hash |

Startup must fail closed when required secrets or policy versions are absent. Do not log environment values.

## CI/CD sequence

1. Lint, typecheck, unit, contract, migration, policy, and security tests.
2. Build pinned container images; generate SBOM and scan.
3. Deploy preview and run API/browser smoke tests.
4. On approved release, back up database and run migration preflight.
5. Apply backward-compatible migrations.
6. Deploy API/sync, then workers, then web.
7. Verify readiness, queue claim, event stream, approval, artifact, Notion test projection, and telemetry.
8. Increase worker concurrency gradually.
9. Record release SHA, migration version, definition defaults, and evidence.

## Migration rules

- Expand/contract only: add new schema, deploy compatible code, backfill, switch reads, then remove old schema in a later release.
- Every migration has an isolated-database test and an explicit rollback/forward-fix strategy.
- Large backfills use resumable batches and progress records.
- Definition registry activation is separate from database migration.
- A failed projection schema never blocks runtime event commits.

## Smoke test

1. `/health/live` and `/health/ready` pass.
2. Current build SHA and migration version match the release.
3. Create an idempotent no-side-effect run twice; receive one run id.
4. Worker claims and completes the run; SSE shows ordered events.
5. Create a test approval and deny it; the action does not run.
6. Generate and retrieve a private artifact through an authorized URL.
7. Project one staging task update to Notion exactly once.
8. Confirm trace/evaluation receipt and redaction.
9. Restart a worker during a checkpoint fixture and verify recovery.

## Rollback

- Stop new run admission or set the affected workflow version unavailable.
- Scale affected workers to zero while leaving API/read access available.
- Restore previous container images and default definition pointers.
- Prefer forward-fixing expanded schemas; restore database only for data corruption, not application defects.
- Reconcile leased tasks and mark ambiguous external operations for human review before retry.
- Re-run smoke tests and record incident/evidence in Notion and the audit log.

## Backup and recovery

- Daily backup plus provider PITR for PostgreSQL; quarterly restore rehearsal during pilot.
- Versioned object storage or retention policy for artifacts required by active runs.
- Git is the backup for definitions; releases pin immutable SHAs.
- Notion project/task/decision data receives a weekly workspace export plus a daily normalized reconciliation snapshot in private object storage during the pilot. Snapshot manifests record page ids, last-edited times, schema, content hashes, and related PostgreSQL aggregate ids.
- RPO target: 15 minutes for runtime records; RTO target: 4 hours for pilot.
- Notion target: 24-hour RPO and 8-hour RTO during the pilot. Quarterly rehearsal restores into a staging workspace, reconciles against the latest normalized snapshot and PostgreSQL projection ledger, and records missing/conflicting human-owned fields for manual resolution. Runtime projections can be replayed; human-owned Notion fields can only be restored from the export/snapshot.

## Capacity and cost controls

- Per-workspace and per-workflow concurrency limits
- Maximum run duration, model turns, tokens, and spend
- Queue age and cost anomaly alerts
- Scheduled workflows use jitter and admission control
- High-cost or unusually broad runs require approval
- Subscription-authenticated local execution and API-billed shared execution are reported separately
