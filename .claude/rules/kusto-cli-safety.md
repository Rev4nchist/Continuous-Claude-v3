# Kusto.Cli Safety Rules

Companion to `.claude/skills/kusto-cli/SKILL.md`. KQL has both a query language and a control-command language (commands prefixed with `.`). Some control commands mutate or destroy data and must be confirmed first.

## Safe Commands (no confirmation needed)

- Any pure KQL query (`<table> | where ... | project ...`, etc.) — read-only by definition
- `.show` family (`.show tables`, `.show cluster`, `.show database`, `.show ingestion failures`, `.show queries`, etc.)
- `.execute database script with (Continue=...)` in dry-run / explain modes
- `#save <path>` — writes CSV to local disk only, no server mutation
- `#connect`, `#dbcontext`, `#crp`, `#qp` — session-only, do not change server state
- `-help`, `-verboseHelp`, `-helpmd`, `-transcript:`
- `#timeon`, `#tableon`, `#markdownon`, `#csvheaderson` and their `*off` counterparts

## Dangerous Commands (ALWAYS confirm first)

Before running ANY of these, explain what it does and wait for explicit user approval:

### Schema destruction
- `.drop table <name>` — drops a table and all its data (irreversible without backup)
- `.drop tables (<list>)` — bulk drop
- `.drop column <table>.<col>` — drops a column
- `.drop database <name>` — destroys an entire database
- `.drop function <name>`, `.drop materialized-view <name>`, `.drop external table <name>`
- `.drop stored_query_result <id>`

### Data destruction
- `.clear table <name> data` — wipes all rows but keeps schema
- `.clear database cache` — invalidates cache (operational impact, recovers automatically)
- `.delete table <name> records` — predicate-based row delete (creates new extents, originals soft-deleted)
- `.purge table <name> records` — **GDPR-style hard delete; irreversible; auditable; requires special permissions**
- `.cancel <operation>` — aborts in-flight ingestion or query

### Data writes
- `.ingest into table <name> ...` — appends data from blob/inline
- `.set-or-append`, `.set-or-replace`, `.set` — bulk insert / replace table contents
- `.append <table> <- <query>` — appends query result into table
- `.create-or-alter table <name>` — schema change, can be destructive if columns dropped

### Policy / configuration changes
- `.alter table <name> policy retention` — changes retention; data may become unrecoverable on next purge cycle
- `.alter table <name> policy caching` — affects performance and cost
- `.alter database <name> policy ...` — database-wide policy change
- `.alter merge policy`, `.alter sharding policy`, `.alter row_level_security policy`
- `.add database admins`, `.drop database admins` — auth changes

## Pre-Flight Checks

Before any control command (anything starting with `.` that isn't `.show`):

1. **Verify the cluster and database.** Run `#dbcontext` (no args) to echo the current database, and `.show cluster` to confirm cluster URI. The conn string at session start may have set a different DB than expected.
2. **Inspect first.** Before `.drop table X`, run `.show table X schema` and `<X> | count` so the user sees what's about to disappear.
3. **State the blast radius.** "This will permanently drop the `Events` table containing ~12M rows in cluster `<uri>`. Proceed?"
4. **For `.purge`,** explicitly note: "Purge is irreversible and audited under GDPR/compliance review. The operation creates a permanent record. Proceed?"
5. **For ingestion**, confirm the source path and target table before triggering — wrong target can poison downstream tables.

## Connection-String Hygiene

- Never echo a connection string that includes embedded secrets (`AppKey=`, `Application Key=`, `UserToken=`, `AccessToken=`).
- Prefer `Fed=true` (AAD interactive/cached) or managed identity (`Fed=true;dSTS Federated Security=true` for first-party auth) over keys embedded in the string.
- For CI, use environment variables and reference them in the conn string via PowerShell expansion at the call site, not committed to git.

## Quick Decision Table

| Pattern | Safe? |
|---------|-------|
| `<Table> \| ...` (no leading `.`) | Yes |
| `.show ...` | Yes |
| `#save`, `#connect`, `#dbcontext` | Yes |
| `.drop`, `.delete`, `.purge`, `.clear` | **Confirm** |
| `.ingest`, `.append`, `.set-or-*` | **Confirm** |
| `.alter ... policy ...` | **Confirm** |
| `.create-or-alter` (table/function) | **Confirm** if existing object |
