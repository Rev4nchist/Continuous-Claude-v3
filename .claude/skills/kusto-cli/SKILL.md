---
name: kusto-cli
description: Kusto.Cli reference for KQL queries against Azure Data Explorer or Fabric Eventhouse. Use when the user says "run this KQL", "query Kusto", "Eventhouse", "kusto-cli", or asks to export results to CSV.
---

# Kusto CLI Skill

`Kusto.Cli.exe` is Microsoft's reference command-line tool for sending KQL queries and control commands to a Kusto service (Azure Data Explorer or Microsoft Fabric Eventhouse). It is REPL-first but supports fully headless execution via `-execute` / `-script`.

On this machine: `C:\tools\kusto-cli\Kusto.Cli.exe`, version `14.1.2`, .NET Framework 4.7.2 build. Modern Windows 10/11 ships a preinstalled 4.x .NET Framework runtime that is forward-compatible with net472 targets (Win 10 1803/1809 preinstall 4.7.2; Win 11 22H2+ preinstalls 4.8.1) — verify with `Get-ItemPropertyValue 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' Release` if startup fails. Source NuGet: [Microsoft.Azure.Kusto.Tools](https://www.nuget.org/packages/Microsoft.Azure.Kusto.Tools/).

Run `Kusto.Cli.exe -help` for basics, `-verboseHelp` for advanced switches. `-helpmd` and `-verboseHelpMd` emit MarkDown.

## Connection Strings

The connection string is the first positional argument. Always wrap in double quotes — PowerShell parses unquoted semicolons as command separators.

| Target | Pattern |
|--------|---------|
| Microsoft Fabric Eventhouse / KQL DB | `"https://<eventhouse-guid>.z<N>.kusto.fabric.microsoft.com/<database>;Fed=true"` |
| Azure Data Explorer cluster | `"https://<cluster>.<region>.kusto.windows.net/<database>;Fed=true"` |
| Public help cluster (Microsoft samples) | `"https://help.kusto.windows.net/Samples;Fed=true"` or shorthand `"@help/Samples"` |

> **Fabric Eventhouse URIs are not constructible.** The leading segment is the eventhouse GUID (not the workspace ID) and there is a `.z<N>.` zone segment whose value Microsoft assigns. Always copy the URI from the eventhouse's *Database details → Copy URI* button rather than building one by hand.

`Fed=true` enables AAD federated auth — opens a browser on first use, caches tokens afterward. Other auth modes (application key, federated certificate, managed identity) are encoded as additional fragments — managed identity uses the SDK auth builders (`WithAadSystemManagedIdentity()` / `WithAadUserManagedIdentity(<clientId>)`) or the `EmbeddedManagedIdentity=...` fragment, *not* `dSTS Federated Security` (that is a separate first-party mechanism). Full reference: [Kusto connection strings](https://learn.microsoft.com/kusto/api/connection-strings/kusto).

## Headless Execution

Default behavior is REPL. For scripts and CI, always pair `-execute:` with `-keepRunning:false` so the process exits.

Single query:

```powershell
Kusto.Cli.exe "<conn>" -execute:"StormEvents | take 5" -keepRunning:false
```

Multiple commands run in order:

```powershell
Kusto.Cli.exe "<conn>" `
  -execute:"#save c:\temp\out.csv" `
  -execute:"StormEvents | take 100" `
  -keepRunning:false
```

Script file (one command per line; use `&` at end of line to continue, `&&` to fold):

```powershell
Kusto.Cli.exe "<conn>" -script:"queries\daily.kql" -scriptQuitOnError:true -keepRunning:false
```

`-scriptml:` treats the entire file as a single command — use it when KQL spans multiple lines without `&` continuation. For very long queries, prefer `-script:<file>` over piling up `-execute:` chains; response-file (`@<file>`) syntax exists in `.NET` arg parsing but is *not* in the published Kusto.Cli reference, so don't rely on it.

## Output

Default is a console table. **No native JSON.** Structured export goes through the `#save` directive, which writes the *next* query result to a CSV file:

```powershell
Kusto.Cli.exe "<conn>" -execute:"#save c:\temp\events.csv" -execute:"StormEvents | take 100" -keepRunning:false
```

For pipelines that need JSON, post-process with PowerShell:

```powershell
Import-Csv c:\temp\events.csv | ConvertTo-Json -Depth 5
```

Other output toggles (directives, runtime-only): `#csvheaderson|off`, `#tableon|off`, `#markdownon|off`, `#focuson|off`, `#timeon|off`. Set `-transcript:<file>` to mirror all output to a log.

## CLI vs Other Routes

| Route | Use For |
|-------|---------|
| Kusto.Cli (this skill) | KQL data queries, batch scripts, CSV export for analysis |
| `az kusto` (Azure CLI) | **Management plane only** — provisioning clusters, databases, principals. Cannot run KQL. |
| Kusto SDK (Python/.NET) | Production data pipelines, JSON results, programmatic integration |
| Kusto.Explorer / Web UI | Interactive exploration with charts and visualization |

## Common Recipes

```powershell
# List tables in the database encoded in the conn string
Kusto.Cli.exe "@help/Samples" -execute:".show tables" -keepRunning:false

# Connect to a cluster URI without a database, then switch context per query
# (use #dbcontext only when the conn string DOESN'T already pin a database)
Kusto.Cli.exe "https://help.kusto.windows.net;Fed=true" `
  -execute:"#dbcontext Samples" `
  -execute:".show tables" `
  -keepRunning:false

# Show cluster diagnostics
Kusto.Cli.exe "<conn>" -execute:".show cluster" -keepRunning:false

# Export query result to CSV (no headers)
Kusto.Cli.exe "<conn>" -execute:"#csvheadersoff" -execute:"#save out.csv" -execute:"<KQL>" -keepRunning:false

# Run a saved script and quit on first error
Kusto.Cli.exe "<conn>" -script:"daily-rollup.kql" -scriptQuitOnError:true -keepRunning:false

# Capture transcript for audit
Kusto.Cli.exe "<conn>" -transcript:"run-$(Get-Date -Format yyyyMMdd-HHmmss).log" -execute:"<KQL>" -keepRunning:false
```

## Gotchas

- **Always quote the connection string** — `Fed=true` parsed bare in PowerShell becomes a separate command and breaks the call.
- **Default is REPL** — forgetting `-keepRunning:false` leaves the process waiting on stdin in a non-interactive shell.
- **Exit code 1 from `-help` is normal** — not an error.
- **No JSON output** — use `#save` to CSV, then `Import-Csv | ConvertTo-Json` if needed.
- **AAD interactive on first use** — first headless run opens a browser. CI needs managed identity or app-key auth encoded in the conn string.
- **Positional conn string** — must be the first non-switch arg, before any `-execute`/`-script`.
- **`-executeAndKeepRunning:`** runs commands then drops into REPL — useful when interactively iterating after a setup query, but never use it in scripts. Local `-help` output exposes `-ekr:` as a short alias, but that alias is *not* in Microsoft's published Kusto.Cli reference; use the long form in any script you commit.
- **`-webProxy:` and response-file `@args.rsp`** appear in some `-help` builds but are *not* in the published reference — don't rely on either in committed scripts.

## Safety

See [.claude/rules-ondemand/kusto-cli-safety.md](../../rules-ondemand/kusto-cli-safety.md) for the dangerous-command list (`.drop`, `.drop extents`, `.delete`, `.purge`, `.clear`, `.execute database script`, `.alter ... policy`, `.ingest into`, `.set-or-append`, `.set-or-replace`, function/principal mutations, `.cancel`). Pure read queries, `.show` commands, and `#save` are safe.

## Related Skills

- **`databases`** — general PostgreSQL / SQL query optimization patterns. KQL is its own dialect, but the migration-safety / index-thinking discipline transfers.
- **`neonctl`** — sibling cloud-DB CLI integration; same skill+rule shape if you ever add another KQL-style tool here.

## When to Use

Trigger keywords: `kusto`, `Kusto.Cli`, `KQL`, `kql query`, `Azure Data Explorer`, `ADX`, `Fabric Eventhouse`, `Fabric KQL DB`, `kusto.fabric.microsoft.com`, `kusto.windows.net`, `.show tables`, `StormEvents`

---

<!-- archived-rule:kusto-cli-safety.md ref:b800899 -->
## Reference: pre-split text of `rules-ondemand/kusto-cli-safety.md` (archived 2026-07-29)

The rule now carries only the invariants an agent must hold *before* deciding to use this
tool. The evidence trail, version pins, probe archaeology and long caveats live here, and
load only once this skill does. Verbatim snapshot, so nothing that was trimmed is lost:

```markdown
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

```

## Safety

<!-- current text of rules-src/kusto-cli-safety.md, moved here on 2026-09-23 (Opus 5.5 eval, P20); the rule keeps a short summary. Supersedes the 2026-07-29 pre-split reference above. -->
Companion to `.claude/skills/kusto-cli/SKILL.md` (connection strings, headless flags, output/CSV, recipes,
auth-mode reference, gotchas). KQL has a query language AND a control-command language (commands prefixed
with `.`). Control commands can mutate or destroy data irreversibly.

## The boundary [C:10]

**Any command starting with `.` that is not `.show …` (or the `whatif=true` dry run listed as safe below) requires explicit user confirmation before it runs.**
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
