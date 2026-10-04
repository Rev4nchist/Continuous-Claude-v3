# Fabric lakehouse, schemas, shortcuts and the SQL endpoint

CCv3-authored from the Fabric course extraction (`docs/research/fabric/2026-10-04-fabric-course-extraction.md`,
rule ids G-NN) and Microsoft Learn. Upstream skills-for-fabric has no lakehouse skill. Spark work on a
lakehouse goes to the vendored `spark-cli` row of the hub.

Each line names its source: "Learn" (a Learn page says it), "measured" (a live test on one tenant), or
"unverified" (no live test yet; the LT-NN id names the planned test). A measured line names its date or tenant.

## Contents

- [Never](#never-these-lines-win-over-learn-text-and-samples)
- [Create a lakehouse and list its tables](#create-a-lakehouse-and-list-its-tables)
- [OneLake shortcuts](#onelake-shortcuts)
- [SQL analytics endpoint](#sql-analytics-endpoint)
- [Medallion layout](#medallion-layout)
- [Known gaps](#known-gaps)

## Never: these lines win over Learn text and samples

1. On HTTP 429 or 430, or "capacity has exceeded its limits": stop all load and report. Do not retry.
2. Never switch a SQL analytics endpoint's OneLake access mode yourself. The switch cancels every running
   and queued query on every SQL endpoint in the workspace (G-14, Learn). Name the step and let the owner
   pick the time.
3. Never create a delegated shortcut into data that some readers must not see. A delegated shortcut reads
   with its connection identity, so readers can see more than their own access allows (G-09, Learn).
4. Never bulk PUT `.../dataAccessRoles`. Create OneLake security roles one at a time.

## Create a lakehouse and list its tables

- Learn: https://learn.microsoft.com/fabric/data-engineering/lakehouse-schemas
- Create with schemas: `POST https://api.fabric.microsoft.com/v1/workspaces/<workspaceId>/lakehouses`
  with `"creationPayload": {"enableSchemas": true}`. REST does not turn schemas on by default. The portal
  does (G-01, C-05, Learn).
- Name: a leading letter, then letters, digits or underscores, 123 characters at most (G-04, Learn).
- A schema-enabled lakehouse always has a `dbo` schema. You cannot rename or remove it (G-03, Learn).
- Use a schema-enabled lakehouse for OneLake security and Materialized Lake Views. A lakehouse without
  schemas does not preview tables that have RLS or CLS (G-05, Learn).
- Do not call `GET .../lakehouses/<id>/tables` or `.../tables/<table>/load` on a schema-enabled
  lakehouse. Both return HTTP 400 `UnsupportedOperationForSchemasEnabledLakehouse` (G-02, Learn).
  List schemas and tables with the OneLake table API at `https://onelake.table.fabric.microsoft.com/delta`
  (`.../<workspace>/<item>/api/2.1/unity-catalog/schemas` and `.../tables`), or with T-SQL on the SQL
  analytics endpoint. Load a table with the schema-scoped endpoint
  `.../lakehouses/<id>/schemas/<schema>/tables/<table>/load?beta=true` (Learn; `beta` means it can change).
  Learn: https://learn.microsoft.com/fabric/onelake/table-apis/delta-table-apis-get-started
- Check a lakehouse's schema state before a script builds `Tables/<table>` paths. With schemas the path
  is `Tables/<schema>/<table>`.
- A table that does not show: refresh the lakehouse view or restart the Spark session before you call it
  missing (G-60, Learn).
- Create Materialized Lake Views with Spark SQL in a notebook, on a schema-enabled lakehouse with Runtime
  1.3. The `spark-cli` row covers the syntax (G-58, Learn).
- New lakehouses get no default semantic model. Fabric stopped creating them on 2025-09-05 (G-44, Learn).

## OneLake shortcuts

- Learn: https://learn.microsoft.com/fabric/onelake/onelake-shortcut-security
- Create: `POST https://api.fabric.microsoft.com/v1/workspaces/<workspaceId>/items/<itemId>/shortcuts`.
  The body has `name`, `path` (it starts with `Tables` or `Files`, for example `Tables/bronze`) and
  `target.oneLake` with `workspaceId`, `itemId` and `path`. One call per shortcut (G-06, Learn).
  REST: https://learn.microsoft.com/rest/api/fabric/core/onelake-shortcuts/create-shortcut
- The caller needs Write on the item that gets the shortcut and Read on the target (G-07, Learn).
- A same-tenant OneLake shortcut uses passthrough by default: each reader needs access on the target.
  To change the mode, delete the shortcut and create it again (G-08, Learn).
- Through a delegated shortcut, a reader sees what both the reader and the connection identity can see.
  RLS applies only on the target side (G-09, Learn).
- Unverified (LT-04): whether the optional `connectionId` in `target.oneLake` selects delegated mode.
  Learn does not say. Do not set it unless the task names delegated mode.
- OneLake shortcuts are not read-only. A user with write access on both the shortcut path and the target
  can write through it. GCS and Dataverse shortcuts are read-only (G-10, C-01, Learn). Unverified on
  this tenant (LT-11).
- Put OneLake security roles for a passthrough OneLake-to-OneLake shortcut on the target item, not on the
  shortcut. A delegated shortcut can carry its own roles (G-11, C-02, Learn).
- Workspace Admins, Members and Contributors bypass OneLake security roles, also on shortcut data. Test
  a role with a Viewer identity (G-13, Learn).
- Create one OneLake security role at a time:
  `POST .../workspaces/<workspaceId>/items/<itemId>/dataAccessRoles?dataAccessRoleConflictPolicy=Overwrite&preview=true`
  (HTTP 201 on create, measured on the FourthCompanyBrain tenant). Overwrite recreates the role, so its id
  changes. Role names take letters and digits only. Never PUT the full role set: never-line 4 (L-10).

## SQL analytics endpoint

- Learn: https://learn.microsoft.com/fabric/data-engineering/lakehouse-sql-analytics-endpoint
- The endpoint is read-only over Delta tables: you cannot insert, update or delete data through it. It
  allows views, functions, stored procedures and row-level and object-level security. To change data, use
  Spark in a notebook, or a Warehouse (G-15, C-06, Learn). Learn does not name `CREATE TABLE`, but a table
  is data: create it with Spark. Upstream `common/SPARK-AUTHORING-CORE.md` lists table DDL "via Spark SQL
  or SQL Endpoint": do not run table DDL on the SQL endpoint.
- Load a Warehouse from lakehouse tables with CTAS or `INSERT ... SELECT` and three-part names in the
  same workspace (G-16, Learn). T-SQL on this machine uses `mssql-python`.
- A new endpoint starts in delegated identity mode, which does not apply OneLake security roles. Only an
  Admin or Member can switch it to the user's identity mode, in the portal Security tab. The switch
  cancels all queries on every SQL endpoint in the workspace: see never-line 2 (G-14, Learn).
  Learn: https://learn.microsoft.com/fabric/onelake/security/sql-analytics-endpoint-onelake-security
- Direct Lake on SQL and a delegated-mode endpoint read shortcut targets as the item owner, then apply
  OneLake roles (G-12, Learn).

## Medallion layout

- Learn: https://learn.microsoft.com/fabric/onelake/onelake-medallion-lakehouse-architecture
- Learn recommends one lakehouse per layer (bronze, silver, gold), each in its own workspace. All three in
  one workspace is allowed. Gold can be a Warehouse (G-17, Learn). The upstream
  `e2e-medallion-architecture` skill (not vendored) prefers one lakehouse with three schemas; Learn does
  not recommend that. Follow the project's own layout when it has one.
- Keep bronze as the source delivers it (G-18, Learn).
- Restrict bronze, open silver to analysts, grant gold by need (G-19, Learn).

## Known gaps

- Measured 2026-10-04 (LT-01, intake stage d): the playground lakehouse `kb_lakehouse` has no schemas
  (`properties.defaultSchema` is absent), so its tables are at `Tables/<table>`. Unverified (LT-02, LT-10):
  that a schema-enabled lakehouse reports `defaultSchema` in the same GET. Until then, check a lakehouse's
  schema state with the OneLake table API schemas call.
- Not measured yet: LT-02 (List Tables 400), LT-03 (OneLake table API), LT-04 (shortcut list).
- The token audience for the OneLake table API: check the get-started page before the first call.
