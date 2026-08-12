# Notion Operating Model

## Role of Notion

Notion is the canonical human database and project-management surface for Agentic OS. It owns portfolio/project intent, tasks, curated decisions and knowledge, the human-facing approval inbox, and links to run artifacts. PostgreSQL owns the operational approval state consumed by workers. Notion does not own worker leases, every tool event, raw prompts, high-volume logs, secrets, or queue semantics.

This boundary is required because Notion applies per-connection and workspace rate limits: [official limits](https://developers.notion.com/reference/request-limits). PostgreSQL stores high-frequency runtime facts; Notion receives concise, idempotent projections.

## Existing resources to reuse

| Resource | ID |
|---|---|
| Claude Bridge HQ | `30e76fd7-ac82-81e9-9fe1-c0b257088b34` |
| Claude Bridge bucket | `30e76fd7-ac82-81e1-b30e-d170600896a7` |
| Projects data source | `33b76fd7-ac82-8234-a202-8719384ac5b1` |
| Tasks data source | `c3176fd7-ac82-825c-a03c-073837e5493c` |
| Weekly Work Tracker data source | `6e8d9b17-f8ef-4d56-9f13-00344650ac03` |
| Default AI Enablement project | `34b76fd7-ac82-8104-82ca-df3e801695c0` |

The live Projects schema uses `Project` as title, `Status` values `Inbox|Planned|In progress|Completed`, `Timeline`, `Bucket`, and relations to Tasks and Tracker Entries. The Tasks schema uses `Task` as title, `Description`, `Priority` values `High|Mid|Low`, `Progress`, completion checkbox ` `, `Due Date`, `Project`, and `Bucket`.

## Live v1 project structure

The [Agentic OS project](https://app.notion.com/p/3a276fd7ac828122a0d5f57eb93cb5b1) exists with status **In progress** and is related to the Claude Bridge bucket. Its six phase tasks are:

1. [Phase 0: workflow audit and architecture validation](https://app.notion.com/p/3a276fd7ac82815d8d2cc3b500aadb34)
2. [Phase 1: contracts, migrations, and registry](https://app.notion.com/p/3a276fd7ac828136be25fd044161fb28)
3. [Phase 2: durable runner and sandboxed worker](https://app.notion.com/p/3a276fd7ac828106b37dc4cee52913da)
4. [Phase 3: Notion sync, approvals, and reference workflows](https://app.notion.com/p/3a276fd7ac8281fe8e28db37cc13032c)
5. [Phase 4: operator dashboard and live telemetry](https://app.notion.com/p/3a276fd7ac82817b88e0cf3121215e2b)
6. [Phase 5: security review, acceptance, and production deployment](https://app.notion.com/p/3a276fd7ac8281d6b411c3d21be24fb4)

All six tasks are related to both the project and Claude Bridge bucket. Relations were set after page creation to follow the database contract.

Do not guess due dates. Set progress from verified implementation state, not elapsed time.

## Ownership and synchronization

| Change | Authoritative write | Projection behavior |
|---|---|---|
| Project name/status/timeline | Notion Projects | Webhook enqueues refresh; dashboard updates. |
| Task description/priority/completion | Notion Tasks | Webhook creates/updates an execution request only when an explicit automation property or approved command is present. |
| Run state | PostgreSQL | Sync concise status, run URL, artifact links, and last error to the related Notion page. |
| Approval display/command | PostgreSQL operational approval state | Notion or dashboard submits an idempotent decision command with expected version; PostgreSQL resolves conflicts/expiry/revocation, then projects the result everywhere. |
| Artifact | Object store/repository + PostgreSQL metadata | Notion receives link/embed and summary, not duplicate large payloads. |
| Implementation handoff | Bridge child page | HQ receives one-liner; Tracker receives deduplicated row by writeback URL. |

## Outbox protocol

1. State transition and `outbox` row commit in one PostgreSQL transaction.
2. Sync worker claims the outbox row with a lease.
3. Operation id is `notion:<workspace>:<aggregate>:<projection-version>`.
4. Worker queries for an existing receipt/Notion URL before create.
5. `429` and `529` honor `Retry-After`; other transient failures back off with jitter.
6. Success stores Notion page id, URL, content hash, and last edited time.
7. Reconciliation job compares authoritative hashes and reports drift; it never overwrites human-owned fields.

Approval projections use the same outbox path. They are never treated as evidence that an action may run until the versioned decision command has committed in PostgreSQL.

## Bridge completion writeback

After this design package or a future implementation milestone:

1. Fetch Bridge HQ.
2. Create a `[Code→Eve]` child page with the canonical template.
3. Add a one-line entry to Code → Eve.
4. Mirror a Weekly Work Tracker row, deduplicated by writeback URL.
5. Add an Implementation Log entry for shipped work.
6. Update Sprint State only if an existing commitment changes.

## Security

- Use an internal integration for server automation and a PAT only for local personal workflows.
- Store tokens in Railway/environment secret storage, never Git or Notion content.
- Grant the integration only the required databases/pages.
- Verify webhook signatures before enqueueing.
- Require an approval for schema changes, bulk updates, deletes, moves, or relation rewrites.
- Record every Notion write as a tool operation with request hash and response receipt.

Official guidance: [authorization](https://developers.notion.com/guides/get-started/authorization), [API key handling](https://developers.notion.com/guides/get-started/handling-api-keys), and [MCP security](https://developers.notion.com/guides/mcp/mcp-security-best-practices).
