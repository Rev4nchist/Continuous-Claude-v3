# Kusto.Cli Safety Rules

Companion to `.claude/skills/kusto-cli/SKILL.md`. KQL has both a query language and a control-command language (commands prefixed with `.`). Some control commands mutate or destroy data and must be confirmed first.

## Safe Commands (no confirmation needed)

- Any pure KQL query (`<table> | where ... | project ...`, etc.) — read-only by definition
- `.show` family (`.show tables`, `.show cluster`, `.show database`, `.show table <X> cslschema`, `.show ingestion failures`, `.show queries`, etc.)
- `.execute database script with (whatif=true)` — explicit dry-run only; the live form is dangerous (see below)
- `#save <path>` — writes CSV to local disk only, no server mutation
- `#connect`, `#dbcontext`, `#crp`, `#qp` — session-only, do not change server state
- `-help`, `-verboseHelp`, `-helpmd`, `-transcript:`
- `#timeon`, `#tableon`, `#markdownon`, `#csvheaderson` and their `*off` counterparts

## Dangerous Commands (ALWAYS confirm first)

Before running ANY of these, explain what it does and wait for explicit user approval.

### Schema destruction
- `.drop table <name>` — drops a table and all its data (irreversible without backup)
- `.drop tables (<list>)` — bulk drop
- `.drop column <table>.<col>` — drops a column
- `.drop database <name>` — destroys an entire database
- `.drop function <name>`, `.drop materialized-view <name>`, `.drop external table <name>`
- `.drop stored_query_result <id>`
- `.drop extents <pattern>` / `.drop extent <id>` — **bypasses soft-delete entirely; immediate, irreversible data loss at the storage layer**
- `.rename table <old> to <new>` — affects every query/dashboard referencing the old name

### Function and view mutations
- `.create-or-alter function <name>` — live query-logic change; affects every caller of the function
- `.alter function <name>` — same blast radius as `.create-or-alter function`
- `.create-or-alter materialized-view <name>` — re-materialization can be expensive and lock the source table

### Data destruction
- `.clear table <name> data` — wipes all rows but keeps schema
- `.clear database cache` — invalidates cache (operational impact, recovers automatically; safer than the others in this section but still confirm)
- `.delete table <name> records` — predicate-based row delete; creates new extents and marks originals as soft-deleted (auditable; recoverable until purged)
- `.purge table <name> records` / `.purge table <name> allrecords` — **irreversible hard delete; runs against the Data Management endpoint (`ingest-<cluster>...`) not the engine; requires Database Admin role; cluster needs `EnableDoubleConfirmation` for the two-step verification-token flow**
- `.purge materialized-view <name> records` — purge variant for MVs

### Data writes
- `.ingest into table <name> ...` — appends data from blob/inline/query
- `.set-or-append`, `.set-or-replace`, `.set` — bulk insert / replace table contents
- `.append <table> <- <query>` — appends query result into table
- `.create-or-alter table <name>` — schema change; can be destructive if columns dropped
- `.create table <name> ingestion ... mapping` mutations — wrong mapping silently corrupts every subsequent ingest
- `.import table <name>` — imports from external storage

### Bulk schema scripts
- `.execute database script <commands>` — multi-command schema mutation; the **live form is dangerous**. Only the explicit `.execute database script with (whatif=true)` (or `Continue=true, whatif=true`) variant is safe. Without `whatif=true`, this can fire dozens of destructive commands in one shot.

### Policy / configuration changes
- `.alter table <name> policy retention` — changes retention; data may become unrecoverable on next purge cycle
- `.alter table <name> policy caching` — affects performance and cost
- `.alter table <name> policy partitioning` — changes data layout; existing extents need re-partitioning
- `.alter column <table>.<col> policy encoding` — re-encodes column data on next merge
- `.alter database <name> policy ...` — database-wide policy change
- `.alter merge policy`, `.alter-merge policy retention`, `.alter sharding policy`, `.alter row_level_security policy`
- `.alter workload_group <name>` / `.create-or-alter workload_group` — request-routing changes; can starve or break query SLAs

### Principal / permission changes
- `.add database admins`, `.drop database admins` — auth changes (Admin role)
- `.add database users`, `.drop database users`, `.add database viewers`, `.drop database viewers`
- `.add database ingestors`, `.drop database ingestors`, `.add database monitors`, `.drop database monitors`
- `.add cluster admins`, `.drop cluster admins`
- `.add table admins`, `.drop table admins`
- Any `.grant` / `.revoke` form

### Operational interruption (non-data-destructive but confirm)
- `.cancel query <client-request-id>` — aborts a specific running query
- `.cancel queued ingestion operation <id>` — aborts an in-flight ingestion (partial ingest may still have written some rows)

## Pre-Flight Checks

Before any control command (anything starting with `.` that isn't `.show`):

1. **Verify the cluster and database.** Run `#dbcontext` (no args) to echo the current database, and `.show cluster` to confirm cluster URI. The conn string at session start may have set a different DB than expected.
2. **Inspect first.** Before `.drop table X`, run `.show table X cslschema` and `<X> | count` so the user sees what's about to disappear. (`.show table X cslschema` returns the create-script-equivalent; `.show table X schema as json` is the programmatic variant.)
3. **State the blast radius.** "This will permanently drop the `Events` table containing ~12M rows in cluster `<uri>`. Proceed?"
4. **For `.purge`,** explicitly note: "Purge is irreversible, runs through the Data Management endpoint, requires Database Admin, and is audited under GDPR/compliance review. The cluster must have `EnableDoubleConfirmation` set, and you'll need the two-step verification-token flow. Proceed?"
5. **For `.execute database script`,** read the script first and surface every dangerous line in the script before running it without `whatif=true`.
6. **For ingestion**, confirm the source path and target table before triggering — wrong target can poison downstream tables and the wrong ingestion mapping silently corrupts data.

## Connection-String Hygiene

- Never echo a connection string that includes embedded secrets (`AppKey=`, `Application Key=`, `UserToken=`, `AccessToken=`, `EmbeddedManagedIdentity=` with a client ID).
- Prefer `Fed=true` (AAD interactive/cached) for human-in-the-loop work, or managed identity via the SDK auth builders (`WithAadSystemManagedIdentity()` / `WithAadUserManagedIdentity(<clientId>)`) or the `EmbeddedManagedIdentity=...` connection-string fragment for CI. `dSTS Federated Security=true` is a separate first-party mechanism — don't confuse it with managed identity.
- For CI, use environment variables and reference them in the conn string via PowerShell expansion at the call site, not committed to git.

## Quick Decision Table

| Pattern | Safe? |
|---------|-------|
| `<Table> \| ...` (no leading `.`) | Yes |
| `.show ...` | Yes |
| `#save`, `#connect`, `#dbcontext` | Yes |
| `.execute database script with (whatif=true)` | Yes (dry-run only) |
| `.execute database script` (live form) | **Confirm** |
| `.drop`, `.drop extents`, `.delete`, `.purge`, `.clear` | **Confirm** |
| `.ingest`, `.append`, `.set-or-*`, `.import table` | **Confirm** |
| `.alter ... policy ...`, `.alter-merge` | **Confirm** |
| `.create-or-alter` (table/function/view) | **Confirm** |
| `.rename table` | **Confirm** |
| `.add` / `.drop` admins/users/viewers/ingestors/monitors, `.grant`, `.revoke` | **Confirm** |
| `.cancel query`, `.cancel queued ingestion operation` | **Confirm** |
