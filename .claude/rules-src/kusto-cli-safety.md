# Kusto.Cli Safety Rules

Companion to `.claude/skills/kusto-cli/SKILL.md` (connection strings, headless flags, output/CSV, recipes,
auth-mode reference, gotchas). KQL has a query language AND a control-command language (commands prefixed
with `.`). Control commands can mutate or destroy data irreversibly.

## The boundary [C:10]

**Any command starting with `.` that is not `.show …` requires explicit user confirmation before it runs.**
This is default-deny, not a lookup list — an unfamiliar `.`-command is CONFIRM, never assume-safe. The
families below are guidance on blast radius, not the limit of what is gated.

## Safe (no confirmation needed)

- Pure KQL queries (`<Table> | where … | project …`) — read-only by definition
- `.show …` — `.show tables`, `.show cluster`, `.show database`, `.show table <X> cslschema`,
  `.show ingestion failures`, `.show queries`, etc.
- `.execute database script with (whatif=true)` — **explicit dry-run only**; the live form is dangerous
- `#` client directives — `#save <path>` (writes local CSV only, no server mutation), `#connect`,
  `#dbcontext`, `#crp`, `#qp`, `#timeon|off`, `#tableon|off`, `#markdownon|off`, `#csvheaderson|off`
- `-help`, `-verboseHelp`, `-helpmd`, `-transcript:`

## Confirm-first — explain what it does, then WAIT for explicit approval

- **Schema destruction** — `.drop table`, `.drop tables (<list>)`, `.drop column`, `.drop database`,
  `.drop function`, `.drop materialized-view`, `.drop external table`, `.drop stored_query_result`;
  `.rename table` (breaks every query/dashboard referencing the old name).
- **Extent destruction** — `.drop extent` / `.drop extents`: **bypasses soft-delete entirely; immediate,
  irreversible data loss at the storage layer.**
- **Data destruction** — `.clear table <n> data` (wipes rows, keeps schema); `.clear database cache`
  (operational impact, self-recovering — still confirm); `.delete table <n> records` (predicate delete,
  soft-deleted and recoverable until purged); `.purge table <n> records|allrecords` and
  `.purge materialized-view <n> records` — **irreversible hard delete** (see pre-flight 4).
- **Data writes** — `.ingest into table`, `.set`, `.set-or-append`, `.set-or-replace`, `.append <t> <- <q>`,
  `.import table`, `.create-or-alter table` (destructive if columns dropped), and any
  `.create table … ingestion … mapping` change — a wrong mapping silently corrupts every later ingest.
- **Logic mutations** — `.create-or-alter function`, `.alter function` (live query-logic change; hits every
  caller), `.create-or-alter materialized-view` (re-materialization can be expensive and lock the source).
- **Bulk schema scripts** — `.execute database script` in its **live form** (i.e. without `whatif=true` /
  `Continue=true, whatif=true`): can fire dozens of destructive commands in one shot.
- **Policy / configuration** — `.alter table|database|column … policy …` (retention, caching, partitioning,
  encoding), `.alter merge policy`, `.alter-merge policy retention`, `.alter sharding policy`,
  `.alter row_level_security policy`, `.alter workload_group` / `.create-or-alter workload_group`.
  Retention changes can make data unrecoverable on the next purge cycle; workload-group changes can
  starve or break query SLAs.
- **Principals / permissions** — `.add` / `.drop` database|cluster|table admins, users, viewers, ingestors,
  monitors; any `.grant` / `.revoke` form.
- **Operational interruption** — `.cancel query <client-request-id>`, `.cancel queued ingestion operation`
  (a partially-completed ingest may already have written rows).

## Pre-flight (before ANY control command)

1. **Verify the target** — `#dbcontext` (no args) to echo the current database and `.show cluster` for the
   cluster URI. The session's connection string may have pinned a different DB than you assume.
2. **Inspect first** — before `.drop table X`, run `.show table X cslschema` and `X | count` so the user
   sees what is about to disappear.
3. **State the blast radius** — "This permanently drops `Events` (~12M rows) in cluster `<uri>`. Proceed?"
4. **For `.purge`, say this explicitly** — irreversible; runs against the Data Management endpoint
   (`ingest-<cluster>…`), not the engine; requires Database Admin; the cluster needs
   `EnableDoubleConfirmation` and the two-step verification-token flow; audited under GDPR/compliance.
5. **For `.execute database script`** — read the script first and surface EVERY dangerous line before
   running it without `whatif=true`.
6. **For ingestion** — confirm the source path AND the target table before triggering.

## Connection-string hygiene [C:10]

- **Never echo a connection string containing embedded secrets** — `AppKey=`, `Application Key=`,
  `UserToken=`, `AccessToken=`, or `EmbeddedManagedIdentity=` with a client ID.
- For CI, keep credentials in environment variables referenced at the call site — never committed to git.
- Which auth mode to choose (`Fed=true` vs managed-identity builders vs the separate `dSTS Federated
  Security` mechanism) → see the `kusto-cli` skill.
