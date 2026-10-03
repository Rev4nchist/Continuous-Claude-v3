---
name: fabric
description: Routes Microsoft Fabric work (Spark notebooks, Livy sessions, Materialized Lake Views, failed Spark runs, finding items across workspaces) to vendored Microsoft skills. Use when a task touches Fabric, OneLake, a lakehouse or a Fabric notebook. Not for KQL (kusto-cli).
---

# Fabric hub

Microsoft's `skills-for-fabric` v0.3.18 is vendored at `../_vendor/skills-for-fabric/` (see its
`PROVENANCE.md`). Claude Code does not list skills under a `_` folder. This page routes to them.

## Never: these lines win over any vendored text

1. On any HTTP 429 or 430, or "capacity has exceeded its limits": stop all load and report. Do not retry,
   even when `Retry-After` is set. This overrides `common/COMMON-CORE.md`. `Retry-After` on a 202 is only
   a poll interval. A 503 or 504 on a status poll may retry once; then stop and report. Cap every poll
   loop: `fabric_lro` in `common/COMMON-CLI.md` loops forever on a status it does not know.
2. Never pause, resume or resize a capacity. Do not recommend one either; the owner decides. Never bulk PUT
   `.../dataAccessRoles`: create roles one at a time.
3. Run the preflight the project's CLAUDE.md names before the first live call. One Fabric job at a time on
   an F2. Before a POST that starts a job, read the job history. Never resubmit a job POST whose outcome
   you do not know: find the job instance first.
4. Pin every pip install: `pkg==x.y` in a project venv on this machine, `%pip install pkg==x.y` in a
   notebook. Use `python`, never `python3`. T-SQL on this machine uses `mssql-python`, not ODBC Driver 18.
5. Vendored shell snippets are bash. Run them with the Bash tool (Git Bash). From PowerShell, `bash` is WSL:
   never use it. Tokens stay in memory; never print one.

## Route

| Task | Read this first |
|---|---|
| Notebook cell code (PySpark, `%%sql`, `%%configure`, notebookutils), notebook runs, Livy sessions, failed or slow Spark runs, Materialized Lake Views | [spark-cli](../_vendor/skills-for-fabric/skills/spark-cli/SKILL.md) |
| Find an item when the workspace is unknown, or list one item type across all workspaces | [search-consumption-cli](../_vendor/skills-for-fabric/skills/search-consumption-cli/SKILL.md) |

Not vendored yet: Warehouse T-SQL (`sqldw-cli`), Eventhouse KQL authoring (`eventhouse-cli`), the Fabric
data agent, AI Functions. Say so, then use the Microsoft Learn docs (microsoft-docs plugin) and the API
facts in the `fabric-playbook` rule. A vendored skill that routes to one of these: stop at that boundary.

Other owners: Kusto.Cli queries and CSV export go to `kusto-cli`. SQL outside Fabric and schema design go
to `databases`.

## Known upstream defects (v0.3.18): do this instead

- `fabric_lro` (`common/COMMON-CLI.md`) returns 0 on any non-202 response, a 429 too, and never times out.
  Check the HTTP status and cap the polls. It waits for `Succeeded`, but a job instance ends `Completed`:
  poll a notebook job's instance URL yourself (its example call also passes 2 of 3 arguments).
- `fetch_all_pages` (`common/COMMON-CLI.md`) hides a failed page. Check each `az rest` exit code.
- Catalog Search: on the next page send only `{"continuationToken": "<token>"}`. With `search` or `filter`
  it fails `ConflictingFilterParameters`. Show every match; never take `value[0]` blindly. `Type eq
  'Workspace'` finds a workspace.
- Notebook content: `POST .../items/<id>/updateDefinition`, not `PATCH .../definition`
  (`common/SPARK-AUTHORING-CORE.md`). A notebook runs through the Jobs API (`jobType=RunNotebook`), never
  through a Livy session.

## How to use a vendored skill

1. Pick one row. Read that SKILL.md in full, then the one `references/<mode>.md` its mode table names.
2. Its links (`../../common/*.md`) resolve inside `../_vendor/skills-for-fabric/`.
3. Read-only calls may run after the preflight. A call that starts a job or changes an item runs only when
   the task asks for it. Report the job instance id.
4. Keep the `x-ms-fabric-skill: <vendored skill name>` header the vendored skill asks for. Dave chose to
   keep it.
5. The reviewed conflicts between vendored text and CCv3 rules are in
   `../_vendor/skills-for-fabric/overlay.json`. A new conflict: follow this page and tell Dave.
